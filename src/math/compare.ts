/**
 * 多标的对比：日期对齐、归一化、相关性、相对强弱
 * 全部为纯函数，可独立单测。
 */
import type { Bar } from '../data/types';

export interface SeriesInput {
  code: string;
  bars: Bar[];
}

export interface AlignedSeries {
  dates: string[];
  series: { code: string; closes: number[] }[];
}

/**
 * 按日期取交集对齐多条收盘价序列。
 * 不同市场节假日不同，直接按下标对齐会把不同交易日错配，必须按日期求交。
 */
export function alignByDate(inputs: SeriesInput[]): AlignedSeries {
  const usable = inputs.filter((i) => i.bars.length > 0);
  if (usable.length === 0) return { dates: [], series: [] };
  const maps = usable.map((i) => new Map(i.bars.map((b) => [b.date, b.close] as const)));
  const dates = usable[0].bars.map((b) => b.date).filter((d) => maps.every((m) => m.has(d)));
  return {
    dates,
    series: usable.map((i, k) => ({ code: i.code, closes: dates.map((d) => maps[k].get(d)!) }))
  };
}

/** 归一化到起点 = 1，便于跨标的比较累计涨幅 */
export function normalizeToBase(values: number[]): number[] {
  if (values.length === 0) return [];
  const base = values[0];
  if (!Number.isFinite(base) || base === 0) return values.map(() => 1);
  return values.map((v) => v / base);
}

/** 简单日收益率序列（长度 = values.length - 1） */
export function dailyReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1];
    out.push(prev ? values[i] / prev - 1 : 0);
  }
  return out;
}

/** 皮尔逊相关系数；样本不足或方差为 0 时返回 0 */
export function pearson(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va === 0 || vb === 0) return 0;
  return cov / Math.sqrt(va * vb);
}

/** 相关系数矩阵（基于日收益率，而非价格水平——价格水平相关性是伪相关） */
export function correlationMatrix(closes: number[][]): number[][] {
  const rets = closes.map(dailyReturns);
  return closes.map((_, i) => closes.map((__, j) => (i === j ? 1 : pearson(rets[i], rets[j]))));
}

/** 相对强弱：a / b，再归一化到 1；上升表示 a 跑赢 b */
export function relativeStrength(a: number[], b: number[]): number[] {
  const n = Math.min(a.length, b.length);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(b[i] ? a[i] / b[i] : 1);
  return normalizeToBase(out);
}
