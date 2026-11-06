import { describe, expect, it } from 'vitest';
import {
  alignByDate,
  correlationMatrix,
  dailyReturns,
  normalizeToBase,
  pearson,
  relativeStrength
} from '../src/math/compare';
import type { Bar } from '../src/data/types';

const bar = (date: string, close: number): Bar => ({
  date,
  open: close,
  close,
  high: close,
  low: close,
  volume: 1,
  amount: 1
});

describe('多标的对比', () => {
  it('按日期取交集对齐，不按下标硬对齐', () => {
    const a = [bar('2024-01-02', 10), bar('2024-01-03', 11), bar('2024-01-04', 12)];
    const b = [bar('2024-01-03', 20), bar('2024-01-04', 22), bar('2024-01-05', 24)];
    const r = alignByDate([
      { code: 'A', bars: a },
      { code: 'B', bars: b }
    ]);
    expect(r.dates).toEqual(['2024-01-03', '2024-01-04']);
    expect(r.series[0].closes).toEqual([11, 12]);
    expect(r.series[1].closes).toEqual([20, 22]);
  });

  it('空输入返回空结果而不是抛错', () => {
    expect(alignByDate([])).toEqual({ dates: [], series: [] });
    expect(alignByDate([{ code: 'A', bars: [] }])).toEqual({ dates: [], series: [] });
  });

  it('归一化到起点 1', () => {
    expect(normalizeToBase([2, 4, 3])).toEqual([1, 2, 1.5]);
  });

  it('零基价不产生 Infinity / NaN', () => {
    expect(normalizeToBase([0, 1])).toEqual([1, 1]);
    expect(normalizeToBase([])).toEqual([]);
  });

  it('日收益率长度为 n-1', () => {
    const r = dailyReturns([100, 110, 99]);
    expect(r).toHaveLength(2);
    expect(r[0]).toBeCloseTo(0.1, 10);
  });

  it('同比例缩放的价格序列收益完全相同，相关系数为 1', () => {
    const a = [1, 2, 3, 4, 5];
    expect(pearson(dailyReturns(a), dailyReturns(a.map((v) => v * 2)))).toBeCloseTo(1, 10);
  });

  it('收益率整体反号时相关系数为 -1', () => {
    const r = dailyReturns([1, 2, 3, 4, 5]);
    expect(pearson(r, r.map((v) => -v))).toBeCloseTo(-1, 10);
  });

  it('常量序列返回 0 而不是 NaN', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBe(0);
    expect(pearson([1], [1])).toBe(0);
  });

  it('相关系数矩阵对角为 1 且对称', () => {
    const closes = [
      [10, 11, 12, 11, 13],
      [20, 19, 21, 22, 21],
      [5, 6, 5, 7, 8]
    ];
    const m = correlationMatrix(closes);
    expect(m).toHaveLength(3);
    m.forEach((row, i) => {
      expect(row[i]).toBe(1);
      row.forEach((v, j) => expect(v).toBeCloseTo(m[j][i], 10));
    });
  });

  it('相对强弱归一化到 1 并反映跑赢', () => {
    const rs = relativeStrength([10, 20], [10, 10]);
    expect(rs[0]).toBe(1);
    expect(rs[1]).toBe(2);
  });
});
