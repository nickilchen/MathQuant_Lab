import { describe, expect, it } from 'vitest';
import { DEFAULT_T0_CONFIG, amplitudeSeries, analyzeT0, t0Cost, type T0Config } from '../src/math/t0';
import { canFetchIntraday, parseIntraday } from '../src/data/intraday';
import type { Bar } from '../src/data/types';
import type { IntradaySnapshot } from '../src/data/intraday';

/** 造 n 根 K 线，每日振幅固定 amp% */
function mkBars(n = 60, amp = 3, start = 100): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const close = start + i * 0.05;
    const high = close * (1 + amp / 200);
    const low = close * (1 - amp / 200);
    const amount = close * 10000;
    out.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open: close, high, low, close, volume: 10000, amount });
  }
  return out;
}

function mkDay(o: { last: number; vwap: number; prevClose?: number; high: number; low: number }): IntradaySnapshot {
  const prevClose = o.prevClose ?? 100;
  return {
    code: 'sh600519',
    name: '测试股份',
    date: '20261104',
    points: [{ time: '15:00', price: o.last, volume: 100, amount: o.last * 100, vwap: o.vwap }],
    prevClose,
    open: o.low + (o.high - o.low) / 2,
    high: o.high,
    low: o.low,
    last: o.last
  };
}

describe('振幅序列', () => {
  it('按前收计算振幅百分比', () => {
    const r = amplitudeSeries(mkBars(30, 4), 20);
    expect(r.length).toBe(20);
    expect(r[0]).toBeCloseTo(4, 1);
  });

  it('数据不足也能返回一个较短序列', () => {
    expect(amplitudeSeries(mkBars(5), 20).length).toBe(4);
  });
});

describe('交易成本', () => {
  it('佣金未触及最低值时按费率算', () => {
    const c = t0Cost(1000, 100, DEFAULT_T0_CONFIG);
    // 双边佣金 50 + 印花税 50 + 过户费 2
    expect(c.amount).toBeCloseTo(102, 2);
    expect(c.perShare).toBeCloseTo(0.102, 4);
    expect(c.rate).toBeCloseTo(0.102, 3);
  });

  it('小资金被最低佣金吃掉：费率显著变高', () => {
    const c = t0Cost(100, 10, DEFAULT_T0_CONFIG);
    // 双边最低佣金 2×5=10，占成交额 1000 的 1%
    expect(c.amount).toBeCloseTo(10.52, 2);
    expect(c.rate).toBeGreaterThan(1);
  });

  it('零股数不崩', () => {
    expect(Number.isFinite(t0Cost(0, 100, DEFAULT_T0_CONFIG).amount)).toBe(true);
  });
});

describe('做 T 判定', () => {
  const bars = mkBars(60, 3);

  it('振幅已走满、剩余空间不足 → 不适合', () => {
    const day = mkDay({ last: 100, vwap: 100, high: 101.5, low: 98.5 });
    const a = analyzeT0(bars, day, DEFAULT_T0_CONFIG);
    expect(a.verdict).toBe('不适合');
    expect(a.score).toBeLessThanOrEqual(25);
    expect(a.plan).toBeNull();
  });

  it('现价高于均价且还有空间 → 倒 T', () => {
    // 已走振幅 1%，20 日均 3% → 剩余 2%
    const day = mkDay({ last: 101, vwap: 100, high: 100.7, low: 99.7, prevClose: 100 });
    const a = analyzeT0(bars, day, DEFAULT_T0_CONFIG);
    expect(a.verdict).toBe('倒T');
    expect(a.plan?.direction).toBe('倒T');
    expect(a.plan!.first[0]).toBeGreaterThan(a.vwap);
    expect(a.plan!.second[1]).toBeLessThan(a.vwap);
  });

  it('现价低于均价且还有空间 → 正 T', () => {
    const day = mkDay({ last: 99, vwap: 100, high: 100.3, low: 99.3, prevClose: 100 });
    const a = analyzeT0(bars, day, DEFAULT_T0_CONFIG);
    expect(a.verdict).toBe('正T');
    expect(a.plan?.direction).toBe('正T');
    expect(a.plan!.first[1]).toBeLessThan(a.vwap);
    expect(a.plan!.second[0]).toBeGreaterThan(a.vwap);
  });

  it('紧贴均价 → 观望', () => {
    const day = mkDay({ last: 100, vwap: 100, high: 100.5, low: 99.5, prevClose: 100 });
    expect(analyzeT0(bars, day, DEFAULT_T0_CONFIG).verdict).toBe('观望');
  });

  it('单边大涨 → 观望（防踏空）', () => {
    const day = mkDay({ last: 105, vwap: 100, high: 105.3, low: 99.8, prevClose: 100 });
    expect(analyzeT0(bars, day, DEFAULT_T0_CONFIG).verdict).toBe('观望');
  });

  it('底仓不足一手 → 不适合', () => {
    const day = mkDay({ last: 101, vwap: 100, high: 100.7, low: 99.7, prevClose: 100 });
    const a = analyzeT0(bars, day, { ...DEFAULT_T0_CONFIG, baseShares: 50 });
    expect(a.verdict).toBe('不适合');
    expect(a.shares).toBe(0);
  });

  it('做 T 数量向下取整到 100 股且不超过底仓', () => {
    const day = mkDay({ last: 101, vwap: 100, high: 100.7, low: 99.7, prevClose: 100 });
    const cfg: T0Config = { ...DEFAULT_T0_CONFIG, baseShares: 1234, tRatio: 0.3 };
    const a = analyzeT0(bars, day, cfg);
    expect(a.shares).toBe(300);
    expect(a.shares).toBeLessThanOrEqual(cfg.baseShares);
  });

  it('净收益 = 毛收益 - 费用', () => {
    const day = mkDay({ last: 101, vwap: 100, high: 100.7, low: 99.7, prevClose: 100 });
    const a = analyzeT0(bars, day, DEFAULT_T0_CONFIG);
    expect(a.expectedNet).toBeCloseTo(a.expectedGross - a.costAmount, 4);
  });

  it('结论包含成本与判定', () => {
    const day = mkDay({ last: 101, vwap: 100, high: 100.7, low: 99.7, prevClose: 100 });
    const a = analyzeT0(bars, day, DEFAULT_T0_CONFIG);
    expect(a.lines.join('')).toContain('每股至少赚');
    expect(a.lines.join('')).toContain(a.verdict);
    expect(a.costPerShare).toBeGreaterThan(0);
  });
});

describe('分时解析与市场支持', () => {
  it('A 股累计量是手：VWAP 由额/(量×100) 推出', () => {
    const json = {
      code: 0,
      data: {
        sh600519: {
          data: { date: '20261104', data: ['0930 100.00 10 100000', '0931 101.00 20 201000'] },
          qt: { sh600519: ['1', '测试', '600519', '101', '100', '100', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '20261104150000', '1', '1', '101', '99'] }
        }
      }
    };
    const d = parseIntraday(json, 'sh600519');
    expect(d.points.length).toBe(2);
    expect(d.points[0].vwap).toBeCloseTo(100, 4);
    expect(d.points[1].vwap).toBeCloseTo(100.5, 4);
    expect(d.prevClose).toBe(100);
    expect(d.high).toBe(101);
  });

  it('港股累计量是股：单位自动推断', () => {
    const json = {
      code: 0,
      data: {
        hk00700: {
          data: { date: '20261104', data: ['0930 400.00 1000 400000', '0931 401.00 2000 801000'] },
          qt: { hk00700: [] }
        }
      }
    };
    const d = parseIntraday(json, 'hk00700');
    expect(d.points[0].vwap).toBeCloseTo(400, 4);
    expect(d.points[1].vwap).toBeCloseTo(400.5, 4);
  });

  it('只支持 A 股与港股分时', () => {
    expect(canFetchIntraday('sh600519')).toBe(true);
    expect(canFetchIntraday('hk00700')).toBe(true);
    expect(canFetchIntraday('usAAPL')).toBe(false);
    expect(canFetchIntraday('jp7203')).toBe(false);
  });
});
