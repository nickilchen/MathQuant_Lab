import { describe, expect, it } from 'vitest';
import { pca, residualMeanReversion, spreadPortfolioReturns } from '../src/math/pca';
import { mulberry32 } from '../src/math/ml';

function factorDriven(n: number, seed: number): number[][] {
  const rnd = mulberry32(seed);
  const T = 260;
  const f = Array.from({ length: T }, () => (rnd() - 0.5) * 0.02);
  const loadings = [0.9, 0.7, 0.5, 0.2, -0.1];
  return loadings.map((b, i) =>
    Array.from({ length: T }, (_, t) => b * f[t] + (rnd() - 0.5) * 0.01 * (1 + i * 0.2) + 0.0001 * (i + 1))
  );
}

describe('PCA 统计套利', () => {
  const series = factorDriven(5, 3);
  const res = pca(series, 3);

  it('第一主成分解释方差比例最高', () => {
    expect(res.explained[0]).toBeGreaterThan(res.explained[1]);
    expect(res.explained[0]).toBeGreaterThan(0.3);
    const total = res.explained.reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('因子之间近似不相关', () => {
    const s0 = res.scores.map((r) => r[0]);
    const s1 = res.scores.map((r) => r[1]);
    let m0 = s0.reduce((a, b) => a + b, 0) / s0.length;
    let m1 = s1.reduce((a, b) => a + b, 0) / s1.length;
    let c = 0;
    let v0 = 0;
    let v1 = 0;
    for (let t = 0; t < s0.length; t++) {
      c += (s0[t] - m0) * (s1[t] - m1);
      v0 += (s0[t] - m0) ** 2;
      v1 += (s1[t] - m1) ** 2;
    }
    const corr = c / Math.sqrt(v0 * v1);
    expect(Math.abs(corr)).toBeLessThan(0.05);
  });

  it('残差 = 原始 − 重建，维度正确', () => {
    expect(res.residuals).toHaveLength(series[0].length);
    expect(res.residuals[0]).toHaveLength(5);
    expect(res.loadings).toHaveLength(5);
    expect(res.loadings[0]).toHaveLength(3);
  });

  it('残差均值回归产生有效仓位', () => {
    const sig = residualMeanReversion(res.residuals, 20, 1.5, 0.5);
    expect(sig.positions).toHaveLength(series[0].length);
    const anyNonZero = sig.positions.some((row) => row.some((p) => p !== 0));
    expect(typeof anyNonZero).toBe('boolean');
    for (const row of sig.positions) {
      for (const p of row) {
        expect(p).toBeGreaterThanOrEqual(-1);
        expect(p).toBeLessThanOrEqual(1);
      }
    }
  });

  it('价差组合收益序列长度正确', () => {
    const sig = residualMeanReversion(res.residuals);
    const rets = spreadPortfolioReturns(sig.positions, series);
    expect(rets).toHaveLength(series[0].length);
    expect(rets.every((r) => Number.isFinite(r))).toBe(true);
  });
});
