import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOM,
  buildMomentumReport,
  momentumPositions,
  momentumScore,
  momReturn,
  positionSize,
  rollingVol,
  windowReturns,
  type MomParams
} from '../src/math/momentum';
import { DEFAULT_BT } from '../src/math/backtest';
import type { Bar } from '../src/data/types';

const P = (patch: Partial<MomParams> = {}): MomParams => ({ ...DEFAULT_MOM, maLen: 0, ...patch });

/** 等比序列：每日固定涨幅 */
const geo = (n: number, rate: number): number[] => Array.from({ length: n }, (_, i) => 100 * Math.pow(1 + rate, i));

/** 上涨后转为小幅回落，用于检验滞后带 */
const riseThenDrift = (): number[] => {
  const up = geo(41, 0.01);
  const last = up[up.length - 1];
  const down = Array.from({ length: 30 }, (_, i) => last * Math.pow(1 - 0.0005, i + 1));
  return [...up, ...down];
};

const barsOf = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({
    date: '2024-' + String(i + 1).padStart(4, '0'),
    open: c,
    close: c,
    high: c,
    low: c,
    volume: 1,
    amount: 1
  }));

describe('区间动量', () => {
  it('按回看窗口计算累计收益', () => {
    expect(momReturn([100, 110, 121], 2, 2, 0)).toBeCloseTo(0.21, 10);
  });

  it('skip 参数跳过最近 N 日', () => {
    expect(momReturn([100, 110, 121], 2, 1, 1)).toBeCloseTo(0.1, 10);
  });

  it('历史不足时返回 0 而不是抛错', () => {
    expect(momReturn([100, 110], 1, 5, 0)).toBe(0);
    expect(momReturn([], 0, 5, 0)).toBe(0);
    expect(momReturn([0, 10], 1, 1, 0)).toBe(0);
  });
});

describe('波动率与仓位规模', () => {
  it('等比序列波动近似为 0', () => {
    expect(rollingVol(geo(40, 0.002), 39, 20)).toBeLessThan(1e-6);
  });

  it('波动越大的标的目标仓位越小', () => {
    const calm = Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.0005 * Math.sin(i)));
    const wild = Array.from({ length: 80 }, (_, i) => 100 * (1 + 0.05 * Math.sin(i)));
    const p = P({ targetVol: 0.15 });
    const calmSize = positionSize(calm, 79, p);
    const wildSize = positionSize(wild, 79, p);
    expect(wildSize).toBeLessThan(calmSize);
    expect(wildSize).toBeGreaterThan(0);
    expect(calmSize).toBeLessThanOrEqual(1);
  });

  it('关闭波动率目标时直接给满上限', () => {
    expect(positionSize(geo(40, 0.01), 39, P({ targetVol: 0 }))).toBe(1);
  });
});

describe('仓位信号', () => {
  it('单边上涨：预热期空仓，之后满仓', () => {
    const closes = geo(80, 0.002);
    const pos = momentumPositions(closes, P({ lookback: 20, skip: 0, entry: 0.02, exit: -0.02, targetVol: 0 }));
    expect(pos).toHaveLength(80);
    expect(pos.slice(0, 20).every((v) => v === 0)).toBe(true);
    expect(pos[79]).toBe(1);
  });

  it('单边下跌：始终空仓', () => {
    const closes = geo(80, -0.002);
    const pos = momentumPositions(closes, P({ lookback: 20, skip: 0, entry: 0.02, exit: -0.02, targetVol: 0 }));
    expect(pos.every((v) => v === 0)).toBe(true);
  });

  it('滞后带：小幅回落未跌破 exit 时继续持有', () => {
    const closes = riseThenDrift();
    const hold = momentumPositions(closes, P({ lookback: 20, skip: 0, entry: 0.02, exit: -0.02, targetVol: 0 }));
    const flat = momentumPositions(closes, P({ lookback: 20, skip: 0, entry: 0.02, exit: 0, targetVol: 0 }));
    expect(hold[60]).toBeGreaterThan(0);
    expect(flat[60]).toBe(0);
  });

  it('趋势过滤：跌破长均线强制空仓', () => {
    const closes = [...geo(120, 0.003), ...Array.from({ length: 40 }, () => 0)].map((v, i) =>
      v === 0 ? 100 : v
    );
    const withMa = momentumPositions(closes, P({ lookback: 20, skip: 0, maLen: 100, entry: 0.0, exit: -0.9, targetVol: 0 }));
    expect(withMa[withMa.length - 1]).toBe(0);
  });

  it('仓位始终落在 [0, cap] 且无 NaN', () => {
    const closes = Array.from({ length: 200 }, (_, i) => 100 * (1 + 0.08 * Math.sin(i / 7) + 0.02 * Math.cos(i / 3)));
    const pos = momentumPositions(closes, P({ cap: 0.8 }));
    for (const v of pos) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0.8);
    }
  });
});

describe('报告组装', () => {
  it('净值长度与行情对齐，指标有限，趋势市有交易', () => {
    const closes = geo(300, 0.0015);
    const r = buildMomentumReport(barsOf(closes), P({ lookback: 63, skip: 5, targetVol: 0 }), DEFAULT_BT);
    expect(r.dates).toHaveLength(300);
    expect(r.positions).toHaveLength(300);
    expect(r.bt.equity).toHaveLength(300);
    expect(Number.isFinite(r.bt.metrics.totalReturn)).toBe(true);
    expect(r.bt.metrics.totalReturn).toBeGreaterThan(0);
    expect(r.tradeCount).toBeGreaterThan(0);
    expect(r.verdict).toBe('bull');
    expect(r.score).toBeGreaterThan(50);
  });

  it('分周期动量表返回 4 个窗口', () => {
    const w = windowReturns(geo(300, 0.001), 299);
    expect(w).toHaveLength(4);
    expect(w[0].days).toBe(21);
    w.forEach((x) => {
      expect(Number.isFinite(x.ret)).toBe(true);
      expect(Number.isFinite(x.ann)).toBe(true);
    });
  });

  it('下跌市给出空头结论且空仓', () => {
    const r = buildMomentumReport(barsOf(geo(300, -0.001)), P({ lookback: 63, skip: 5 }), DEFAULT_BT);
    expect(r.held).toBe(false);
    expect(r.currentPos).toBe(0);
    expect(r.verdict).toBe('bear');
  });

  it('动量分限制在 0~100', () => {
    const closes = geo(300, 0.004);
    expect(momentumScore(closes, 299, P())).toBeLessThanOrEqual(100);
    expect(momentumScore(closes, 10, P())).toBeGreaterThanOrEqual(0);
  });
});
