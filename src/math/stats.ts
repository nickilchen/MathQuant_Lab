/** 基础统计工具（纯函数，无副作用） */

export function mean(x: number[]): number {
  if (x.length === 0) return 0;
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
}

export function variance(x: number[], ddof = 0): number {
  const n = x.length;
  if (n - ddof <= 0) return 0;
  const m = mean(x);
  let s = 0;
  for (const v of x) s += (v - m) * (v - m);
  return s / (n - ddof);
}

export function std(x: number[], ddof = 0): number {
  return Math.sqrt(variance(x, ddof));
}

export function cov(x: number[], y: number[], ddof = 0): number {
  const n = Math.min(x.length, y.length);
  if (n - ddof <= 0) return 0;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let s = 0;
  for (let i = 0; i < n; i++) s += (x[i] - mx) * (y[i] - my);
  return s / (n - ddof);
}

export function corr(x: number[], y: number[]): number {
  const sx = std(x);
  const sy = std(y);
  if (sx < 1e-12 || sy < 1e-12) return 0;
  return cov(x, y) / (sx * sy);
}

/** 升序数组的 p 分位（线性插值） */
export function quantile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const pos = Math.min(Math.max(p, 0), 1) * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

/** v 在 arr 中的百分位排名 ∈ [0,1] */
export function rankOf(v: number, arr: number[]): number {
  if (arr.length === 0) return 0.5;
  let c = 0;
  for (const x of arr) if (x <= v) c++;
  return c / arr.length;
}

export function zscores(x: number[]): number[] {
  const m = mean(x);
  const s = std(x);
  if (s < 1e-12) return x.map(() => 0);
  return x.map((v) => (v - m) / s);
}

export function logReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0 && closes[i] > 0) out.push(Math.log(closes[i] / closes[i - 1]));
    else out.push(0);
  }
  return out;
}

/** 简单收益率 */
export function simpleReturns(closes: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < closes.length; i++) out.push(closes[i] / closes[i - 1] - 1);
  return out;
}

export function maxDrawdown(equity: number[]): number {
  let peak = -Infinity;
  let mdd = 0;
  for (const v of equity) {
    if (v > peak) peak = v;
    if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
  }
  return mdd;
}

export function linspace(a: number, b: number, n: number): number[] {
  if (n <= 1) return [a];
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => a + step * i);
}

/** 正态分布 CDF（Abramowitz-Stegun 近似） */
export function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - (Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)) * poly;
  return x >= 0 ? p : 1 - p;
}
