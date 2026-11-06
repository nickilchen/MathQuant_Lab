import { describe, expect, it } from 'vitest';
import { computeFactors, compositeSignal, factorPosition, FACTOR_DEFS } from '../src/math/factors';
import { genSyntheticBars } from '../src/data/synthetic';
import { SYMBOLS } from '../src/data/symbols';

const bars = genSyntheticBars(SYMBOLS[0], 400);
const bond = genSyntheticBars(SYMBOLS.find((s) => s.code === 'sh511010')!, 400);

describe('因子投票', () => {
  it('覆盖四大维度共 16+ 因子', () => {
    const dims = new Set(FACTOR_DEFS.map((f) => f.dim));
    expect(dims).toEqual(new Set(['估值', '情绪', '资金', '技术']));
    expect(FACTOR_DEFS.length).toBeGreaterThanOrEqual(16);
  });

  it('无资金流时资金维度自动降级为 0 且不报错', () => {
    const rep = computeFactors({ bars, fundFlow: null, bondBars: bond });
    const cap = rep.dims.find((d) => d.dim === '资金')!;
    expect(cap.count).toBe(0);
    expect(cap.score).toBe(0);
    expect(rep.values.length).toBeGreaterThan(5);
  });

  it('所有投票值在 [-1, 1]', () => {
    const rep = computeFactors({ bars, fundFlow: null, bondBars: bond });
    for (const v of rep.values) {
      expect(v.vote).toBeGreaterThanOrEqual(-1);
      expect(v.vote).toBeLessThanOrEqual(1);
    }
  });

  it('compositeSignal 加权平均', () => {
    const dims = [
      { dim: '估值' as const, score: 0.5, count: 3 },
      { dim: '情绪' as const, score: -0.5, count: 3 },
      { dim: '资金' as const, score: 0.5, count: 3 },
      { dim: '技术' as const, score: -0.5, count: 3 }
    ];
    const w = { 估值: 0.25, 情绪: 0.25, 资金: 0.25, 技术: 0.25 };
    expect(compositeSignal(dims, w)).toBeCloseTo(0, 10);
  });

  it('factorPosition 死区清零、区间外缩放', () => {
    const pos = factorPosition([0.1, 0.3, 0.8, -0.8, 0], 0.15);
    expect(pos[0]).toBe(0);
    expect(pos[1]).toBeGreaterThan(0);
    expect(pos[2]).toBeCloseTo(1, 6);
    expect(pos[3]).toBeCloseTo(-1, 6);
    expect(pos[4]).toBe(0);
  });
});
