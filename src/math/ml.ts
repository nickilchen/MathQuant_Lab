/**
 * 机器学习模块：逻辑回归 + 单隐层 MLP（纯 TypeScript 反向传播）
 *  - 前向：tanh 隐层 → sigmoid 输出
 *  - 损失：二元交叉熵 + L2
 *  - 优化：Mini-batch SGD + Adam
 */
import { lastValid, macd, realizedVol, rsi, sma, bollinger } from './indicators';
import { mean, std } from './stats';
import type { Bar } from '../data/types';

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const FEATURE_NAMES = [
  '日收益率', '5日动量', '20日动量', 'HV20波动率', 'RSI14',
  'MACD柱', 'MA20偏离', 'MA60偏离', '量能比', '布林位置'
];

export interface Dataset {
  X: number[][];
  y: number[];
  dates: string[];
  /** X[i] 对应的 bars 下标（用于回测对齐） */
  tIdx: number[];
}

/** 特征工程：t 时刻特征 → t+1 涨跌标签 */
export function buildFeatures(bars: Bar[]): Dataset {
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);
  const r1 = closes.map((c, i) => (i === 0 ? 0 : c / closes[i - 1] - 1));
  const m5 = closes.map((c, i) => (i < 5 ? NaN : c / closes[i - 5] - 1));
  const m20 = closes.map((c, i) => (i < 20 ? NaN : c / closes[i - 20] - 1));
  const hv = realizedVol(closes, 20).map((v) => (Number.isNaN(v) ? NaN : v / 100));
  const rs = rsi(closes, 14);
  const mc = macd(closes).hist.map((h, i) => (Number.isNaN(h) ? NaN : h / closes[i]));
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const d20 = closes.map((c, i) => (Number.isNaN(ma20[i]) ? NaN : c / ma20[i] - 1));
  const d60 = closes.map((c, i) => (Number.isNaN(ma60[i]) ? NaN : c / ma60[i] - 1));
  const maV = sma(vols, 20);
  // 部分指数（如东财源下的日经225）成交量全为 0：量能比特征无意义，
  // 此时整列置 0（中性）而非 Infinity，避免样本被全部过滤
  const volAllZero = vols.every((v) => !(v > 0));
  const vr = volAllZero
    ? vols.map(() => 0)
    : vols.map((v, i) => (Number.isNaN(maV[i]) || maV[i] <= 0 ? NaN : v / maV[i]));
  const bb = bollinger(closes, 20, 2);
  const bbPos = closes.map((c, i) =>
    Number.isNaN(bb.up[i]) || bb.up[i] <= bb.low[i] ? NaN : (c - bb.low[i]) / (bb.up[i] - bb.low[i])
  );

  const cols = [r1, m5, m20, hv, rs, mc, d20, d60, vr, bbPos];
  const X: number[][] = [];
  const y: number[] = [];
  const dates: string[] = [];
  const tIdx: number[] = [];
  for (let t = 60; t < bars.length - 1; t++) {
    const row = cols.map((col) => col[t]);
    if (row.some((v) => !Number.isFinite(v))) continue;
    X.push(row);
    y.push(closes[t + 1] > closes[t] ? 1 : 0);
    dates.push(bars[t].date);
    tIdx.push(t);
  }
  return { X, y, dates, tIdx };
}

export interface Scaler {
  mu: number[];
  sd: number[];
}

export function fitScaler(X: number[][]): Scaler {
  const d = X[0].length;
  const mu = new Array(d).fill(0);
  const sd = new Array(d).fill(1);
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]);
    mu[j] = mean(col);
    sd[j] = Math.max(std(col), 1e-8);
  }
  return { mu, sd };
}

export function applyScaler(X: number[][], s: Scaler): number[][] {
  return X.map((row) => row.map((v, j) => (v - s.mu[j]) / s.sd[j]));
}

/* ================= 逻辑回归 ================= */

export class LogisticRegression {
  w: number[];
  b = 0;
  lossHistory: number[] = [];

  constructor(dim: number) {
    this.w = new Array(dim).fill(0);
  }

  private sigmoid(z: number): number {
    return 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));
  }

  fit(X: number[][], y: number[], lr = 0.1, epochs = 300, l2 = 1e-3): void {
    const n = X.length;
    const d = X[0].length;
    for (let ep = 0; ep < epochs; ep++) {
      const gw = new Array(d).fill(0);
      let gb = 0;
      let loss = 0;
      for (let i = 0; i < n; i++) {
        let z = this.b;
        for (let j = 0; j < d; j++) z += this.w[j] * X[i][j];
        const p = this.sigmoid(z);
        const err = p - y[i];
        for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
        gb += err;
        loss += -(y[i] * Math.log(p + 1e-9) + (1 - y[i]) * Math.log(1 - p + 1e-9));
      }
      for (let j = 0; j < d; j++) this.w[j] -= lr * (gw[j] / n + l2 * this.w[j]);
      this.b -= lr * (gb / n);
      this.lossHistory.push(loss / n);
    }
  }

  predictProba(X: number[][]): number[] {
    return X.map((row) => {
      let z = this.b;
      for (let j = 0; j < row.length; j++) z += this.w[j] * row[j];
      return this.sigmoid(z);
    });
  }
}

/* ================= MLP ================= */

interface AdamState {
  m: number[];
  v: number[];
}

function adamUpdate(p: number[], g: number[], st: AdamState, t: number, lr: number): void {
  const b1 = 0.9;
  const b2 = 0.999;
  const eps = 1e-8;
  const c1 = 1 - Math.pow(b1, t);
  const c2 = 1 - Math.pow(b2, t);
  for (let i = 0; i < p.length; i++) {
    st.m[i] = b1 * st.m[i] + (1 - b1) * g[i];
    st.v[i] = b2 * st.v[i] + (1 - b2) * g[i] * g[i];
    p[i] -= (lr * (st.m[i] / c1)) / (Math.sqrt(st.v[i] / c2) + eps);
  }
}

export class MLP {
  nin: number;
  nh: number;
  W1: number[][];
  b1: number[];
  W2: number[];
  b2 = 0;
  lossHistory: number[] = [];

  constructor(nin: number, nh: number, seed = 42) {
    this.nin = nin;
    this.nh = nh;
    const rnd = mulberry32(seed);
    const lim1 = Math.sqrt(6 / (nin + nh));
    this.W1 = Array.from({ length: nh }, () =>
      Array.from({ length: nin }, () => (rnd() * 2 - 1) * lim1)
    );
    this.b1 = new Array(nh).fill(0);
    this.W2 = Array.from({ length: nh }, () => (rnd() * 2 - 1) * Math.sqrt(6 / (nh + 1)));
  }

  private forward(x: number[]): { h: number[]; o: number } {
    const h = new Array(this.nh).fill(0);
    for (let j = 0; j < this.nh; j++) {
      let z = this.b1[j];
      for (let i = 0; i < this.nin; i++) z += this.W1[j][i] * x[i];
      h[j] = Math.tanh(z);
    }
    let z = this.b2;
    for (let j = 0; j < this.nh; j++) z += this.W2[j] * h[j];
    return { h, o: 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z)))) };
  }

  fit(X: number[][], y: number[], opts: { epochs?: number; lr?: number; batch?: number; l2?: number } = {}): void {
    const { epochs = 200, lr = 0.05, batch = 32, l2 = 1e-4 } = opts;
    const n = X.length;
    const rnd = mulberry32(7);
    const mW1: AdamState = { m: new Array(this.nh * this.nin).fill(0), v: new Array(this.nh * this.nin).fill(0) };
    const mb1: AdamState = { m: new Array(this.nh).fill(0), v: new Array(this.nh).fill(0) };
    const mW2: AdamState = { m: new Array(this.nh).fill(0), v: new Array(this.nh).fill(0) };
    let mb2m = 0;
    let mb2v = 0;
    let t = 0;

    for (let ep = 0; ep < epochs; ep++) {
      const idx = Array.from({ length: n }, (_, i) => i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rnd() * (i + 1));
        [idx[i], idx[j]] = [idx[j], idx[i]];
      }
      let epLoss = 0;
      for (let start = 0; start < n; start += batch) {
        const sel = idx.slice(start, start + batch);
        const { gW1, gb1, gW2, gb2, loss } = this.computeGradients(sel.map((i) => X[i]), sel.map((i) => y[i]));
        epLoss += loss;
        const m = sel.length;
        t++;
        // ---- Adam 逐参数更新（L2 加在均值梯度上，与历史版本一致） ----
        for (let j = 0; j < this.nh; j++) {
          for (let k = 0; k < this.nin; k++) {
            const g = gW1[j][k] / m;
            const mi = j * this.nin + k;
            mW1.m[mi] = 0.9 * mW1.m[mi] + 0.1 * g;
            mW1.v[mi] = 0.999 * mW1.v[mi] + 0.001 * g * g;
            this.W1[j][k] -= (lr * (mW1.m[mi] / (1 - Math.pow(0.9, t)))) / (Math.sqrt(mW1.v[mi] / (1 - Math.pow(0.999, t))) + 1e-8);
          }
        }
        adamUpdate(this.b1, gb1.map((g) => g / m), mb1, t, lr);
        adamUpdate(
          this.W2,
          gW2.map((g, j) => g / m + l2 * this.W2[j]),
          mW2,
          t,
          lr
        );
        const gb = gb2 / m;
        mb2m = 0.9 * mb2m + 0.1 * gb;
        mb2v = 0.999 * mb2v + 0.001 * gb * gb;
        this.b2 -= (lr * (mb2m / (1 - Math.pow(0.9, t)))) / (Math.sqrt(mb2v / (1 - Math.pow(0.999, t))) + 1e-8);
      }
      this.lossHistory.push(epLoss / n);
    }
  }

  /**
   * 目标函数 J = Σ_i BCE_i + (l2/2)·Σ_j W2_j² 的梯度（对求和形式，未除样本数）。
   * fit 与外部梯度校验共用同一代码路径，保证「训练用的反向传播」就是「被验证的反向传播」。
   */
  computeGradients(X: number[][], y: number[], l2 = 0): {
    gW1: number[][];
    gb1: number[];
    gW2: number[];
    gb2: number;
    loss: number;
  } {
    const gW1 = this.W1.map((r) => r.map(() => 0));
    const gb1 = new Array(this.nh).fill(0);
    const gW2 = new Array(this.nh).fill(0);
    let gb2 = 0;
    let loss = 0;
    for (let i = 0; i < X.length; i++) {
      const { h, o } = this.forward(X[i]);
      const d = o - y[i];
      gb2 += d;
      for (let j = 0; j < this.nh; j++) {
        gW2[j] += d * h[j];
        const dh = d * this.W2[j] * (1 - h[j] * h[j]);
        gb1[j] += dh;
        for (let k = 0; k < this.nin; k++) gW1[j][k] += dh * X[i][k];
      }
      loss += -(y[i] * Math.log(o + 1e-9) + (1 - y[i]) * Math.log(1 - o + 1e-9));
    }
    if (l2 > 0) {
      for (let j = 0; j < this.nh; j++) {
        gW2[j] += l2 * this.W2[j];
        loss += 0.5 * l2 * this.W2[j] * this.W2[j];
      }
    }
    return { gW1, gb1, gW2, gb2, loss };
  }

  /** 当前参数下的目标函数值 J = Σ BCE + (l2/2)ΣW2²（供梯度校验使用） */
  loss(X: number[][], y: number[], l2 = 0): number {
    let loss = 0;
    for (let i = 0; i < X.length; i++) {
      const { o } = this.forward(X[i]);
      loss += -(y[i] * Math.log(o + 1e-9) + (1 - y[i]) * Math.log(1 - o + 1e-9));
    }
    if (l2 > 0) for (let j = 0; j < this.nh; j++) loss += 0.5 * l2 * this.W2[j] * this.W2[j];
    return loss;
  }

  predictProba(X: number[][]): number[] {
    return X.map((row) => this.forward(row).o);
  }

  /** 特征重要性：第一层权重绝对值之和 */
  featureImportance(): number[] {
    const imp = new Array(this.nin).fill(0);
    for (let j = 0; j < this.nh; j++) {
      for (let i = 0; i < this.nin; i++) imp[i] += Math.abs(this.W1[j][i]);
    }
    return imp;
  }
}

/* ================= 评估 ================= */

export function accuracyScore(p: number[], y: number[], threshold = 0.5): number {
  if (p.length === 0) return 0;
  let c = 0;
  for (let i = 0; i < p.length; i++) if ((p[i] >= threshold ? 1 : 0) === y[i]) c++;
  return c / p.length;
}

export interface Confusion {
  tp: number;
  fp: number;
  tn: number;
  fn: number;
}

export function confusionMatrix(p: number[], y: number[], threshold = 0.5): Confusion {
  const c: Confusion = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (let i = 0; i < p.length; i++) {
    const pred = p[i] >= threshold ? 1 : 0;
    if (pred === 1 && y[i] === 1) c.tp++;
    else if (pred === 1 && y[i] === 0) c.fp++;
    else if (pred === 0 && y[i] === 0) c.tn++;
    else c.fn++;
  }
  return c;
}

/** AUC（Mann-Whitney U） */
export function aucScore(p: number[], y: number[]): number {
  const pos = p.filter((_, i) => y[i] === 1);
  const neg = p.filter((_, i) => y[i] === 0);
  if (pos.length === 0 || neg.length === 0) return 0.5;
  let wins = 0;
  for (const a of pos) for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

/** 概率 → 仓位：>0.55 做多，<0.45 做空 */
export function mlPosition(proba: number[], hi = 0.55, lo = 0.45): number[] {
  return proba.map((p) => {
    if (p >= hi) return Math.min(1, (p - hi) / 0.2 + 0.5);
    if (p <= lo) return -Math.min(1, (lo - p) / 0.2 + 0.5);
    return 0;
  });
}

export { lastValid };
