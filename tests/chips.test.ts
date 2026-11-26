import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHIP,
  analyzeChips,
  triWeights,
  turnoverSeries,
  type ChipConfig
} from '../src/math/chips';
import type { Bar } from '../src/data/types';

const CFG: ChipConfig = { ...DEFAULT_CHIP, lookback: 120, bins: 60 };

/** 构造日 K：价格、成交量、成交额（amount 与 volume 单位一致，令 implied = close） */
const barsOf = (closes: number[], vols?: number[]): Bar[] =>
  closes.map((c, i) => ({
    date: `2024-${String(i + 1).padStart(4, '0')}`,
    open: c,
    close: c,
    high: c * 1.005,
    low: c * 0.995,
    volume: vols?.[i] ?? 1000,
    amount: (vols?.[i] ?? 1000) * c
  }));

/** 横盘震荡：价格围绕中枢反复 */
const sideways = (n: number, base = 100): number[] =>
  Array.from({ length: n }, (_, i) => base * (1 + 0.03 * Math.sin(i / 3)));

describe('换手率代理', () => {
  it('均量附近时等于基准换手率', () => {
    const bars = barsOf(Array(30).fill(100), Array(30).fill(1000));
    const t = turnoverSeries(bars, CFG);
    expect(t[29]).toBeCloseTo(CFG.baseTurnover, 6);
  });

  it('放量日换手率高于缩量日，且夹在 [0,1]', () => {
    const vols = Array(30).fill(1000);
    vols[29] = 5000; // 今日放量 5 倍
    const t = turnoverSeries(barsOf(Array(30).fill(100), vols), CFG);
    expect(t[29]).toBeGreaterThan(t[28]);
    expect(t.every((x) => x >= 0 && x <= 1)).toBe(true);
  });

  it('极端放量时换手率不超过 1', () => {
    const vols = Array(30).fill(1000);
    vols[29] = 1000000;
    const t = turnoverSeries(barsOf(Array(30).fill(100), vols), CFG);
    expect(t[29]).toBeLessThanOrEqual(1);
  });
});

describe('三角形价格分配', () => {
  it('权重和为 1', () => {
    const grid = [10, 11, 12, 13, 14];
    const w = triWeights(10, 14, 12, grid);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
  });

  it('顶点处权重最大，两端为 0', () => {
    const grid = [10, 11, 12, 13, 14];
    const w = triWeights(10, 14, 12, grid);
    expect(w[2]).toBeGreaterThan(w[1]);
    expect(w[2]).toBeGreaterThan(w[3]);
    expect(w[0]).toBe(0);
    expect(w[4]).toBe(0);
  });

  it('区间外的价格权重为 0', () => {
    const grid = [8, 10, 12, 14, 16];
    const w = triWeights(10, 14, 12, grid);
    expect(w[0]).toBe(0);
    expect(w[4]).toBe(0);
    expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 10);
  });

  it('退化区间（高低相等）不产生 NaN', () => {
    const w = triWeights(10, 10, 10, [9, 10, 11]);
    expect(w.every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('筹码分布分析', () => {
  it('数据不足 30 根返回 null', () => {
    expect(analyzeChips(barsOf(sideways(20)), CFG)).toBeNull();
    expect(analyzeChips([], CFG)).toBeNull();
  });

  it('输出所有筹码占比求和为 1，累计末值为 1', () => {
    const r = analyzeChips(barsOf(sideways(100)), CFG)!;
    expect(r).not.toBeNull();
    expect(r.bins.reduce((s, b) => s + b.ratio, 0)).toBeCloseTo(1, 6);
    expect(r.bins[r.bins.length - 1].cumulative).toBeCloseTo(1, 6);
  });

  it('横盘时成本集中在价格中枢附近，获利盘中高', () => {
    const r = analyzeChips(barsOf(sideways(120, 100)), CFG)!;
    expect(r.avgCost).toBeGreaterThan(97);
    expect(r.avgCost).toBeLessThan(103);
    expect(r.costLow).toBeLessThan(r.costHigh);
    expect(r.concentration).toBeGreaterThanOrEqual(0);
    expect(r.concentration).toBeLessThanOrEqual(1);
  });

  it('单边上涨后现价高于平均成本、获利盘接近满仓', () => {
    const up = Array.from({ length: 120 }, (_, i) => 100 + i); // 100 → 219
    const r = analyzeChips(barsOf(up), CFG)!;
    expect(r.price).toBeGreaterThan(r.avgCost);
    expect(r.profitRatio).toBeGreaterThan(0.8);
    expect(r.verdict).toContain('获利');
  });

  it('单边下跌后现价低于平均成本、获利盘很低', () => {
    const down = Array.from({ length: 120 }, (_, i) => 220 - i); // 220 → 101
    const r = analyzeChips(barsOf(down), CFG)!;
    expect(r.price).toBeLessThan(r.avgCost);
    expect(r.profitRatio).toBeLessThan(0.2);
  });

  it('指标全部有限，结论非空', () => {
    const r = analyzeChips(barsOf(sideways(100, 50)), CFG)!;
    for (const k of ['avgCost', 'medianCost', 'costLow', 'costHigh', 'concentration', 'profitRatio'] as const) {
      expect(Number.isFinite(r[k])).toBe(true);
    }
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.shapeLabel.length).toBeGreaterThan(0);
    expect(r.verdict.length).toBeGreaterThan(0);
  });

  it('峰检测最多返回 3 个，按占比降序', () => {
    const mixed = [...sideways(60, 90), ...sideways(60, 130)];
    const r = analyzeChips(barsOf(mixed), CFG)!;
    expect(r.peaks.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < r.peaks.length; i++) {
      expect(r.peaks[i - 1].ratio).toBeGreaterThanOrEqual(r.peaks[i].ratio);
    }
  });

  it('bins 数量被夹在合理范围', () => {
    const r = analyzeChips(barsOf(sideways(60)), { ...CFG, bins: 999 });
    expect(r!.bins.length).toBeLessThanOrEqual(300);
  });
});
