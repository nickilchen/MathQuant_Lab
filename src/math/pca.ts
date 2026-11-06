/**
 * PCA 因子模型与残差均值回归统计套利
 *  标准化收益矩阵 Z → 协方差 Σ → Jacobi 特征分解 → 前 K 主成分
 *  残差 e_t = Z_t − V_K·F_t，对残差 z-score 做均值回归交易
 */
import { jacobiEigen, covarianceMatrix, type Mat } from './linalg';
import { mean, std } from './stats';

export interface PcaResult {
  /** 特征值降序 */
  eigenvalues: number[];
  /** 累计解释方差比例 */
  explained: number[];
  /** 载荷：loadings[i][j] = 资产 i 在第 j 个因子上的载荷 */
  loadings: number[][];
  /** 因子得分：scores[t][j] */
  scores: number[][];
  /** 残差：residuals[t][i]（时间 × 资产） */
  residuals: number[][];
  means: number[];
  stds: number[];
}

export function pca(series: number[][], k: number): PcaResult {
  const n = series.length;
  const T = series[0].length;
  const means = series.map((s) => mean(s));
  const stds = series.map((s) => Math.max(std(s), 1e-8));
  const Z = series.map((row, i) => row.map((v) => (v - means[i]) / stds[i]));
  const cov = covarianceMatrix(Z);
  const { values, vectors } = jacobiEigen(cov);
  const total = values.reduce((a, b) => a + Math.max(b, 0), 0) || 1;
  const explained = values.map((v) => Math.max(v, 0) / total);
  const kk = Math.max(1, Math.min(k, n));

  const loadings: number[][] = Array.from({ length: n }, (_, i) =>
    Array.from({ length: kk }, (_, j) => vectors[i][j])
  );
  const scores: number[][] = Array.from({ length: T }, (_, t) =>
    Array.from({ length: kk }, (_, j) => {
      let s = 0;
      for (let i = 0; i < n; i++) s += Z[i][t] * vectors[i][j];
      return s;
    })
  );
  const residuals: number[][] = Array.from({ length: T }, (_, t) =>
    Z.map((row, i) => {
      let recon = 0;
      for (let j = 0; j < kk; j++) recon += scores[t][j] * vectors[i][j];
      return row[t] - recon;
    })
  );

  return { eigenvalues: values, explained, loadings, scores, residuals, means, stds };
}

export interface SpreadSignal {
  /** 每个时点的资产仓位 ∈ [-1,1]（负为做空） */
  positions: number[][];
  /** 每个时点的组合合成信号（多头减空头，示意） */
  composite: number[];
  zscores: number[][];
}

/**
 * 残差 z-score 均值回归：
 *   进入：|z| > entry → 反向建仓（z 高做空、z 低做多）
 *   退出：|z| < exit → 平仓
 */
export function residualMeanReversion(
  residuals: number[][],
  window = 20,
  entry = 1.5,
  exit = 0.5,
  scale = 2
): SpreadSignal {
  const T = residuals.length;
  const n = residuals[0].length;
  const zscores: number[][] = Array.from({ length: T }, () => new Array(n).fill(0));
  const positions: number[][] = Array.from({ length: T }, () => new Array(n).fill(0));
  const holding = new Array(n).fill(0);

  for (let t = 0; t < T; t++) {
    if (t >= window) {
      for (let i = 0; i < n; i++) {
        const win = residuals.slice(t - window, t).map((r) => r[i]);
        const m = mean(win);
        const s = std(win);
        zscores[t][i] = s > 1e-8 ? (residuals[t][i] - m) / s : 0;
      }
    }
    for (let i = 0; i < n; i++) {
      const z = zscores[t][i];
      if (holding[i] === 0) {
        if (z > entry) holding[i] = -1; // 残差过高 → 做空
        else if (z < -entry) holding[i] = 1; // 残差过低 → 做多
      } else if (Math.abs(z) < exit) {
        holding[i] = 0;
      }
      positions[t][i] = holding[i] * Math.max(0, Math.min(1, (Math.abs(z) - exit) / scale));
    }
  }

  const composite = positions.map((row) => {
    const longs = row.filter((p) => p > 0).reduce((a, b) => a + b, 0);
    const shorts = row.filter((p) => p < 0).reduce((a, b) => a - b, 0);
    return longs - shorts;
  });

  return { positions, composite, zscores };
}

/** 组合收益序列：仓位归一化到总暴露 1（多空中性） */
export function spreadPortfolioReturns(positions: number[][], returns: number[][]): number[] {
  const T = positions.length;
  const out: number[] = new Array(T).fill(0);
  for (let t = 1; t < T; t++) {
    const pos = positions[t - 1];
    const gross = pos.reduce((a, b) => a + Math.abs(b), 0);
    if (gross < 1e-8) {
      out[t] = 0;
      continue;
    }
    let r = 0;
    for (let i = 0; i < pos.length; i++) r += (pos[i] / gross) * returns[i][t];
    out[t] = r;
  }
  return out;
}

export type { Mat };
