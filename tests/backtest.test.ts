import { describe, expect, it } from 'vitest';
import { DEFAULT_BT, runBacktest } from '../src/math/backtest';
import { mulberry32 } from '../src/math/ml';

const dates = Array.from({ length: 120 }, (_, i) => `2024-01-${String((i % 28) + 1).padStart(2, '0')}`);
const close = Array.from({ length: 120 }, (_, i) => 100 * Math.exp(0.0005 * i));

describe('回测引擎', () => {
  it('空仓时收益恒为 0（不计首笔建仓成本）', () => {
    const pos = new Array(120).fill(0);
    const r = runBacktest(dates, close, pos, DEFAULT_BT);
    expect(r.equity[119]).toBeCloseTo(1, 12);
    expect(r.metrics.maxDD).toBeCloseTo(0, 12);
  });

  it('满仓行情下净值与基准一致（成本为 0 时严格相等）', () => {
    const pos = new Array(120).fill(1);
    const r = runBacktest(dates, close, pos, DEFAULT_BT);
    expect(r.metrics.totalReturn).toBeGreaterThan(0);
    expect(r.equity[119]).toBeLessThanOrEqual(r.benchmark[119] + 1e-12);
  });

  it('成本为 0 时满仓收益等于基准', () => {
    const pos = new Array(120).fill(1);
    const r = runBacktest(dates, close, pos, { buyBps: 0, sellBps: 0, stampBps: 0 });
    expect(r.equity[119]).toBeCloseTo(r.benchmark[119], 10);
  });

  it('满仓噪声行情下 beta ≈ 1', () => {
    const n = 200;
    const r2 = mulberry32(77);
    const walk: number[] = [100];
    for (let i = 1; i < n; i++) walk.push(walk[i - 1] * (1 + (r2() - 0.5) * 0.02));
    const ds = Array.from({ length: n }, (_, i) => `d${i}`);
    const res = runBacktest(ds, walk, new Array(n).fill(1), { buyBps: 0, sellBps: 0, stampBps: 0 });
    expect(res.metrics.beta).toBeCloseTo(1, 6);
    expect(res.metrics.sharpe).not.toBe(0);
  });

  it('完美择时显著跑赢买入持有', () => {
    // 锯齿行情：偶数日 100、奇数日 101
    const zig = Array.from({ length: 120 }, (_, i) => 100 * (i % 2 === 0 ? 1 : 1.01));
    // position[t] 作用于 t→t+1 收益：偶数日持有可捕获上涨
    const pos = zig.map((_, i) => (i % 2 === 0 ? 1 : 0));
    const r = runBacktest(dates, zig, pos, { buyBps: 0, sellBps: 0, stampBps: 0 });
    expect(r.equity[119]).toBeGreaterThan(zig[119] / zig[0]);
    expect(r.equity[119]).toBeCloseTo(1.01 ** 60, 6);
  });

  it('换手成本计入 turnover', () => {
    const pos = Array.from({ length: 120 }, (_, i) => (i % 2 === 0 ? 0 : 1));
    const r = runBacktest(dates, close, pos, DEFAULT_BT);
    expect(r.metrics.turnover).toBeGreaterThan(100);
  });

  it('负收益行情的最大回撤被正确捕捉', () => {
    const falling = Array.from({ length: 60 }, (_, i) => 100 * Math.exp(-0.01 * i));
    const r = runBacktest(
      Array.from({ length: 60 }, (_, i) => `d${i}`),
      falling,
      new Array(60).fill(1),
      { buyBps: 0, sellBps: 0, stampBps: 0 }
    );
    expect(r.metrics.maxDD).toBeGreaterThan(0.4);
    expect(r.metrics.totalReturn).toBeLessThan(0);
  });
});
