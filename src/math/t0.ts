/**
 * 做 T（日内回转）分析（纯函数）
 *
 * A 股是 T+1，当天买入的不能当天卖。所谓「做 T」是用**已有底仓**做回转：
 *  - 正 T（先买后卖）：低位加 X 股 → 高位卖掉 X 股老仓，收盘仓位不变，赚差价；
 *  - 倒 T（先卖后买）：高位卖 X 股老仓 → 低位买回 X 股，收盘仓位不变，赚差价。
 * 两个方向都要求底仓 ≥ X，否则就是违规或真的减仓了。
 *
 * 这一层回答四个问题：
 *   1. **今天有没有空间**：日内已走出的振幅 vs 近 20 日平均振幅，还剩多少可赚；
 *   2. **够不够成本**：佣金（双边、有最低 5 元）+ 印花税 + 过户费，算出盈亏平衡价差；
 *   3. **做哪个方向**：现价相对分时均价（VWAP）偏离多少，偏高做倒 T、偏低做正 T；
 *   4. **具体怎么做**：两腿的价格区间、股数、预计净收益。
 *
 * 诚实边界：日 K 不含日内路径，我们**无法回测**「先高后低还是先低后高」，
 * 所以用分时均价 + 已实现振幅做「当下决策」，不假装能算出历史胜率。
 */
import type { Bar } from '../data/types';
import type { IntradaySnapshot } from '../data/intraday';

export interface T0Config {
  /** 底仓股数 */
  baseShares: number;
  /** 做 T 比例（0~1），实际股数向下取整到 100 股 */
  tRatio: number;
  /** 佣金费率，如 0.00025 */
  commission: number;
  /** 单笔最低佣金（元） */
  minCommission: number;
  /** 印花税（仅卖出） */
  stampTax: number;
  /** 过户费（双边） */
  transferFee: number;
}

export const DEFAULT_T0_CONFIG: T0Config = {
  baseShares: 1000,
  tRatio: 0.3,
  commission: 0.00025,
  minCommission: 5,
  stampTax: 0.0005,
  transferFee: 0.00001
};

export type T0Verdict = '正T' | '倒T' | '观望' | '不适合';

export interface T0Plan {
  direction: '正T' | '倒T';
  /** 第一腿说明 */
  firstLabel: string;
  /** 第一腿价格区间 */
  first: [number, number];
  /** 第二腿说明 */
  secondLabel: string;
  second: [number, number];
  shares: number;
  note: string;
}

export interface T0Analysis {
  /* 行情快照 */
  last: number;
  prevClose: number;
  vwap: number;
  high: number;
  low: number;
  /** 现价相对分时均价偏离（%） */
  vwapDev: number;
  /** 当日涨跌幅（%） */
  pct: number;
  /** 当日已实现振幅（%） */
  dayRange: number;
  /** 近 20 日平均振幅（%） */
  avgRange20: number;
  /** 剩余空间（百分点） */
  remaining: number;
  ranges: number[];

  /* 成本 */
  /** 单次往返成本率（%） */
  costRate: number;
  /** 含最低佣金的实际总费用（元） */
  costAmount: number;
  /** 每股盈亏平衡价差（元） */
  costPerShare: number;
  /** 最小价差率（%） */
  minSpreadPct: number;

  /* 判定 */
  verdict: T0Verdict;
  verdictNote: string;
  /** 0~100 做 T 适宜度 */
  score: number;

  /* 计划 */
  shares: number;
  plan: T0Plan | null;
  /** 假设只捕捉平均振幅的 35% 时的净收益（元） */
  expectedNet: number;
  /** 上述假设下的毛收益（元） */
  expectedGross: number;

  lines: string[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);

/** 近 n 日振幅序列：(high - low) / 前收 */
export function amplitudeSeries(bars: Bar[], n = 20): number[] {
  const out: number[] = [];
  for (let i = Math.max(1, bars.length - n); i < bars.length; i++) {
    const prev = bars[i - 1].close;
    if (prev > 0 && Number.isFinite(bars[i].high) && Number.isFinite(bars[i].low)) {
      out.push(((bars[i].high - bars[i].low) / prev) * 100);
    }
  }
  return out;
}

/** 单次往返费用：佣金双边（含最低 5 元）+ 印花税（卖出）+ 过户费双边 */
export function t0Cost(shares: number, price: number, cfg: T0Config): { amount: number; perShare: number; rate: number } {
  const turnover = Math.max(1, shares) * Math.max(0.01, price);
  const commission = 2 * Math.max(turnover * cfg.commission, cfg.minCommission);
  const stamp = turnover * cfg.stampTax;
  const transfer = 2 * turnover * cfg.transferFee;
  const amount = commission + stamp + transfer;
  return {
    amount,
    perShare: shares > 0 ? amount / shares : amount,
    rate: turnover > 0 ? (amount / turnover) * 100 : 0
  };
}

export function analyzeT0(bars: Bar[], day: IntradaySnapshot, cfg: T0Config): T0Analysis {
  const ranges = amplitudeSeries(bars, 20);
  const avgRange20 = mean(ranges) || 1.5;

  const prevClose = day.prevClose > 0 ? day.prevClose : bars.length > 1 ? bars[bars.length - 2].close : day.last;
  const last = day.last > 0 ? day.last : prevClose;
  const high = Math.max(day.high, last);
  const low = Math.min(day.low, last);
  const vwap = day.points.length ? day.points[day.points.length - 1].vwap : last;

  const dayRange = prevClose > 0 ? ((high - low) / prevClose) * 100 : 0;
  const remaining = Math.max(0, avgRange20 - dayRange);
  const vwapDev = vwap > 0 ? ((last / vwap - 1) * 100) : 0;
  const pct = prevClose > 0 ? ((last / prevClose - 1) * 100) : 0;

  // 股数：底仓 × 比例，向下取整到 100 股（A 股一手）
  const shares = Math.max(0, Math.floor((Math.max(0, cfg.baseShares) * clamp(cfg.tRatio, 0, 1)) / 100) * 100);
  const cost = t0Cost(Math.max(shares, 100), last, cfg);
  const costPerShare = shares > 0 ? cost.amount / shares : 0;
  const minSpreadPct = costPerShare > 0 ? (costPerShare / last) * 100 : 0;

  /* ---- 判定 ---- */
  let verdict: T0Verdict;
  let verdictNote: string;

  if (shares < 100) {
    verdict = '不适合';
    verdictNote = '底仓或做 T 比例太小，凑不满一手（100 股），没有可操作数量。';
  } else if (shares > cfg.baseShares) {
    verdict = '不适合';
    verdictNote = '做 T 数量超过底仓，会变成真的加仓/减仓，不符合回转前提。';
  } else if (Math.abs(pct) > 4) {
    // 单边行情先说踏空风险，再谈剩余空间——否则大涨日只会显示「空间不足」，重点被埋掉
    verdict = '观望';
    verdictNote = `今日涨跌幅 ${pct.toFixed(2)}% 属于单边行情，做 T 容易踏空或接飞刀，宁可不动。`;
  } else if (remaining < minSpreadPct * 1.5) {
    verdict = '不适合';
    verdictNote = `剩余波动空间 ${remaining.toFixed(2)}% 不到盈亏平衡价差 ${minSpreadPct.toFixed(2)}% 的 1.5 倍，做 T 大概率给券商打工。`;
  } else if (vwapDev > 0.35) {
    verdict = '倒T';
    verdictNote = `现价高于分时均价 ${vwapDev.toFixed(2)}%，先高抛老仓、回落到均价下方再买回。`;
  } else if (vwapDev < -0.35) {
    verdict = '正T';
    verdictNote = `现价低于分时均价 ${Math.abs(vwapDev).toFixed(2)}%，先低吸、反弹到均价上方再卖掉等量老仓。`;
  } else {
    verdict = '观望';
    verdictNote = `现价紧贴分时均价（偏离 ${vwapDev.toFixed(2)}%），没有足够回归空间，等拉开价差再动手。`;
  }

  /* ---- 适宜度 ---- */
  let score = 50;
  score += clamp((remaining / avgRange20) * 40 - 12, -20, 28); // 剩余空间
  score += clamp(Math.abs(vwapDev) * 6, 0, 18); // 均价偏离
  score -= clamp(Math.abs(pct) * 3, 0, 18); // 单边风险
  score -= minSpreadPct > 0 && remaining < minSpreadPct * 3 ? 12 : 0;
  if (verdict === '不适合') score = Math.min(score, 25);
  score = Math.round(clamp(score, 0, 100));

  /* ---- 两腿价格 ---- */
  const dev = last * clamp(avgRange20 / 100 * 0.3, 0.002, 0.008);
  const eps = Math.max(0.01, last * 0.001); // 区间最小宽度 0.1%，避免退化成一个点

  // 低吸区：下界不破今日低点，上界至少比下界高 0.1%
  const buyLow = Math.max(low, vwap - dev * 1.5);
  const buyHigh = Math.max(buyLow + eps, Math.max(low, vwap - dev * 0.4));
  // 高抛区：上界不超过今日高点，下界至少比上界低 0.1%
  const sellHigh = Math.max(vwap + dev * 1.5, high);
  const sellLow = Math.min(sellHigh - eps, vwap + dev * 0.4);

  const plan: T0Plan | null =
    verdict === '正T'
      ? {
          direction: '正T',
          firstLabel: '低吸买入',
          first: [buyLow, buyHigh],
          secondLabel: '高抛卖出（等量老仓）',
          second: [sellLow, sellHigh],
          shares,
          note: '先买后卖，卖的是昨日底仓；收盘股数不变，赚的是中间价差。'
        }
      : verdict === '倒T'
        ? {
            direction: '倒T',
            firstLabel: '高抛卖出（老仓）',
            first: [sellLow, sellHigh],
            secondLabel: '回落买回',
            second: [buyLow, buyHigh],
            shares,
            note: '先卖后买，用底仓做空头回转；回落不到位就不要追着买回。'
          }
        : null;

  /* ---- 收益估算：已走完的振幅赚不到，只能赚「剩余空间」的一小部分 ---- */
  const capture = (remaining * 0.35) / 100;
  const expectedGross = shares * last * capture;
  const expectedNet = expectedGross - cost.amount;

  /* ---- 结论 ---- */
  const lines: string[] = [];
  lines.push(
    `当日已走振幅 ${dayRange.toFixed(2)}%，近 20 日平均 ${avgRange20.toFixed(2)}%，理论剩余空间 ${remaining.toFixed(2)}%。`
  );
  lines.push(
    `按 ${shares} 股、${last.toFixed(2)} 元计算，一次往返费用约 ${cost.amount.toFixed(1)} 元（佣金双边含最低 ${cfg.minCommission} 元 + 印花税 + 过户费），` +
      `每股至少赚 ${costPerShare.toFixed(3)} 元（${minSpreadPct.toFixed(3)}%）才不亏。`
  );
  lines.push(`做 T 判定：${verdict}——${verdictNote}`);
  if (plan) {
    lines.push(
      `${plan.direction} 计划：${plan.firstLabel} ${plan.first[0].toFixed(2)}~${plan.first[1].toFixed(2)}，` +
        `${plan.secondLabel} ${plan.second[0].toFixed(2)}~${plan.second[1].toFixed(2)}，数量 ${shares} 股。`
    );
  }
  lines.push(
    `收益估算：假设只捕捉剩余空间的 35%（约 ${(remaining * 0.35).toFixed(2)}% 价差），` +
      `毛收益约 ${expectedGross.toFixed(0)} 元，扣费后净 ${expectedNet >= 0 ? '+' : ''}${expectedNet.toFixed(0)} 元。` +
      (remaining <= 0 ? '今日振幅已走满，这个数字只是「硬做会怎样」，不是机会。' : '这只是量级参考，不是预测。')
  );

  return {
    last,
    prevClose,
    vwap,
    high,
    low,
    vwapDev,
    pct,
    dayRange,
    avgRange20,
    remaining,
    ranges,
    costRate: (2 * cfg.commission + cfg.stampTax + 2 * cfg.transferFee) * 100,
    costAmount: cost.amount,
    costPerShare,
    minSpreadPct,
    verdict,
    verdictNote,
    score,
    shares,
    plan,
    expectedNet,
    expectedGross,
    lines
  };
}
