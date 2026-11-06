import { describe, expect, it } from 'vitest';
import {
  ercWeights,
  hrpWeights,
  inverseVolWeights,
  portfolioVol,
  riskContributions,
  shrinkCov
} from '../src/math/riskparity';
import { covarianceMatrix, matvec } from '../src/math/linalg';

// 三资产：低波债、中波股、高波商品
function makeSeries(): number[][] {
  const rnd = (s: number) => {
    let a = s;
    return () => {
      a = (a * 1103515245 + 12345) % 2147483648;
      return a / 2147483648;
    };
  };
  const r1 = rnd(11);
  const r2 = rnd(22);
  const r3 = rnd(33);
  const n = 300;
  const bond = Array.from({ length: n }, () => (r1() - 0.5) * 0.002);
  const stock = Array.from({ length: n }, () => (r2() - 0.5) * 0.02 + 0.0002);
  const comm = Array.from({ length: n }, () => (r3() - 0.5) * 0.03);
  return [bond, stock, comm];
}

describe('风险平价', () => {
  const series = makeSeries();
  const cov = shrinkCov(series);

  it('ERC 权重和为 1 且风险贡献近似相等', () => {
    const w = ercWeights(cov);
    const s = w.reduce((a, b) => a + b, 0);
    expect(s).toBeCloseTo(1, 8);
    const rc = riskContributions(w, cov);
    const m = rc.reduce((a, b) => a + b, 0) / rc.length;
    const cv = Math.sqrt(rc.reduce((a, b) => a + (b - m) ** 2, 0) / rc.length) / m;
    expect(cv).toBeLessThan(0.01);
    // 低波资产权重应显著高于高波资产
    expect(w[0]).toBeGreaterThan(w[2]);
  });

  it('inverseVol 权重和为 1', () => {
    const vols = [0.01, 0.02, 0.04];
    const w = inverseVolWeights(vols);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(w[0]).toBeGreaterThan(w[2]);
  });

  it('HRP 权重和为 1 且非负', () => {
    const w = hrpWeights(series);
    expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 8);
    expect(w.every((x) => x >= 0)).toBe(true);
  });

  it('ERC 组合波动率不高于等权', () => {
    const raw = covarianceMatrix(series);
    const wErc = ercWeights(raw);
    const wEq = [1 / 3, 1 / 3, 1 / 3];
    expect(portfolioVol(wErc, raw)).toBeLessThanOrEqual(portfolioVol(wEq, raw) + 1e-9);
  });

  it('shrinkCov 保持对称、压缩非对角', () => {
    const raw = covarianceMatrix(series);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        expect(cov[i][j]).toBeCloseTo(cov[j][i], 12);
        if (i !== j) expect(Math.abs(cov[i][j])).toBeLessThanOrEqual(Math.abs(raw[i][j]) + 1e-12);
      }
    }
    // 正定性：m = cov·w > 0
    expect(matvec(cov, [1, 1, 1]).every((x) => x > 0)).toBe(true);
  });
});
