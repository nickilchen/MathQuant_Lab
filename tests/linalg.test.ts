import { describe, expect, it } from 'vitest';
import { covarianceMatrix, jacobiEigen, matmul, matvec, transpose } from '../src/math/linalg';

describe('linalg', () => {
  it('jacobiEigen 还原已知特征值', () => {
    // 对称矩阵，特征值为 4 / 2 / 1
    const a = [
      [3, 1, 1],
      [1, 3, 1],
      [1, 1, 2]
    ];
    const { values } = jacobiEigen(a);
    expect(values[0]).toBeCloseTo(4.732, 2);
    expect(values[1]).toBeCloseTo(2, 1);
    expect(values[2]).toBeCloseTo(1.268, 2);
  });

  it('特征向量正交且可重构原矩阵', () => {
    const a = [
      [4, 1, 0],
      [1, 3, 1],
      [0, 1, 2]
    ];
    const { values, vectors } = jacobiEigen(a);
    // 正交性：V^T V = I
    const vt = transpose(vectors);
    const g = matmul(vt, vectors);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(g[i][j]).toBeCloseTo(i === j ? 1 : 0, 8);
      }
    }
    // 重构：A ≈ V diag(λ) V^T
    const diag = vectors.map((_, j) => vectors.map((__, i) => (i === j ? values[j] : 0)));
    const recon = matmul(matmul(vectors, diag), vt);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(recon[i][j]).toBeCloseTo(a[i][j], 6);
      }
    }
  });

  it('covarianceMatrix 对称且对角为正', () => {
    const s1 = [1, 2, 3, 4, 5];
    const s2 = [2, 4, 6, 8, 10];
    const cov = covarianceMatrix([s1, s2]);
    expect(cov[0][0]).toBeGreaterThan(0);
    expect(cov[0][1]).toBeCloseTo(cov[1][0], 12);
    expect(cov[0][1]).toBeGreaterThan(0);
  });

  it('matvec 基本运算', () => {
    expect(matvec([[1, 2], [3, 4]], [1, 1])).toEqual([3, 7]);
  });
});
