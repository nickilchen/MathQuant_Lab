/**
 * 风险平价与层次风险平价
 *  - shrinkCov：Ledoit-Wolf 风格对角收缩协方差估计
 *  - ercWeights：等风险贡献（ERC）循环坐标下降（CCD）
 *  - hrpWeights：层次风险平价（相关距离 + 平均连接聚类 + 递归二分）
 */
import { covarianceMatrix, matvec, type Mat } from './linalg';
import { corr } from './stats';

/** 对角收缩：非对角元素乘以 (1-δ)，稳定 ERC 求解 */
export function shrinkCov(series: number[][], delta = 0.2): Mat {
  const cov = covarianceMatrix(series);
  return cov.map((row, i) => row.map((v, j) => (i === j ? v : v * (1 - delta))));
}

export function inverseVolWeights(vols: number[]): number[] {
  const inv = vols.map((v) => 1 / Math.max(v, 1e-8));
  const s = inv.reduce((a, b) => a + b, 0);
  return inv.map((v) => v / s);
}

/**
 * 等风险贡献（ERC）权重。
 * 目标：w_i·(Σw)_i 全部相等。CCD 更新：w_i ← sqrt(w_i·RC* / (Σw)_i)，RC* = 1/n
 */
export function ercWeights(cov: Mat, maxIter = 1000, tol = 1e-12): number[] {
  const n = cov.length;
  let w = new Array(n).fill(1 / n);
  for (let iter = 0; iter < maxIter; iter++) {
    const m = matvec(cov, w);
    let delta = 0;
    for (let i = 0; i < n; i++) {
      const target = Math.max(m[i], 1e-14);
      const wi = Math.sqrt((w[i] / n) / target);
      delta = Math.max(delta, Math.abs(wi - w[i]) / Math.max(w[i], 1e-14));
      w[i] = wi;
    }
    const s = w.reduce((a, b) => a + b, 0);
    w = w.map((v) => v / s);
    if (delta < tol) break;
  }
  return w;
}

/** 风险贡献：RC_i = w_i(Σw)_i，归一化后合计为 1 */
export function riskContributions(w: number[], cov: Mat): number[] {
  const m = matvec(cov, w);
  const rc = w.map((wi, i) => wi * m[i]);
  const s = rc.reduce((a, b) => a + b, 0);
  return s > 0 ? rc.map((v) => v / s) : rc.map(() => 1 / w.length);
}

/* ================= HRP ================= */

interface Cluster {
  items: number[];
  left?: Cluster;
  right?: Cluster;
}

function corrMatrix(series: number[][]): Mat {
  const n = series.length;
  const out: Mat = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    out[i][i] = 1;
    for (let j = i + 1; j < n; j++) {
      const c = corr(series[i], series[j]);
      out[i][j] = c;
      out[j][i] = c;
    }
  }
  return out;
}

function buildTree(corr: Mat): Cluster {
  const active: Cluster[] = corr.map((_, i) => ({ items: [i] }));
  while (active.length > 1) {
    let bi = 0;
    let bj = 1;
    let best = Infinity;
    for (let i = 0; i < active.length; i++) {
      for (let j = i + 1; j < active.length; j++) {
        let s = 0;
        for (const a of active[i].items) for (const b of active[j].items) s += corr[a][b];
        const d = s / (active[i].items.length * active[j].items.length);
        if (d < best) {
          best = d;
          bi = i;
          bj = j;
        }
      }
    }
    const merged: Cluster = {
      items: [...active[bi].items, ...active[bj].items],
      left: active[bi],
      right: active[bj]
    };
    active.splice(Math.max(bi, bj), 1);
    active.splice(Math.min(bi, bj), 1);
    active.push(merged);
  }
  return active[0];
}

function leafOrder(c: Cluster): number[] {
  if (!c.left || !c.right) return c.items;
  return [...leafOrder(c.left), ...leafOrder(c.right)];
}

export function hrpWeights(series: number[][]): number[] {
  const n = series.length;
  const cov = covarianceMatrix(series);
  const vols = cov.map((row, i) => Math.sqrt(Math.max(row[i], 1e-12)));
  const corrM = corrMatrix(series);
  const root = buildTree(corrM);
  const order = leafOrder(root);
  const w = new Array(n).fill(1);

  const clusterVar = (items: number[]): number => {
    if (items.length === 1) return vols[items[0]] ** 2;
    const ivp = items.map((i) => 1 / vols[i]);
    const s = ivp.reduce((a, b) => a + b, 0);
    let v = 0;
    for (const i of items) {
      for (const j of items) {
        v += (ivp[i] / s) * (ivp[j] / s) * cov[i][j];
      }
    }
    return v;
  };

  const bisect = (items: number[]): void => {
    if (items.length <= 1) return;
    const half = Math.floor(items.length / 2);
    const left = items.slice(0, half);
    const right = items.slice(half);
    const vl = clusterVar(left);
    const vr = clusterVar(right);
    const alpha = vl + vr > 0 ? 1 - vl / (vl + vr) : 0.5;
    for (const i of left) w[i] *= alpha;
    for (const i of right) w[i] *= 1 - alpha;
    bisect(left);
    bisect(right);
  };

  bisect(order);
  const s = w.reduce((a, b) => a + b, 0);
  return w.map((v) => v / s);
}

/** 组合年化波动率 */
export function portfolioVol(w: number[], cov: Mat): number {
  const v = matvec(cov, w);
  return Math.sqrt(Math.max(w.reduce((s, wi, i) => s + wi * v[i], 0), 0));
}
