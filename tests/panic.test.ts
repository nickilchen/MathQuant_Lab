import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/data/types';
import { DEFAULT_PANIC_CONFIG, analyzePanic, panicStats } from '../src/math/panic';

function flatBars(n = 60): Bar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1e6,
    amount: 1e8
  }));
}

/** 在指定位置放一根大跌，之后按 fwd 收益走 */
function withDrop(n: number, idx: number, dropPct: number, fwd: number[], volume = 3e6): Bar[] {
  const bars = flatBars(n);
  bars[idx] = {
    ...bars[idx],
    open: 100,
    high: 100,
    low: 100 * (1 - dropPct / 100) - 1,
    close: 100 * (1 - dropPct / 100),
    volume
  };
  let prev = bars[idx].close;
  fwd.forEach((r, k) => {
    const j = idx + 1 + k;
    if (j >= n) return;
    prev = prev * (1 + r / 100);
    bars[j] = { ...bars[j], close: prev, high: prev * 1.005, low: prev * 0.995 };
  });
  return bars;
}

describe('恐慌抄底：历史统计', () => {
  it('只统计跌幅达标的样本，并算对后续收益', () => {
    const bars = withDrop(60, 40, 8, [2, 1, 0.5]);
    const s = panicStats(bars, 5, [1, 3], 0);
    expect(s[0].samples).toBe(1);
    expect(s[0].winRate).toBe(100);
    expect(s[0].avg).toBeCloseTo(2, 1);
    expect(s[1].samples).toBe(1);
    expect(s[1].avg).toBeGreaterThan(3);
  });

  it('跌幅没到门槛不计入样本', () => {
    const bars = withDrop(60, 40, 2, [2]);
    expect(panicStats(bars, 5, [1], 0)[0].samples).toBe(0);
  });

  it('entryDelay=1 按次日买入计算，收益不同', () => {
    const bars = withDrop(60, 40, 8, [2, 1, 0.5]);
    const same = panicStats(bars, 5, [1], 0)[0];
    const next = panicStats(bars, 5, [1], 1)[0];
    expect(same.samples).toBe(1);
    expect(next.samples).toBe(1);
    expect(next.avg).toBeCloseTo(1, 1);
  });

  it('没有样本时返回 0，而不是 NaN', () => {
    const s = panicStats(flatBars(60), 5, [1, 3, 5], 0);
    expect(s.every((x) => x.samples === 0 && Number.isFinite(x.avg))).toBe(true);
  });
});

describe('恐慌抄底：评分与计划', () => {
  it('大跌 + 放量 + 超卖 → 触发，给计划', () => {
    const bars = flatBars(60);
    bars[59] = { ...bars[59], open: 100, high: 100, low: 91, close: 92, volume: 3.5e6 };
    const a = analyzePanic(bars, DEFAULT_PANIC_CONFIG, 100)!;
    expect(a).not.toBeNull();
    expect(a.drop).toBeCloseTo(8, 1);
    expect(a.triggered).toBe(true);
    expect(a.score).toBeGreaterThanOrEqual(60);
    expect(a.plan).not.toBeNull();
    expect(a.plan!.stop).toBeLessThan(a.plan!.entryLow);
    expect(a.plan!.target1).toBeGreaterThan(a.plan!.entryHigh);
  });

  it('小跌不触发', () => {
    const bars = flatBars(60);
    bars[59] = { ...bars[59], close: 99, low: 98.5, high: 100 };
    const a = analyzePanic(bars, DEFAULT_PANIC_CONFIG, 100)!;
    expect(a.triggered).toBe(false);
    expect(a.plan).toBeNull();
  });

  it('跌幅到了但没放量、没超卖 → 评分不足，不触发', () => {
    const bars = flatBars(60);
    bars[59] = { ...bars[59], open: 100, high: 100, low: 96.5, close: 96.6, volume: 1.05e6 };
    const a = analyzePanic(bars, { ...DEFAULT_PANIC_CONFIG, volumeRatio: 1.5 }, 100)!;
    expect(a.drop).toBeGreaterThan(3);
    expect(a.triggered).toBe(false);
    expect(a.plan).toBeNull();
  });

  it('样本不足返回 null', () => {
    expect(analyzePanic(flatBars(40), DEFAULT_PANIC_CONFIG)).toBeNull();
  });
});
