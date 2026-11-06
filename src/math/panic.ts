/**
 * 恐慌性大跌抄底（短线 1~5 个交易日）。
 *
 * 不是「跌了就买」，而是先给恐慌程度打分，再用**这只股票自己的历史**回答：
 * 过去同样跌幅、同样放量的日子，后面 1/3/5 天到底涨还是跌、胜率多少、最差多少。
 * 样本不足就明说，不拿「大概率反弹」糊弄。
 *
 * 评分维度（满分 100）：
 *   跌幅 50 + 放量 25 + 超卖 15 + 偏离均线 10 + 长下影/连跌 10（上限 100）
 *
 * 各市场制度差异由调用方传入 entryDelay：
 *   A 股 T+1 → 只能次日买，统计也按次日开盘算；
 *   港/美/日/韩 T+0 → 当日收盘即可，entryDelay = 0。
 */
import type { Bar } from '../data/types';
import { atr, bollinger, rsi, sma } from './indicators';

export interface PanicConfig {
  /** 触发恐慌的单日跌幅（正数，3 表示 -3%） */
  dropPct: number;
  /** 放量倍数（当日量 / 过去 20 日均量） */
  volumeRatio: number;
  /** 统计后续几个交易日 */
  horizons: number[];
  /** 0 = 当日收盘买，1 = 次日买（A 股 T+1） */
  entryDelay: number;
  riskPct: number;
  capital: number;
}

export const DEFAULT_PANIC_CONFIG: PanicConfig = {
  dropPct: 3,
  volumeRatio: 1.5,
  horizons: [1, 3, 5],
  entryDelay: 0,
  riskPct: 1,
  capital: 100000
};

export type PanicLevel = '极度恐慌' | '恐慌' | '偏弱' | '正常';

export interface PanicStat {
  horizon: number;
  samples: number;
  /** 上涨概率（%） */
  winRate: number;
  /** 平均收益（%） */
  avg: number;
  median: number;
  worst: number;
  best: number;
}

export interface PanicPlan {
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number | null;
  riskPerShare: number;
  riskAmount: number;
  shares: number;
  holdLow: number;
  holdHigh: number;
  entryDelay: number;
}

export interface PanicFact {
  label: string;
  value: string;
  tone: 'up' | 'down' | 'flat';
}

export interface PanicAnalysis {
  score: number;
  level: PanicLevel;
  triggered: boolean;
  /** 当日跌幅（正数，5.2 表示 -5.2%） */
  drop: number;
  volRatio: number;
  rsi: number;
  devMa20: number;
  shadow: number;
  downDays: number;
  belowLower: boolean;
  stats: PanicStat[];
  plan: PanicPlan | null;
  facts: PanicFact[];
  lines: string[];
  close: number;
}

const avg = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;

/**
 * 历史同类恐慌日的后续收益。
 *
 * 只统计「跌幅达到阈值」的日子，不要求放量——放量与否留给评分，
 * 否则样本会太少，统计出来的胜率没有意义。
 */
export function panicStats(
  bars: Bar[],
  dropPct: number,
  horizons: number[],
  entryDelay = 0
): PanicStat[] {
  const hs = horizons.filter((h) => h > 0);
  if (!hs.length) return [];
  const buckets: number[][] = hs.map(() => []);

  for (let i = 1; i < bars.length; i++) {
    const ret = (bars[i].close / bars[i - 1].close - 1) * 100;
    if (ret > -dropPct) continue;
    const entryIdx = i + entryDelay;
    if (entryIdx >= bars.length) continue;
    hs.forEach((h, k) => {
      const exitIdx = entryIdx + h;
      if (exitIdx >= bars.length || exitIdx > bars.length - 1) return;
      const fwd = (bars[exitIdx].close / bars[entryIdx].close - 1) * 100;
      if (Number.isFinite(fwd)) buckets[k].push(fwd);
    });
  }

  return hs.map((h, k) => {
    const a = buckets[k];
    if (!a.length) return { horizon: h, samples: 0, winRate: 0, avg: 0, median: 0, worst: 0, best: 0 };
    const sorted = [...a].sort((x, y) => x - y);
    return {
      horizon: h,
      samples: a.length,
      winRate: (a.filter((v) => v > 0).length / a.length) * 100,
      avg: a.reduce((s, v) => s + v, 0) / a.length,
      median: sorted[Math.floor(sorted.length / 2)],
      worst: sorted[0],
      best: sorted[sorted.length - 1]
    };
  });
}

export function analyzePanic(
  bars: Bar[],
  cfg: PanicConfig = DEFAULT_PANIC_CONFIG,
  lot = 100
): PanicAnalysis | null {
  if (bars.length < 60) return null;

  const i = bars.length - 1;
  const today = bars[i];
  const prev = bars[i - 1];
  if (!(prev?.close > 0) || !(today.close > 0)) return null;

  const ret = (today.close / prev.close - 1) * 100;
  const drop = Math.max(0, -ret);

  const closes = bars.map((b) => b.close);
  const atrs = atr(bars, 14);
  const rsis = rsi(closes, 14);
  const ma20s = sma(closes, 20);
  const ma5s = sma(closes, 5);
  const boll = bollinger(closes, 20, 2);

  const atrV = atrs[i];
  const rsiV = rsis[i];
  const ma20 = ma20s[i];
  const ma5 = ma5s[i];
  const lower = boll.low[i];
  if (![atrV, rsiV, ma20].every((v) => Number.isFinite(v))) return null;

  const baseVol = avg(bars.slice(-21, -1).map((b) => b.volume));
  const volRatio = baseVol > 0 ? today.volume / baseVol : 1;
  const devMa20 = ((today.close - ma20) / ma20) * 100;
  const range = today.high - today.low;
  const shadow = range > 0 ? (Math.min(today.open, today.close) - today.low) / range : 0;
  const belowLower = Number.isFinite(lower) && today.close <= lower;

  let downDays = 0;
  for (let k = i; k > 0; k--) {
    if (bars[k].close < bars[k - 1].close) downDays++;
    else break;
  }

  /* ---------- 评分 ---------- */
  let score = 0;
  if (drop >= 3) score += 20;
  if (drop >= 5) score += 10;
  if (drop >= 7) score += 10;
  if (drop >= 9) score += 10;

  if (volRatio >= cfg.volumeRatio) score += 15;
  if (volRatio >= 2.5) score += 10;
  if (volRatio >= 4) score += 5;

  if (rsiV < 35) score += 10;
  if (rsiV < 28) score += 5;

  if (devMa20 <= -6) score += 6;
  if (devMa20 <= -10) score += 4;

  if (shadow >= 0.5) score += 6;
  if (downDays >= 3) score += 4;

  score = Math.min(100, score);

  const level: PanicLevel = score >= 80 ? '极度恐慌' : score >= 60 ? '恐慌' : score >= 40 ? '偏弱' : '正常';
  const triggered = drop >= cfg.dropPct && score >= 55;

  /* ---------- 历史统计 ---------- */
  const stats = panicStats(bars, cfg.dropPct, cfg.horizons, cfg.entryDelay);

  /* ---------- 计划 ---------- */
  let plan: PanicPlan | null = null;
  if (triggered) {
    const entryLow = r2(today.close * 0.995);
    const entryHigh = r2(today.close * 1.01);
    const stop = r2(Math.min(today.low, today.close - atrV * 0.8));
    const riskPerShare = r2(Math.max(entryHigh - stop, 0.01));

    // 反弹目标：先看 5 日线，再看回补当日跌幅的一半
    const halfBack = today.close + (prev.close - today.close) * 0.5;
    const target1 = r2(Math.max(ma5, halfBack, entryHigh + riskPerShare));
    // 第二目标和第一目标差不到 2% 就没有区分意义，直接不显示
    const target2 = prev.close > target1 * 1.02 ? r2(prev.close) : null;

    const riskAmount = r2(cfg.capital * (cfg.riskPct / 100));
    const shares = Math.max(0, Math.floor(riskAmount / riskPerShare / lot) * lot);

    plan = {
      entryLow,
      entryHigh,
      stop,
      target1,
      target2,
      riskPerShare,
      riskAmount,
      shares,
      holdLow: 1,
      holdHigh: Math.max(...cfg.horizons),
      entryDelay: cfg.entryDelay
    };
  }

  /* ---------- 读数 ---------- */
  const facts: PanicFact[] = [
    { label: '当日涨跌幅', value: `${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%`, tone: ret >= 0 ? 'up' : 'down' },
    { label: '量比（对 20 日）', value: `${volRatio.toFixed(2)}`, tone: volRatio >= cfg.volumeRatio ? 'up' : 'flat' },
    { label: 'RSI(14)', value: `${rsiV.toFixed(1)}`, tone: rsiV < 30 ? 'up' : 'flat' },
    { label: '偏离 MA20', value: `${devMa20 >= 0 ? '+' : ''}${devMa20.toFixed(2)}%`, tone: devMa20 < -8 ? 'up' : 'flat' },
    { label: '下影线占振幅', value: `${(shadow * 100).toFixed(0)}%`, tone: shadow >= 0.5 ? 'up' : 'flat' },
    { label: '连续下跌', value: `${downDays} 天`, tone: downDays >= 3 ? 'up' : 'flat' },
    { label: '布林下轨', value: belowLower ? '已跌破' : '未跌破', tone: belowLower ? 'up' : 'flat' }
  ];

  /* ---------- 结论 ---------- */
  const lines: string[] = [];
  lines.push(
    `今日 ${ret >= 0 ? '+' : ''}${ret.toFixed(2)}%（跌 ${drop.toFixed(2)}%），量比 ${volRatio.toFixed(2)}，` +
      `RSI ${rsiV.toFixed(1)}，偏离 MA20 ${devMa20.toFixed(2)}%，${belowLower ? '已跌破' : '未跌破'}布林下轨，` +
      `恐慌评分 ${score}（${level}）。`
  );

  if (stats.some((s) => s.samples > 0)) {
    const parts = stats.map(
      (s) =>
        `${s.horizon} 日：胜率 ${s.winRate.toFixed(0)}%、均值 ${s.avg >= 0 ? '+' : ''}${s.avg.toFixed(2)}%、` +
        `最差 ${s.worst.toFixed(2)}%（${s.samples} 个样本）`
    );
    lines.push(
      `历史同类：过去 ${bars.length} 根 K 线里，单日跌幅 ≥ ${cfg.dropPct}% 的日子，` +
        (cfg.entryDelay ? '按次日买入计算' : '按当日收盘买入计算') +
        `，后续 ${parts.join('；')}。`
    );
  } else {
    lines.push(`历史同类：这段 K 线里没有「单日跌幅 ≥ ${cfg.dropPct}%」的样本，无法给出胜率，别把「跌多了」当成理由。`);
  }

  if (plan) {
    lines.push(
      `计划：${plan.entryDelay ? '次日开盘' : '当日收盘'} ${plan.entryLow.toFixed(2)}~${plan.entryHigh.toFixed(2)} 分批，` +
        `止损 ${plan.stop.toFixed(2)}（${(((plan.stop - plan.entryHigh) / plan.entryHigh) * 100).toFixed(2)}%），` +
        `目标 ${plan.target1.toFixed(2)}${plan.target2 ? ` / ${plan.target2.toFixed(2)}` : ''}，持有 ${plan.holdLow}~${plan.holdHigh} 个交易日。`
    );
    lines.push(
      `仓位：风险预算 ${plan.riskAmount.toFixed(0)} ÷ 每股风险 ${plan.riskPerShare.toFixed(2)} → ` +
        (plan.shares > 0 ? `按每手 ${lot} 股取整为 ${plan.shares} 股。` : `不足一手（${lot} 股），这单做不了。`)
    );
  } else {
    lines.push(
      drop >= cfg.dropPct
        ? '跌幅到了，但恐慌评分不够（放量/超卖/偏离度不足），不构成「恐慌性」大跌，不触发抄底。'
        : `今日跌幅没到 ${cfg.dropPct}% 的门槛，不触发抄底。`
    );
  }

  return {
    score,
    level,
    triggered,
    drop,
    volRatio,
    rsi: rsiV,
    devMa20,
    shadow,
    downDays,
    belowLower,
    stats,
    plan,
    facts,
    lines,
    close: today.close
  };
}
