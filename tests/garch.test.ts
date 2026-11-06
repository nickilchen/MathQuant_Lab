import { describe, expect, it } from 'vitest';
import { fitGarch11 } from '../src/math/garch';
import { mulberry32 } from '../src/math/ml';

function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

describe('GARCH(1,1)', () => {
  it('从已知 GARCH 过程估计出接近的 α、β', () => {
    const rnd = mulberry32(99);
    const n = 1500;
    const om = 0.000004;
    const a = 0.09;
    const b = 0.88;
    const r: number[] = [];
    let s2 = 0.0001;
    for (let t = 0; t < n; t++) {
      const e = gauss(rnd);
      r.push(Math.sqrt(s2) * e);
      s2 = om + a * s2 * e * e + b * s2;
    }
    const res = fitGarch11(r);
    expect(res.alpha).toBeGreaterThan(0.03);
    expect(res.alpha).toBeLessThan(0.2);
    expect(res.beta).toBeGreaterThan(0.75);
    expect(res.persistence).toBeLessThan(1);
    expect(res.forecast).toBeGreaterThan(0);
    expect(res.sigma.every((s) => s > 0)).toBe(true);
  });

  it('白噪声上 α+β 仍保持平稳', () => {
    const rnd = mulberry32(5);
    const r = Array.from({ length: 400 }, () => gauss(rnd) * 0.01);
    const res = fitGarch11(r);
    expect(res.persistence).toBeLessThan(1);
    expect(Number.isFinite(res.loglik)).toBe(true);
  });
});
