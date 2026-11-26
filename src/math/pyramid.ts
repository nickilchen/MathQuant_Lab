/**
 * 斐波那契加仓 · 橄榄型 / 纺锤型（区间信念型加仓）
 *
 * 和标准的斐波那契加仓都不一样：
 *   - 标准逆势加仓：越跌越重（1、1、2、3、5、8）——摊低成本，但也越套越深；
 *   - 标准顺势加仓：越涨越重（1、2、4、8）——利润奔跑，但回撤吐得快；
 *   - 本策略「两头小、中间大」：把风险预算集中押在 38.2%~61.8% 黄金分割核心区，
 *     浅回撤不确定先小加，核心区重仓，跌到末端若还没止跌反而不敢再加、甚至整体止损。
 *
 * 本质：赌「黄金分割带撑住」。所以它不是预测工具，而是「风险预算如何摆位」的计划工具，
 * 使用前必须先定义核心区失效位（有效跌破 61.8% 或 78.6% 就整体止损），
 * 否则「中间大加」会退化成「重仓赌支撑」。
 *
 * 纯函数，不碰 DOM / 网络 / localStorage，可单测。
 */
import type { Bar } from '../data/types';
import { sma } from './indicators';

/** 加仓权重模式 */
export type PyramidMode = 'olive' | 'fib';
/** 核心区失效位（整体止损线） */
export type StopMode = '618' | '786';

export interface PyramidConfig {
  /** 识别主升段（高点 / 起点低点）的回看交易日 */
  lookback: number;
  /** 总风险预算（本金） */
  capital: number;
  /** olive=橄榄型 1/3/5/3/1；fib=标准逆势 1/1/2/3/5（对照用） */
  mode: PyramidMode;
  /** 止损放在 61.8% 还是 78.6% 回撤位 */
  stopMode: StopMode;
  /** 每手股数（仓位取整） */
  lot: number;
}

export const DEFAULT_PYRAMID_CONFIG: PyramidConfig = {
  lookback: 120,
  capital: 100000,
  mode: 'olive',
  stopMode: '786',
  lot: 100
};

/** 五档斐波那契回撤位与权重 */
export const FIB_LEVELS = [0.236, 0.382, 0.5, 0.618, 0.764] as const;
export const FIB_LABELS = ['23.6%', '38.2%', '50.0%', '61.8%', '76.4%'] as const;
export const OLIVE_WEIGHTS = [1, 3, 5, 3, 1] as const;
export const FIB_WEIGHTS = [1, 1, 2, 3, 5] as const;

export type Zone = '浅回撤' | '核心区' | '末端';
export type Verdict = '可执行' | '等回撤' | '风险过高' | '不适合';

export interface LadderRow {
  /** 回撤比例，如 0.382 */
  level: number;
  /** 回撤标签，如 38.2% */
  label: string;
  /** 该档挂单价 */
  price: number;
  /** 权重份数 */
  weight: number;
  /** 该档买入股数（按每手取整） */
  shares: number;
  /** 该档投入金额 */
  amount: number;
  /** 从浅到深累计股数 */
  cumShares: number;
  /** 累计投入金额 */
  cumAmount: number;
  /** 累计平均成本 */
  cumAvgCost: number;
  /** 距现价的百分比（负=在现价下方） */
  fromClose: number;
  zone: Zone;
  /** 该档是否参与（止损 618 时末端档停用） */
  active: boolean;
}

export interface PyramidFact {
  label: string;
  value: string;
  tone: 'up' | 'down' | 'flat';
}

export interface PyramidResult {
  /** 主升段高点及其日期 */
  high: number;
  highDate: string;
  /** 主升段起点低点及其日期 */
  low: number;
  lowDate: string;
  /** 现价 */
  close: number;
  /** 主升幅度 = high − low */
  amplitude: number;
  /** 现价回撤比例 = (high − close) / amplitude */
  retrace: number;
  /** 回撤是否成立：低点必须在高点之前、且幅度足够 */
  valid: boolean;
  invalidReason: string | null;
  mode: PyramidMode;
  weights: number[];
  rows: LadderRow[];
  totalShares: number;
  totalAmount: number;
  /** 全档成交后的平均成本 */
  avgCost: number;
  /** 核心区（38.2/50/61.8）占总股数比例（%） */
  coreSharePct: number;
  /** 止损位价格与回撤比例 */
  stopPrice: number;
  stopLabel: string;
  /** 全部成交后若触发止损的最大亏损金额与占预算比例（%） */
  maxLoss: number;
  maxLossPct: number;
  /** 目标位（回到主升段高点）与潜在收益 */
  target: number;
  upsidePct: number;
  /** 盈亏比 = (target − avgCost) / (avgCost − stopPrice) */
  rr: number;
  verdict: Verdict;
  verdictNote: string;
  /** 趋势结构：close > MA20 > MA60 */
  trendOk: boolean;
  ma20: number | null;
  ma60: number | null;
  facts: PyramidFact[];
  lines: string[];
  /** 用户强调的四条致命风险 + 两档止损差异，始终显示 */
  warnings: string[];
  notes: string[];
}

const r2 = (v: number): number => Math.round(v * 100) / 100;
const num = (v: number): boolean => Number.isFinite(v) && v > 0;

/**
 * 四条致命风险的固定文案（无论是否触发都要显示——这是策略的前置条件）。
 */
export const PYRAMID_RISKS: string[] = [
  '价格快速穿透 38.2%—61.8% 核心区时，你的最大仓位正好挨着最大亏损——重仓区恰是亏损区。',
  '价格不到核心区就反转，你仓位太轻，赚不到；这是「不接飞刀」必须付出的机会成本。',
  '震荡市里核心区反复被扫，容易「中间大加、两头被打」，来回磨损吃掉本金。',
  '本质是在赌「黄金分割带一定撑住」。一旦趋势反转，中间重仓会显著放大亏损。'
];

/**
 * 从 bars 中识别主升段：区间最高点 high，以及「高点之前」的最低点作为起点 low。
 * 要求低点在高点之前（先涨后回撤），且幅度 ≥ 3%，否则不构成可加仓的回撤结构。
 */
export function detectSwingRange(bars: Bar[], lookback: number): {
  high: number; highDate: string; low: number; lowDate: string; highIdx: number; lowIdx: number;
} | null {
  if (bars.length < 30) return null;
  const seg = bars.slice(-Math.min(lookback, bars.length));
  let hiIdx = 0;
  for (let i = 1; i < seg.length; i++) if (seg[i].high > seg[hiIdx].high) hiIdx = i;
  // 起点低点只在高点之前找——高点之后的低点属于下跌段，不是「主升段的起点」
  let loIdx = 0;
  for (let i = 0; i <= hiIdx; i++) if (seg[i].low < seg[loIdx].low) loIdx = i;
  const high = seg[hiIdx].high;
  const low = seg[loIdx].low;
  return { high, highDate: seg[hiIdx].date, low, lowDate: seg[loIdx].date, highIdx: hiIdx, lowIdx: loIdx };
}

/**
 * 橄榄型 / 逆势斐波那契加仓计划。
 * 数据不足或结构不成立返回 null，调用方负责提示，绝不用模拟数据冒充。
 */
export function analyzePyramid(bars: Bar[], cfg: PyramidConfig = DEFAULT_PYRAMID_CONFIG): PyramidResult | null {
  if (bars.length < 60) return null;
  const closes = bars.map((b) => b.close);
  const last = bars[bars.length - 1];
  const close = last.close;
  if (!num(close)) return null;

  const ma20Arr = sma(closes, 20);
  const ma60Arr = sma(closes, 60);
  const i = bars.length - 1;
  const ma20 = ma20Arr[i];
  const ma60 = ma60Arr[i];

  const range = detectSwingRange(bars, cfg.lookback);
  if (!range) return null;
  const { high, highDate, low, lowDate, highIdx, lowIdx } = range;
  const amplitude = high - low;
  const retrace = amplitude > 0 ? (high - close) / amplitude : 0;
  const valid = num(high) && num(low) && high > low && lowIdx < highIdx && amplitude / low >= 0.03;
  const invalidReason = !num(high) || !num(low)
    ? '行情数据异常（高点或低点缺失）'
    : high <= low
      ? '区间内没有明显上涨（高点未高于起点低点）'
      : lowIdx >= highIdx
        ? '区间最低点出现在最高点之后，属下跌段而非「上涨后回撤」'
        : amplitude / low < 0.03
          ? '主升幅度不足 3%，回撤区没有统计意义'
          : null;

  const baseWeights = cfg.mode === 'olive' ? OLIVE_WEIGHTS : FIB_WEIGHTS;
  // 止损放在 61.8% 时，76.4% 末端档永不执行（还没走到就已经止损）
  const weights: number[] = baseWeights.map((w, k) => (cfg.stopMode === '618' && k === 4 ? 0 : w));
  const sumW = weights.reduce<number>((a, b) => a + b, 0);
  const lot = cfg.lot > 0 ? cfg.lot : 100;

  let cumShares = 0;
  let cumAmount = 0;
  const rows: LadderRow[] = FIB_LEVELS.map((level, k) => {
    const price = r2(high - amplitude * level);
    const weight = weights[k];
    const active = weight > 0;
    const budget = sumW > 0 ? (cfg.capital * weight) / sumW : 0;
    const shares = active && num(price) ? Math.floor(budget / price / lot) * lot : 0;
    const amount = r2(shares * price);
    cumShares += shares;
    cumAmount += amount;
    const zone: Zone = k <= 1 ? '浅回撤' : k <= 3 ? '核心区' : '末端';
    return {
      level,
      label: FIB_LABELS[k],
      price,
      weight,
      shares,
      amount,
      cumShares,
      cumAmount: r2(cumAmount),
      cumAvgCost: cumShares > 0 ? r2(cumAmount / cumShares) : 0,
      fromClose: close > 0 ? r2((price / close - 1) * 100) : 0,
      zone,
      active
    };
  });

  const totalShares = cumShares;
  const totalAmount = r2(cumAmount);
  const avgCost = totalShares > 0 ? r2(totalAmount / totalShares) : 0;
  const coreShares = rows.filter((r) => r.zone === '核心区').reduce((s, r) => s + r.shares, 0);
  const coreSharePct = totalShares > 0 ? (coreShares / totalShares) * 100 : 0;

  const stopRatio = cfg.stopMode === '618' ? 0.618 : 0.786;
  const stopPrice = r2(high - amplitude * stopRatio);
  const stopLabel = cfg.stopMode === '618' ? '61.8%（核心区下沿）' : '78.6%（末端）';
  // 「趋势结构完好」不能简单用 MA 多头排列——回撤到核心区时 MA20 必然走平下弯。
  // 本策略的判据是：守住主升段起点、且尚未跌破核心区失效位。均线只作参考读数。
  const trendOk = valid && close > low && close > stopPrice;
  const maxLoss = avgCost > 0 && avgCost > stopPrice ? r2((avgCost - stopPrice) * totalShares) : 0;
  const maxLossPct = cfg.capital > 0 ? (maxLoss / cfg.capital) * 100 : 0;
  const target = r2(high);
  const upsidePct = avgCost > 0 ? ((target - avgCost) / avgCost) * 100 : 0;
  const rr = avgCost > 0 && avgCost > stopPrice ? (target - avgCost) / (avgCost - stopPrice) : 0;

  /* ---------- 判定 ---------- */
  let verdict: Verdict;
  let verdictNote: string;
  if (!valid) {
    verdict = '不适合';
    verdictNote = invalidReason ?? '回撤结构不成立。';
  } else if (close > high) {
    verdict = '等回撤';
    verdictNote = '现价仍在主升段高点之上，尚未发生回撤。计划可以摆好，但不要在创新高时追着加。';
  } else if (close <= stopPrice || !trendOk) {
    verdict = '不适合';
    verdictNote = `现价 ${close.toFixed(2)} 已跌破 ${stopLabel} 止损位 ${stopPrice.toFixed(2)}（或回撤已吞没主升段），核心区判定失效。此时应整体止损，而不是继续在末端小加摊平。`;
  } else if (retrace >= 0.382 && retrace <= 0.618) {
    verdict = '可执行';
    verdictNote = '趋势结构完好、现价处于 38.2%—61.8% 黄金分割核心区，正是本策略风险预算最集中的位置。执行前提：止损单已挂好。';
  } else if (retrace < 0.382) {
    verdict = '等回撤';
    verdictNote = '浅回撤阶段，只需按 23.6%/38.2% 档小加。核心区还没到，重仓档先空着。';
  } else {
    verdict = '风险过高';
    verdictNote = '已越过 61.8% 核心区下沿：末端只留极小仓或停止，跌破止损必须整体离场。';
  }

  const facts: PyramidFact[] = [
    { label: '回撤结构', value: trendOk ? '守住起点且未破失效位' : '已跌破失效位 / 结构失效', tone: trendOk ? 'up' : 'down' },
    { label: 'MA20 / MA60（参考）', value: `${num(ma20) ? r2(ma20).toFixed(2) : '—'} / ${num(ma60) ? r2(ma60).toFixed(2) : '—'}`, tone: 'flat' },
    { label: '主升高点 / 起点低点', value: `${high.toFixed(2)} / ${low.toFixed(2)}`, tone: 'flat' },
    { label: '现价回撤比例', value: `${(retrace * 100).toFixed(1)}%`, tone: retrace > 0.618 ? 'down' : retrace >= 0.382 ? 'up' : 'flat' },
    { label: '全档平均成本', value: totalShares > 0 ? avgCost.toFixed(2) : '—', tone: 'flat' },
    { label: '核心区仓位占比', value: totalShares > 0 ? `${coreSharePct.toFixed(1)}%` : '—', tone: coreSharePct >= 60 ? 'up' : 'flat' },
    { label: `止损位（${stopLabel}）`, value: stopPrice.toFixed(2), tone: 'down' },
    { label: '最大亏损 / 占预算', value: `${maxLoss.toFixed(0)} / ${maxLossPct.toFixed(1)}%`, tone: maxLossPct > 8 ? 'down' : 'flat' },
    { label: '回到高点潜在收益', value: `${upsidePct.toFixed(2)}%`, tone: upsidePct > 0 ? 'up' : 'down' },
    { label: '盈亏比', value: rr.toFixed(2), tone: rr >= 2 ? 'up' : rr < 1 ? 'down' : 'flat' }
  ];

  const lines = [
    `结构：以 ${lowDate} 低点 ${low.toFixed(2)} → ${highDate} 高点 ${high.toFixed(2)} 为主升段，幅度 ${amplitude.toFixed(2)}（${((amplitude / low) * 100).toFixed(1)}%）；现价 ${close.toFixed(2)}，回撤 ${(retrace * 100).toFixed(1)}%。`,
    `权重：${cfg.mode === 'olive' ? '橄榄型 1/3/5/3/1——核心区 38.2%/50%/61.8% 合计 11 份，两端各 1 份' : '标准逆势斐波那契 1/1/2/3/5——越跌越重（对照模式，不是本策略）'}；总预算 ${cfg.capital.toFixed(0)}，核心区占 ${coreSharePct.toFixed(1)}%。`,
    totalShares > 0
      ? `计划：五档挂单 ${rows.filter((r) => r.active).map((r) => `${r.label}@${r.price.toFixed(2)}×${r.shares}`).join('、')}；合计 ${totalShares} 股 / ${totalAmount.toFixed(0)}，平均成本 ${avgCost.toFixed(2)}。`
      : '计划：按当前本金与每手股数算，五档都不足一手，无法生成可执行计划——请调高预算或降低每手股数。',
    `止损：有效跌破 ${stopLabel} ${stopPrice.toFixed(2)} 即整体离场，不在末端摊平。全档成交后最大亏损 ${maxLoss.toFixed(0)}（占预算 ${maxLossPct.toFixed(1)}%），回到高点 ${target.toFixed(2)} 的潜在收益 ${upsidePct.toFixed(2)}%，盈亏比 ${rr.toFixed(2)}。`
  ];

  const notes = [
    cfg.mode === 'olive'
      ? '橄榄型（区间信念型）：两端加仓量轻，38.2%—61.8% 黄金分割带最重。'
      : '逆势斐波那契（对照）：越跌越重 1/1/2/3/5，与本策略相反，便于比较风险摆位差异。',
    cfg.stopMode === '618'
      ? '止损设在 61.8%：核心区下沿即失效位，76.4% 末端档已停用——不会走到那一步。'
      : '止损设在 78.6%：允许 76.4% 档极小加仓，但跌破 78.6% 必须整体止损，不许继续摊平。',
    '本页只回答「预算怎么摆、失效位在哪」，不预测涨幅；所有价格是挂单价，不是必然成交价。'
  ];

  const warnings = [...PYRAMID_RISKS];

  return {
    high, highDate, low, lowDate, close,
    amplitude, retrace, valid, invalidReason,
    mode: cfg.mode, weights, rows,
    totalShares, totalAmount, avgCost, coreSharePct,
    stopPrice, stopLabel, maxLoss, maxLossPct,
    target, upsidePct, rr,
    verdict, verdictNote, trendOk,
    ma20: num(ma20) ? r2(ma20) : null,
    ma60: num(ma60) ? r2(ma60) : null,
    facts, lines, warnings, notes
  };
}
