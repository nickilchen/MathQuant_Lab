/** 技术指标（NaN 表示预热期） */
import type { Bar } from '../data/types';
import { mean, std } from './stats';

export function sma(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let s = 0;
  for (let i = 0; i < x.length; i++) {
    s += x[i];
    if (i >= n) s -= x[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function ema(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  const k = 2 / (n + 1);
  let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let j = 0; j < n; j++) s += x[j];
      prev = s / n;
      out[i] = prev;
    } else if (i >= n) {
      prev = x[i] * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}

/** RSI（Wilder 平滑） */
export function rsi(closes: number[], n = 14): number[] {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= n) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= n;
  loss /= n;
  out[n] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (n - 1) + Math.max(d, 0)) / n;
    loss = (loss * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdResult {
  dif: number[];
  dea: number[];
  hist: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, sig = 9): MacdResult {
  const ef = ema(closes, fast);
  const es = ema(closes, slow);
  const dif = closes.map((_, i) => (Number.isNaN(ef[i]) || Number.isNaN(es[i]) ? NaN : ef[i] - es[i]));
  // DEA = EMA(DIF, sig)：从第一个有效 DIF 起以 SMA 种子启动（标准约定）
  const dea = new Array(closes.length).fill(NaN);
  const hist = new Array(closes.length).fill(NaN);
  const first = dif.findIndex((v) => !Number.isNaN(v));
  if (first >= 0) {
    const deaV = ema(dif.slice(first), sig);
    for (let i = 0; i < deaV.length; i++) {
      const idx = first + i;
      if (!Number.isNaN(deaV[i])) {
        dea[idx] = deaV[i];
        hist[idx] = 2 * (dif[idx] - deaV[i]);
      }
    }
  }
  return { dif, dea, hist };
}

/** 滚动年化已实现波动率（对数收益） */
export function realizedVol(closes: number[], n = 20): number[] {
  const out = new Array(closes.length).fill(NaN);
  for (let i = n; i < closes.length; i++) {
    const rets: number[] = [];
    for (let k = i - n + 1; k <= i; k++) rets.push(Math.log(closes[k] / closes[k - 1]));
    out[i] = std(rets) * Math.sqrt(252);
  }
  return out;
}

/** ATR */
export function atr(bars: Bar[], n = 14): number[] {
  const out = new Array(bars.length).fill(NaN);
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    return Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close));
  });
  let prev = NaN;
  for (let i = 0; i < bars.length; i++) {
    if (i === n - 1) {
      let s = 0;
      for (let k = 0; k < n; k++) s += tr[k];
      prev = s / n;
      out[i] = prev;
    } else if (i >= n) {
      prev = (prev * (n - 1) + tr[i]) / n;
      out[i] = prev;
    }
  }
  return out;
}

export interface BollResult {
  mid: number[];
  up: number[];
  low: number[];
}

export function bollinger(closes: number[], n = 20, k = 2): BollResult {
  const mid = sma(closes, n);
  const up = new Array(closes.length).fill(NaN);
  const low = new Array(closes.length).fill(NaN);
  for (let i = n - 1; i < closes.length; i++) {
    const win = closes.slice(i - n + 1, i + 1);
    const s = std(win);
    up[i] = mid[i] + k * s;
    low[i] = mid[i] - k * s;
  }
  return { mid, up, low };
}

/** 连续上涨天数（负值表示连续下跌） */
export function consecutiveUp(closes: number[]): number {
  let count = 0;
  for (let i = closes.length - 1; i > 0; i--) {
    const d = closes[i] - closes[i - 1];
    if (d === 0) break;
    if (count === 0) count = d > 0 ? 1 : -1;
    else if ((count > 0 && d > 0) || (count < 0 && d < 0)) count += d > 0 ? 1 : -1;
    else break;
  }
  return count;
}

/** 取最后一个有效（非 NaN）值 */
export function lastValid(x: number[]): number {
  for (let i = x.length - 1; i >= 0; i--) if (!Number.isNaN(x[i])) return x[i];
  return NaN;
}

/* ================= 趋势法指标 ================= */

/** ADX（Wilder，默认 14）：衡量趋势强度（不区分方向） */
export function adx(bars: Bar[], n = 14): number[] {
  const T = bars.length;
  const out = new Array(T).fill(NaN);
  if (T < n + 1) return out;
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];
  const tr: number[] = [bars[0].high - bars[0].low];
  for (let i = 1; i < T; i++) {
    const up = bars[i].high - bars[i - 1].high;
    const dn = bars[i - 1].low - bars[i].low;
    plusDM.push(up > dn && up > 0 ? up : 0);
    minusDM.push(dn > up && dn > 0 ? dn : 0);
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
  }
  // Wilder 平滑
  let trS = tr.slice(1, n + 1).reduce((a, b) => a + b, 0);
  let pS = plusDM.slice(1, n + 1).reduce((a, b) => a + b, 0);
  let mS = minusDM.slice(1, n + 1).reduce((a, b) => a + b, 0);
  const dx: number[] = new Array(T).fill(NaN);
  const pushDx = (i: number) => {
    const pdi = trS > 0 ? (100 * pS) / trS : 0;
    const mdi = trS > 0 ? (100 * mS) / trS : 0;
    const sum = pdi + mdi;
    dx[i] = sum > 0 ? (100 * Math.abs(pdi - mdi)) / sum : 0;
  };
  pushDx(n);
  for (let i = n + 1; i < T; i++) {
    trS = trS - trS / n + tr[i];
    pS = pS - pS / n + plusDM[i];
    mS = mS - mS / n + minusDM[i];
    pushDx(i);
  }
  // ADX = DX 的 Wilder 平滑
  let adxS = NaN;
  let cnt = 0;
  let acc = 0;
  for (let i = n; i < T; i++) {
    if (Number.isNaN(dx[i])) continue;
    if (cnt < n) {
      acc += dx[i];
      cnt++;
      if (cnt === n) {
        adxS = acc / n;
        out[i] = adxS;
      }
    } else {
      adxS = (adxS * (n - 1) + dx[i]) / n;
      out[i] = adxS;
    }
  }
  return out;
}

/** 唐奇安通道（N 日高低点） */
export function donchian(bars: Bar[], n = 20): { upper: number[]; lower: number[]; mid: number[] } {
  const T = bars.length;
  const upper = new Array(T).fill(NaN);
  const lower = new Array(T).fill(NaN);
  const mid = new Array(T).fill(NaN);
  for (let i = n - 1; i < T; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = i - n + 1; k <= i; k++) {
      if (bars[k].high > hi) hi = bars[k].high;
      if (bars[k].low < lo) lo = bars[k].low;
    }
    upper[i] = hi;
    lower[i] = lo;
    mid[i] = (hi + lo) / 2;
  }
  return { upper, lower, mid };
}

/** 最小二乘线性回归（对 index 回归），返回斜率/截角/决定系数 */
export function linReg(y: number[]): { slope: number; intercept: number; r2: number } {
  const n = y.length;
  if (n < 3) return { slope: 0, intercept: n ? y[0] : 0, r2: 0 };
  const xs = Array.from({ length: n }, (_, i) => i);
  const mx = (n - 1) / 2;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (y[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (y[i] - my) ** 2;
  }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = syy > 0 && sxx > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slope, intercept, r2 };
}

/** OBV（能量潮） */
export function obv(bars: Bar[]): number[] {
  const out = new Array(bars.length).fill(0);
  for (let i = 1; i < bars.length; i++) {
    const dir = Math.sign(bars[i].close - bars[i - 1].close);
    out[i] = out[i - 1] + dir * bars[i].volume;
  }
  return out;
}

/** 皮尔逊相关系数（截取末尾 n 个） */
export function corrTail(x: number[], y: number[], n = 20): number {
  const m = Math.min(x.length, y.length, n);
  if (m < 3) return 0;
  const xs = x.slice(-m);
  const ys = y.slice(-m);
  const mx = xs.reduce((a, b) => a + b, 0) / m;
  const my = ys.reduce((a, b) => a + b, 0) / m;
  let c = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < m; i++) {
    c += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : 0;
}

/** 滚动窗口序列：window(t) 处的指标值随时间序列，供分位数计算 */
export function rollingSeries(values: number[], n: number, fn: (win: number[]) => number): number[] {
  const out = new Array(values.length).fill(NaN);
  for (let i = n - 1; i < values.length; i++) out[i] = fn(values.slice(i - n + 1, i + 1));
  return out;
}

/** 均值绝对偏离，用于稳健尺度 */
export function mad(x: number[]): number {
  const m = mean(x);
  return mean(x.map((v) => Math.abs(v - m)));
}
