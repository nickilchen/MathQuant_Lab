/** 稠密矩阵与对称矩阵 Jacobi 特征分解 */

export type Mat = number[][];

export function zeros(m: number, n: number): Mat {
  return Array.from({ length: m }, () => new Array(n).fill(0));
}

export function eye(n: number): Mat {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
}

export function transpose(a: Mat): Mat {
  return a[0].map((_, j) => a.map((row) => row[j]));
}

export function matmul(a: Mat, b: Mat): Mat {
  const m = a.length;
  const n = b[0].length;
  const k = b.length;
  const out = zeros(m, n);
  for (let i = 0; i < m; i++) {
    for (let p = 0; p < k; p++) {
      const av = a[i][p];
      if (av === 0) continue;
      for (let j = 0; j < n; j++) out[i][j] += av * b[p][j];
    }
  }
  return out;
}

export function matvec(a: Mat, v: number[]): number[] {
  return a.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
}

/**
 * 协方差矩阵。series[i] 为第 i 个变量的时间序列（长度 T），输出 n×n。
 */
export function covarianceMatrix(series: number[][], ddof = 1): Mat {
  const n = series.length;
  const T = series[0]?.length ?? 0;
  const means = series.map((s) => s.reduce((a, b) => a + b, 0) / Math.max(T, 1));
  const out = zeros(n, n);
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let s = 0;
      for (let t = 0; t < T; t++) s += (series[i][t] - means[i]) * (series[j][t] - means[j]);
      const v = s / Math.max(T - ddof, 1);
      out[i][j] = v;
      out[j][i] = v;
    }
  }
  return out;
}

export interface EigenResult {
  /** 特征值，按降序排列 */
  values: number[];
  /** vectors[i][j] = 第 i 个分量、第 j 个特征向量（与 values[j] 对应） */
  vectors: Mat;
}

/**
 * 循环 Jacobi 特征分解（对称矩阵，Numerical Recipes 变体）。
 * 收敛后对角线即特征值，V 的列为对应特征向量。
 */
export function jacobiEigen(input: Mat, maxSweeps = 100, tol = 1e-12): EigenResult {
  const n = input.length;
  const a: Mat = input.map((r) => r.slice());
  const v: Mat = eye(n);

  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += a[i][j] * a[i][j];
    if (off < tol) break;

    for (let p = 0; p < n - 1; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p][q];
        if (Math.abs(apq) < 1e-300) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * apq);
        const sgn = theta >= 0 ? 1 : -1;
        const t = sgn / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        const tau = s / (1 + c);

        a[p][p] -= t * apq;
        a[q][q] += t * apq;
        a[p][q] = 0;
        a[q][p] = 0;
        for (let k = 0; k < n; k++) {
          if (k === p || k === q) continue;
          const g = a[k][p];
          const h = a[k][q];
          a[k][p] = g - s * (h + g * tau);
          a[p][k] = a[k][p];
          a[k][q] = h + s * (g - h * tau);
          a[q][k] = a[k][q];
        }
        for (let k = 0; k < n; k++) {
          const g = v[k][p];
          const h = v[k][q];
          v[k][p] = g - s * (h + g * tau);
          v[k][q] = h + s * (g - h * tau);
        }
      }
    }
  }

  const idx = Array.from({ length: n }, (_, i) => i).sort((x, y) => a[y][y] - a[x][x]);
  return {
    values: idx.map((i) => a[i][i]),
    // vectors[i][j] = 第 i 个分量、第 j 个特征向量（v 的列为特征向量，按特征值降序重排）
    vectors: Array.from({ length: n }, (_, i) => idx.map((j) => v[i][j]))
  };
}
