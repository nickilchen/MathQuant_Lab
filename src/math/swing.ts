/**
 * 波段交易分析（持仓 3~20 个交易日）。
 *
 * 和「动量策略」不同：动量算的是「过去涨得好不好、该拿多少仓位」，
 * 这里算的是「现在这个位置能不能进、进去以后在哪止损、目标在哪」。
 *
 * 只做四种形态，每种都给明确计划，不给模棱两可的「关注」：
 *   上升趋势回调  —— 趋势向上，价格回到 MA20 附近，缩量
 *   箱体突破      —— 收盘站上 20 日高点，放量
 *   区间震荡      —— ADX 低，价格在箱体里，只做区间不给追多
 *   下跌中继      —— MA20 < MA60，反弹到均线受阻，不做
 *
 * 所有价格都基于 ATR 与结构位（前低/前高/箱体高度），不用百分比拍脑袋。
 */
import type { Bar } from '../data/types';
import { adx, atr, rsi, sma } from './indicators';

export interface SwingConfig {
  /** 最长持有交易日 */
  maxHoldDays: number;
  /** 止损 = 入场 − ATR × 倍数 */
  atrStop: number;
  /** 目标风险回报比 */
  rr: number;
  /** 单笔风险占本金比例（%） */
  riskPct: number;
  /** 本金 */
  capital: number;
}

export const DEFAULT_SWING_CONFIG: SwingConfig = {
  maxHoldDays: 20,
  atrStop: 1.5,
  rr: 2,
  riskPct: 1,
  capital: 100000
};

export type SwingSetup = '上升趋势回调' | '箱体突破' | '突破延伸' | '区间震荡' | '下跌中继';
export type SwingVerdict = '可做多' | '等回踩' | '观望' | '不做';

export interface SwingPlan {
  direction: 'long';
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number | null;
  riskPerShare: number;
  riskAmount: number;
  shares: number;
  rr: number;
  holdLow: number;
  holdHigh: number;
}

export interface SwingFact {
  label: string;
  value: string;
  tone: 'up' | 'down' | 'flat';
}

export interface SwingAnalysis {
  setup: SwingSetup;
  verdict: SwingVerdict;
  /** 0~100 */
  score: number;
  note: string;
  plan: SwingPlan | null;
  facts: SwingFact[];
  lines: string[];
  ma20: (number | null)[];
  ma60: (number | null)[];
  /** 图上要画的水平线 */
  levels: { entryLow: number; entryHigh: number; stop: number; target: number } | null;
  /** 当前价与关键位 */
  close: number;
  atrPct: number;
  rsi: number;
  adx: number;
  volRatio: number;
  devMa20: number;
}

const avg = (a: number[]): number => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const r2 = (v: number): number => Math.round(v * 100) / 100;
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** NaN → null，供图表使用 */
const series = (a: number[]): (number | null)[] => a.map((v) => (Number.isFinite(v) ? r2(v) : null));

export function analyzeSwing(bars: Bar[], cfg: SwingConfig = DEFAULT_SWING_CONFIG, lot = 100): SwingAnalysis | null {
  if (bars.length < 80) return null;

  const closes = bars.map((b) => b.close);
  const ma20s = sma(closes, 20);
  const ma60s = sma(closes, 60);
  const atrs = atr(bars, 14);
  const adxs = adx(bars, 14);
  const rsis = rsi(closes, 14);

  const i = bars.length - 1;
  const today = bars[i];
  const close = today.close;
  const ma20 = ma20s[i];
  const ma60 = ma60s[i];
  const atrV = atrs[i];
  const adxV = adxs[i];
  const rsiV = rsis[i];
  if (![close, ma20, ma60, atrV, adxV, rsiV].every((v) => Number.isFinite(v)) || close <= 0) return null;

  const prev20 = bars.slice(-21, -1);
  const hi20 = Math.max(...prev20.map((b) => b.high));
  const lo20 = Math.min(...prev20.map((b) => b.low));
  const volRatio = avg(bars.slice(-5).map((b) => b.volume)) / Math.max(avg(bars.slice(-20).map((b) => b.volume)), 1);
  const devMa20 = ((close - ma20) / ma20) * 100;
  const atrPct = (atrV / close) * 100;

  const upTrend = close > ma20 && ma20 > ma60;
  const downTrend = close < ma20 && ma20 < ma60;
  const strongTrend = adxV >= 22;

  /* ---------- 形态 ---------- */
  let setup: SwingSetup;
  // 只有「刚站上 20 日高点 6% 以内」才算突破。
  // 已经涨离突破位 12% 还叫突破，会把入场价设在 20 日高点——那价格永远等不到。
  if (upTrend && close >= hi20 * 0.995 && close <= hi20 * 1.06) setup = '箱体突破';
  else if (upTrend && close > hi20 * 1.06) setup = '突破延伸';
  else if (upTrend && devMa20 >= -3.5 && devMa20 <= 5) setup = '上升趋势回调';
  else if (downTrend) setup = '下跌中继';
  else setup = '区间震荡';

  /* ---------- 评分 ---------- */
  let score = 50;
  if (upTrend) score += 12;
  if (strongTrend) score += 8;
  if (downTrend) score -= 20;

  if (setup === '区间震荡') score -= 12;
  if (setup === '箱体突破') score += volRatio >= 1.3 ? 12 : -4;
  if (setup === '突破延伸') score -= 4;
  if (setup === '上升趋势回调') score += volRatio <= 1.05 ? 10 : -2;
  // 回调过深就不是回调，是趋势破坏
  if (setup === '上升趋势回调' && devMa20 < -3) score -= 5;
  // 离 MA20 超过 5% 还叫「回调」就有点自欺欺人了，扣分提示追高
  if (setup === '上升趋势回调' && devMa20 > 5) score -= 6;

  if (rsiV >= 45 && rsiV <= 65) score += 8;
  if (rsiV > 75) score -= 8;
  if (rsiV < 30) score += 5;

  if (atrPct >= 1.5 && atrPct <= 5) score += 5;
  if (atrPct > 7) score -= 8;

  // 离 MA20 太远，追高风险大
  if (devMa20 > 8) score -= 6;

  score = clamp(Math.round(score), 0, 100);

  /* ---------- 判定 ---------- */
  let verdict: SwingVerdict;
  if (setup === '下跌中继') verdict = '不做';
  else if (setup === '区间震荡') verdict = '观望';
  else if (setup === '突破延伸') verdict = score >= 55 ? '等回踩' : '观望';
  else if (score >= 65) verdict = '可做多';
  else if (score >= 55) verdict = '等回踩';
  else verdict = '观望';

  /* ---------- 计划 ---------- */
  let plan: SwingPlan | null = null;
  if (verdict === '可做多' || verdict === '等回踩') {
    const isBreakout = setup === '箱体突破';
    // 突破：入场在突破位上方 0~1%；
    // 回调 / 突破延伸：都在 MA20 上下分批（延伸已经涨远，只能等回踩均线）
    const entryLow = isBreakout ? r2(hi20 * 0.995) : r2(Math.max(lo20, ma20 - atrV * 0.5));
    const entryHigh = isBreakout ? r2(hi20 * 1.01) : r2(ma20 + atrV * 0.3);
    const stopRaw = isBreakout
      ? entryLow - atrV * cfg.atrStop
      : Math.min(lo20, ma20 - atrV * cfg.atrStop);
    const stop = r2(Math.min(stopRaw, entryLow * 0.985));
    const riskPerShare = r2(Math.max(entryHigh - stop, 0.01));
    const target1 = r2(entryHigh + riskPerShare * cfg.rr);
    // 第二目标：突破看箱体高度，回调看前高
    const target2Raw = isBreakout ? entryHigh + (hi20 - lo20) : setup === '突破延伸' ? entryHigh + atrV * 4 : hi20;
    const target2 = target2Raw > target1 ? r2(target2Raw) : null;

    const riskAmount = r2(cfg.capital * (cfg.riskPct / 100));
    const rawShares = Math.floor(riskAmount / riskPerShare / lot) * lot;

    plan = {
      direction: 'long',
      entryLow,
      entryHigh,
      stop,
      target1,
      target2,
      riskPerShare,
      riskAmount,
      shares: Math.max(0, rawShares),
      rr: r2((target1 - entryHigh) / riskPerShare),
      holdLow: isBreakout ? 3 : 5,
      holdHigh: cfg.maxHoldDays
    };
  }

  /* ---------- 读数 ---------- */
  const posInRange = hi20 > lo20 ? ((close - lo20) / (hi20 - lo20)) * 100 : 50;
  const facts: SwingFact[] = [
    {
      label: '均线排列',
      value: upTrend ? 'MA20 > MA60（多头）' : downTrend ? 'MA20 < MA60（空头）' : '均线纠缠',
      tone: upTrend ? 'up' : downTrend ? 'down' : 'flat'
    },
    { label: 'ADX(14)', value: `${adxV.toFixed(1)}（${strongTrend ? '趋势成立' : '趋势弱'}）`, tone: strongTrend ? 'up' : 'flat' },
    { label: 'RSI(14)', value: `${rsiV.toFixed(1)}`, tone: rsiV > 70 ? 'down' : rsiV < 30 ? 'up' : 'flat' },
    { label: 'ATR 占价', value: `${atrPct.toFixed(2)}%`, tone: atrPct > 6 ? 'down' : 'flat' },
    { label: '量比（5/20 日）', value: `${volRatio.toFixed(2)}`, tone: volRatio >= 1.3 ? 'up' : 'flat' },
    {
      label: '20 日区间位置',
      value: posInRange > 100 ? '突破上沿' : posInRange < 0 ? '跌破下沿' : `${posInRange.toFixed(0)}%`,
      tone: posInRange > 80 ? 'down' : posInRange < 20 ? 'up' : 'flat'
    },
    { label: '偏离 MA20', value: `${devMa20 >= 0 ? '+' : ''}${devMa20.toFixed(2)}%`, tone: devMa20 > 8 ? 'down' : devMa20 < -8 ? 'up' : 'flat' }
  ];

  /* ---------- 结论文字 ---------- */
  const lines: string[] = [];
  lines.push(
    `形态判定：${setup}。收盘 ${close.toFixed(2)}，MA20 ${ma20.toFixed(2)}、MA60 ${ma60.toFixed(2)}，` +
      `偏离 MA20 ${devMa20 >= 0 ? '+' : ''}${devMa20.toFixed(2)}%，ADX ${adxV.toFixed(1)}。`
  );
  lines.push(
    `评分 ${score}/100：趋势${upTrend ? '向上' : downTrend ? '向下' : '横向'}（${strongTrend ? 'ADX 确认' : 'ADX 不足'}）、` +
      `量比 ${volRatio.toFixed(2)}、RSI ${rsiV.toFixed(1)}、ATR 占价 ${atrPct.toFixed(2)}%。`
  );
  if (plan) {
    lines.push(
      `计划：${setup === '箱体突破' ? '突破回踩' : '回踩均线'} ${plan.entryLow.toFixed(2)}~${plan.entryHigh.toFixed(2)} 分批买，` +
        `止损 ${plan.stop.toFixed(2)}（${(((plan.stop - plan.entryHigh) / plan.entryHigh) * 100).toFixed(2)}%），` +
        `目标 ${plan.target1.toFixed(2)}${plan.target2 ? ` / ${plan.target2.toFixed(2)}` : ''}，` +
        `风险回报 ${plan.rr.toFixed(1)}，持有 ${plan.holdLow}~${plan.holdHigh} 个交易日。`
    );
    lines.push(
      `仓位：单笔风险预算 ${plan.riskAmount.toFixed(0)}（本金 ${cfg.capital.toFixed(0)} × ${cfg.riskPct}%），` +
        `每股风险 ${plan.riskPerShare.toFixed(2)} → 理论 ${Math.floor(plan.riskAmount / plan.riskPerShare)} 股，` +
        (plan.shares > 0
          ? `按每手 ${lot} 股取整为 ${plan.shares} 股。`
          : `不足一手（${lot} 股），要么提高风险预算，要么换价格更低的标的。`)
    );
  } else if (setup === '下跌中继') {
    lines.push('空头排列里做多等于接飞刀，这个形态不给做多计划。要等 MA20 走平、价格站回 MA20 上方再重新评估。');
  } else if (setup === '突破延伸') {
    lines.push(`价格已站上 20 日高点 ${(((close - hi20) / hi20) * 100).toFixed(1)}%，属于突破后的延伸段：趋势没坏，但追高不划算，等回踩 MA20 再看。`);
  } else {
    lines.push('区间震荡不给追多计划：要么等突破放量，要么在箱体下沿做低吸、上沿减仓，中间位置不动。');
  }

  return {
    setup,
    verdict,
    score,
    note:
      setup === '下跌中继'
        ? '均线空头排列，反弹到均线容易再被砸'
        : setup === '突破延伸'
          ? `已涨离 20 日高点 ${(((close - hi20) / hi20) * 100).toFixed(1)}%，等回踩 MA20，不追高`
          : setup === '区间震荡'
          ? 'ADX 偏低、价格在箱体中间，方向不明'
          : verdict === '可做多'
            ? `${setup}成立，风险回报 ${plan?.rr.toFixed(1) ?? '—'}`
            : `${setup}但评分不够，等更好的位置`,
    plan,
    facts,
    lines,
    ma20: series(ma20s),
    ma60: series(ma60s),
    levels: plan
      ? { entryLow: plan.entryLow, entryHigh: plan.entryHigh, stop: plan.stop, target: plan.target1 }
      : null,
    close,
    atrPct,
    rsi: rsiV,
    adx: adxV,
    volRatio,
    devMa20
  };
}
