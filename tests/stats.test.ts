import { describe, expect, it } from 'vitest';
import { corr, mean, quantile, rankOf, std, variance, logReturns, maxDrawdown } from '../src/math/stats';

describe('stats', () => {
  it('mean / variance / std 基本正确', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(variance([1, 2, 3, 4])).toBeCloseTo(1.25, 10);
    expect(std([2, 2, 2])).toBe(0);
  });

  it('quantile 线性插值', () => {
    const s = [1, 2, 3, 4, 5];
    expect(quantile(s, 0)).toBe(1);
    expect(quantile(s, 1)).toBe(5);
    expect(quantile(s, 0.5)).toBe(3);
    expect(quantile(s, 0.25)).toBe(2);
  });

  it('rankOf 返回百分位', () => {
    expect(rankOf(3, [1, 2, 3, 4, 5])).toBeCloseTo(0.6, 10);
    expect(rankOf(0, [1, 2, 3])).toBe(0);
  });

  it('corr 完全正相关为 1', () => {
    const x = [1, 2, 3, 4, 5];
    expect(corr(x, x)).toBeCloseTo(1, 10);
    expect(corr(x, [...x].reverse())).toBeCloseTo(-1, 10);
  });

  it('logReturns 与 maxDrawdown', () => {
    const closes = [100, 110, 99, 120];
    const lr = logReturns(closes);
    expect(lr).toHaveLength(3);
    expect(lr[0]).toBeCloseTo(Math.log(1.1), 10);
    expect(maxDrawdown([1, 1.2, 0.9, 1.1])).toBeCloseTo(0.25, 10);
  });
});
