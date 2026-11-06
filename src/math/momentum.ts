/**
 * 动能 / 动量策略内核
 *
 * 思路（经典时序动量 + 三重风险控制）：
 *   1. 时序动量：比较「回看窗口」累计收益，跳过最近 N 日以规避短期反转（12-1 动量）。
 *   2. 滞后带：收益 > entry 才开仓，跌破 exit 才平仓；中间区间保持原状态，降低换手。
 *   3. 趋势过滤：价格需站上长均线，避免在下跌趋势里做多动量。
 *   4. 波动率目标：仓位 = 目标波动 / 已实现波动，波动放大自动减仓。
 *
 * 全部为纯函数，可独立单测。
 */
import type { Bar } from '../data/types';
import { runBacktest, type BtConfig, type BtResult } from './backtest';
import { sma } from './indicators';

export interface MomParams {
  /** 动量回看窗口（交易日） */
  lookback: number;
  /** 跳过最近 N 日 */
  skip: number;
  /** 趋势过滤均线长度，0 表示不过滤 */
  maLen: number;
  /** 开仓阈值（区间收益，小数） */
  entry: number;
  /** 平仓阈值（区间收益，小数） */
  exit: number;
  /** 年化目标波动，<=0 表示关闭波动率缩放 */
  targetVol: number;
  /** 单边仓位上限 */
  cap: number;
}

export const DEFAULT_MOM: MomParams = {
  lookback: 126,
  skip: 5,
  maLen: 200,
  entry: 0.02,
  exit: -0.02,
  targetVol: 0.15,
  cap: 1
};

/** 区间累计收益：closes[t-skip] / closes[t-skip-lookback] - 1 */
export function momReturn(closes: number[], t: number, lookback: number, skip = 0): number {
  const end = t - skip;
  const start = end - lookback;
  if (start < 0 || end >= closes.length) return 0;
  const a = closes[start];
  const b = closes[end];
  if (!(a > 0) || !Number.isFinite(b)) return 0;
  return b / a - 1;
}

/** 截至 t 日的已实现年化波动（用最近 win 个日收益） */
export function rollingVol(closes: number[], t: number, win = 20): number {
  const start = Math.max(1, t - win + 1);
  const rs: number[] = [];
  for (let i = start; i <= t; i++) {
    const p = closes[i - 1];
    if (p > 0 && Number.isFinite(closes[i])) rs.push(closes[i] / p - 1);
  }
  if (rs.length < 2) return 0;
  const m = rs.reduce((a, b) => a + b, 0) / rs.length;
  const v = rs.reduce((a, b) => a + (b - m) ** 2, 0) / (rs.length - 1);
  return Math.sqrt(Math.max(v, 0)) * Math.sqrt(252);
}

/** 波动率目标下的仓位规模（不含信号，仅风险预算） */
export function positionSize(closes: number[], t: number, p: MomParams): number {
  const cap = Math.max(0, Math.min(1, p.cap));
  if (p.targetVol <= 0) return cap;
  const vol = rollingVol(closes, t, 20);
  if (!(vol > 1e-6)) return cap;
  return Math.max(0, Math.min(cap, p.targetVol / vol));
}

/** 逐日目标仓位（0 ~ cap），t 日收盘确定、作用于 t→t+1 收益 */
export function momentumPositions(closes: number[], p: MomParams): number[] {
  const T = closes.length;
  const out = new Array(T).fill(0);
  const ma = p.maLen > 0 ? sma(closes, p.maLen) : null;
  let held = false;
  for (let t = 0; t < T; t++) {
    const warm = t - p.skip - p.lookback >= 0;
    if (!warm) {
      held = false;
      continue;
    }
    const raw = momReturn(closes, t, p.lookback, p.skip);
    const maOk = !ma || (Number.isFinite(ma[t]) && ma[t] > 0 && closes[t] >= ma[t]);
    if (held) {
      if (raw < p.exit || !maOk) held = false;
    } else if (raw > p.entry && maOk) {
      held = true;
    }
    if (held) out[t] = positionSize(closes, t, p);
  }
  return out;
}

/** 动量强度分 0~100：把区间收益按波动率标准化后压到 0~100 */
export function momentumScore(closes: number[], t: number, p: MomParams): number {
  const raw = momReturn(closes, t, p.lookback, p.skip);
  const vol = rollingVol(closes, t, 60);
  const horizon = Math.sqrt(Math.max(p.lookback, 1) / 252);
  const denom = Math.max((vol > 1e-6 ? vol : 0.2) * horizon, 1e-9);
  return Math.max(0, Math.min(100, 50 + 50 * Math.tanh(raw / denom)));
}

export interface MomWindow {
  label: string;
  days: number;
  ret: number;
  ann: number;
}

const WINDOWS: { label: string; days: number }[] = [
  { label: '1 月', days: 21 },
  { label: '3 月', days: 63 },
  { label: '6 月', days: 126 },
  { label: '12 月', days: 252 }
];

/** 分周期动量表（截至 endIdx） */
export function windowReturns(closes: number[], endIdx: number): MomWindow[] {
  return WINDOWS.map((w) => {
    const ret = momReturn(closes, endIdx, w.days, 0);
    const years = w.days / 252;
    const ann = ret > -1 && years > 0 ? Math.pow(1 + ret, 1 / years) - 1 : 0;
    return { label: w.label, days: w.days, ret, ann };
  });
}

export type MomVerdict = 'bull' | 'weak' | 'flat' | 'bear';

export interface MomReport {
  dates: string[];
  closes: number[];
  positions: number[];
  bt: BtResult;
  /** 逐日区间动量（预热期为 null） */
  momSeries: (number | null)[];
  /** 逐日年化波动 */
  volSeries: (number | null)[];
  windows: MomWindow[];
  score: number;
  verdict: MomVerdict;
  verdictText: string;
  held: boolean;
  raw: number;
  vol: number;
  exposure: number;
  tradeCount: number;
  currentPos: number;
}

export function buildMomentumReport(bars: Bar[], p: MomParams, cfg: BtConfig): MomReport {
  const dates = bars.map((b) => b.date);
  const closes = bars.map((b) => b.close);
  const T = closes.length;
  const positions = momentumPositions(closes, p);
  const bt = runBacktest(dates, closes, positions, cfg);

  const momSeries: (number | null)[] = new Array(T).fill(null);
  const volSeries: (number | null)[] = new Array(T).fill(null);
  for (let t = 0; t < T; t++) {
    if (t - p.skip - p.lookback >= 0) momSeries[t] = momReturn(closes, t, p.lookback, p.skip);
    if (t >= 20) {
      const v = rollingVol(closes, t, 20);
      volSeries[t] = Number.isFinite(v) ? v : null;
    }
  }

  const last = T - 1;
  const raw = last >= 0 ? momReturn(closes, last, p.lookback, p.skip) : 0;
  const vol = last >= 0 ? rollingVol(closes, last, 20) : 0;
  const score = last >= 0 ? momentumScore(closes, last, p) : 50;
  const currentPos = last >= 0 ? positions[last] : 0;
  const held = currentPos > 0;

  let verdict: MomVerdict;
  let verdictText: string;
  if (held && raw >= 0.02) {
    verdict = 'bull';
    verdictText = '多头动能确认 · 持有';
  } else if (held) {
    verdict = 'weak';
    verdictText = '弱多头动能 · 持有观察';
  } else if (raw > 0) {
    verdict = 'flat';
    verdictText = '动量不足 · 空仓等待';
  } else {
    verdict = 'bear';
    verdictText = '空头 / 震荡 · 空仓';
  }

  let tradeCount = 0;
  for (let t = 1; t < T; t++) if (positions[t - 1] === 0 && positions[t] > 0) tradeCount++;
  const exposure = T > 0 ? positions.reduce((a, b) => a + b, 0) / T : 0;

  return {
    dates,
    closes,
    positions,
    bt,
    momSeries,
    volSeries,
    windows: last >= 0 ? windowReturns(closes, last) : [],
    score,
    verdict,
    verdictText,
    held,
    raw,
    vol,
    exposure,
    tradeCount,
    currentPos
  };
}
