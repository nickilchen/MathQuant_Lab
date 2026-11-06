import { describe, expect, it } from 'vitest';
import { analyzeTrend } from '../src/pipelines/trend';
import { adx, donchian, linReg, obv, corrTail } from '../src/math/indicators';
import type { Bar } from '../src/data/types';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 构造带趋势的日线 */
function makeBars(drift: number, vol: number, n = 300, seed = 7): Bar[] {
  const rnd = mulberry32(seed);
  const bars: Bar[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const open = p;
    p = p * Math.exp(drift + vol * (rnd() - 0.5) * 2);
    bars.push({
      date: `2025-01-${String((i % 28) + 1).padStart(2, '0')}`,
      open,
      close: p,
      high: Math.max(open, p) * 1.002,
      low: Math.min(open, p) * 0.998,
      volume: 1e6 * (0.8 + rnd() * 0.4),
      amount: 1e6 * p
    });
  }
  return bars;
}

describe('趋势法引擎', () => {
  it('强上升趋势 → 高分、多头排列、回归向上', () => {
    const bars = makeBars(0.002, 0.004, 300, 7); // 低噪声强趋势
    const r = analyzeTrend(bars);
    expect(r.score).toBeGreaterThan(65);
    expect(r.verdict === '强势上涨' || r.verdict === '温和上涨').toBe(true);
    expect(r.maAlignment).toBe('多头排列');
    expect(r.regression.direction).toBe('上升');
    expect(r.pos52).toBeGreaterThan(0.8);
    expect(r.adxLevel).toBe('强趋势');
  });

  it('噪声较大的上升趋势（近期回调）→ 仍应为正面评分', () => {
    const bars = makeBars(0.0012, 0.01, 300, 7);
    const r = analyzeTrend(bars);
    expect(r.score).toBeGreaterThan(50);
    expect(r.verdict === '强势上涨' || r.verdict === '温和上涨').toBe(true);
    expect(r.regression.direction).toBe('上升');
  });

  it('下降趋势 → 低分、回归向下', () => {
    const bars = makeBars(-0.0012, 0.01, 300, 11);
    const r = analyzeTrend(bars);
    expect(r.score).toBeLessThan(40);
    expect(r.verdict === '强势下跌' || r.verdict === '温和下跌').toBe(true);
    expect(r.regression.direction).toBe('下降');
  });

  it('震荡市 → 评分趋向 50 中枢', () => {
    const bars = makeBars(0, 0.008, 300, 23);
    const r = analyzeTrend(bars);
    expect(r.score).toBeGreaterThan(30);
    expect(r.score).toBeLessThan(70);
  });

  it('关键位关系合理：支撑<阻力、止损低于现价、目标高于现价', () => {
    const bars = makeBars(0.0005, 0.012, 300, 31);
    const r = analyzeTrend(bars);
    expect(r.support).toBeLessThan(r.resistance);
    expect(r.stopLoss).toBeLessThan(r.price);
    expect(r.target).toBeGreaterThan(r.price);
    expect(r.stopLoss).toBeGreaterThan(0);
  });

  it('ADX：强趋势高于震荡', () => {
    const strong = adx(makeBars(0.002, 0.004, 200, 5), 14);
    const chop = adx(makeBars(0, 0.01, 200, 9), 14);
    const lastStrong = strong.filter((v) => Number.isFinite(v)).slice(-1)[0];
    const lastChop = chop.filter((v) => Number.isFinite(v)).slice(-1)[0];
    expect(lastStrong).toBeGreaterThan(lastChop);
  });

  it('唐奇安通道：上轨≥中轨≥下轨，位置归一化', () => {
    const bars = makeBars(0.0005, 0.01, 100, 13);
    const dc = donchian(bars, 20);
    const i = bars.length - 1;
    expect(dc.upper[i]).toBeGreaterThanOrEqual(dc.mid[i]);
    expect(dc.mid[i]).toBeGreaterThanOrEqual(dc.lower[i]);
    const r = analyzeTrend(bars);
    expect(r.donchianPos).toBeGreaterThanOrEqual(0);
    expect(r.donchianPos).toBeLessThanOrEqual(1);
  });

  it('linReg：完美直线 R²=1 斜率正确', () => {
    const y = Array.from({ length: 50 }, (_, i) => 2 * i + 1);
    const { slope, intercept, r2 } = linReg(y);
    expect(slope).toBeCloseTo(2, 10);
    expect(intercept).toBeCloseTo(1, 10);
    expect(r2).toBeCloseTo(1, 10);
  });

  it('操作策略：强上升趋势给出买入计划与完整风控', () => {
    const bars = makeBars(0.002, 0.004, 300, 7);
    const r = analyzeTrend(bars);
    expect(['buy', 'hold']).toContain(r.strategy.action);
    expect(r.strategy.actionLabel).toBe('买入');
    expect(r.strategy.stars).toBeGreaterThanOrEqual(3);
    expect(r.strategy.entryZone[0]).toBeLessThanOrEqual(r.strategy.entryZone[1]);
    expect(r.strategy.stopLoss).toBeLessThan(r.price);
    expect(r.strategy.targets[0]).toBeGreaterThan(r.price);
    expect(r.strategy.buyTriggers.length).toBeGreaterThan(0);
    expect(r.strategy.sellTriggers.length).toBeGreaterThanOrEqual(3);
    expect(r.strategy.summary).toContain('止损');
    // 盈亏比必须为正
    expect(r.strategy.targets[0] - r.price).toBeGreaterThan(0);
  });

  it('操作策略：强下跌趋势给出卖出计划', () => {
    const bars = makeBars(-0.002, 0.004, 300, 11);
    const r = analyzeTrend(bars);
    expect(['sell', 'reduce']).toContain(r.strategy.action);
    expect(r.strategy.positionPct).toContain('0%');
    expect(r.strategy.summary).toContain('空仓');
  });

  it('七信号齐全且字段完整', () => {
    const bars = makeBars(0.0008, 0.008, 300, 21);
    const r = analyzeTrend(bars);
    expect(r.signals).toHaveLength(7);
    const keys = r.signals.map((x) => x.key);
    expect(keys).toEqual(['ma', 'cross', 'price', 'adx', 'donchian', 'regline', 'pv']);
    for (const sig of r.signals) {
      expect(sig.plain.length).toBeGreaterThan(10); // 小白解读非空
      expect(['bullish', 'bearish', 'neutral']).toContain(sig.status);
      expect(sig.stars).toBeGreaterThanOrEqual(0);
      expect(sig.stars).toBeLessThanOrEqual(3);
    }
  });

  it('OBV 与量价相关基本性质', () => {
    const bars = makeBars(0.0005, 0.01, 100, 17);
    const o = obv(bars);
    expect(o[0]).toBe(0);
    const c = corrTail(bars.map((b) => b.close), bars.map((b) => b.volume), 20);
    expect(c).toBeGreaterThanOrEqual(-1);
    expect(c).toBeLessThanOrEqual(1);
  });
});
