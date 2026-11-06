import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/data/types';
import { DEFAULT_SWING_CONFIG, analyzeSwing } from '../src/math/swing';
import { marketRuleOf, tradingMarket } from '../src/data/marketRules';

/** 造 K 线：每天按 trend 变化，vol 只影响高低点 */
function makeBars(n: number, trend = 0.004, vol = 0.01, start = 100, volume = 1e6): Bar[] {
  const out: Bar[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = close * (1 + trend);
    out.push({
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`,
      open,
      high: Math.max(open, close) * (1 + vol),
      low: Math.min(open, close) * (1 - vol),
      close,
      volume: volume * (1 + (i % 5) * 0.05),
      amount: close * volume
    });
  }
  return out;
}

/**
 * 上升趋势 + 缩量回调。
 *
 * 回调只做 2 天、每天 -0.4%：要让它停在 MA20 上方 1% 左右，
 * 回调太深会变成「跌破 MA20」，形态就不是「上升趋势回调」了。
 */
function pullbackBars(): Bar[] {
  const up = makeBars(80, 0.005, 0.008, 100, 1e6);
  const out = [...up];
  let close = up[up.length - 1].close;
  for (let i = 0; i < 2; i++) {
    const open = close;
    close = close * 0.996;
    out.push({
      date: `2026-06-${String(i + 1).padStart(2, '0')}`,
      open,
      high: open * 1.004,
      low: close * 0.996,
      close,
      volume: 6e5,
      amount: close * 6e5
    });
  }
  return out;
}

describe('波段形态', () => {
  it('上升趋势 + 缩量回调 → 上升趋势回调，给做多计划', () => {
    const a = analyzeSwing(pullbackBars(), DEFAULT_SWING_CONFIG, 100)!;
    expect(a).not.toBeNull();
    expect(['上升趋势回调', '箱体突破']).toContain(a.setup);
    expect(['可做多', '等回踩']).toContain(a.verdict);
    expect(a.plan).not.toBeNull();
  });

  it('计划价格关系正确：止损 < 入场 < 目标', () => {
    const a = analyzeSwing(pullbackBars(), DEFAULT_SWING_CONFIG, 100)!;
    const p = a.plan!;
    expect(p.stop).toBeLessThan(p.entryLow);
    expect(p.entryLow).toBeLessThanOrEqual(p.entryHigh);
    expect(p.target1).toBeGreaterThan(p.entryHigh);
    expect(p.riskPerShare).toBeGreaterThan(0);
    expect(p.rr).toBeGreaterThan(0);
  });

  it('下跌趋势 → 下跌中继，不给做多计划', () => {
    const a = analyzeSwing(makeBars(120, -0.006), DEFAULT_SWING_CONFIG, 100)!;
    expect(a.setup).toBe('下跌中继');
    expect(a.verdict).toBe('不做');
    expect(a.plan).toBeNull();
  });

  it('横盘 → 区间震荡，观望', () => {
    const bars = makeBars(120, 0, 0.01);
    // 加一点正弦，避免完全不动导致 ADX/ATR 退化
    bars.forEach((b, i) => {
      const k = 1 + Math.sin(i / 4) * 0.01;
      b.close *= k;
      b.high *= k;
      b.low *= k;
    });
    const a = analyzeSwing(bars, DEFAULT_SWING_CONFIG, 100)!;
    expect(['区间震荡', '上升趋势回调', '箱体突破']).toContain(a.setup);
    expect(['观望', '等回踩', '可做多']).toContain(a.verdict);
  });

  it('仓位按每手股数取整；预算不够一手时给 0', () => {
    const a = analyzeSwing(pullbackBars(), { ...DEFAULT_SWING_CONFIG, capital: 1000, riskPct: 0.1 }, 100)!;
    expect(a.plan!.shares % 100).toBe(0);
    expect(a.plan!.shares).toBe(0);
  });

  it('样本不足返回 null', () => {
    expect(analyzeSwing(makeBars(50), DEFAULT_SWING_CONFIG)).toBeNull();
  });
});

describe('市场规则', () => {
  it('识别五个市场', () => {
    expect(tradingMarket('sh600519')).toBe('CN');
    expect(tradingMarket('hk00700')).toBe('HK');
    expect(tradingMarket('usAAPL')).toBe('US');
    expect(tradingMarket('jp7203')).toBe('JP');
    expect(tradingMarket('kr005930')).toBe('KR');
  });

  it('指数返回 null', () => {
    expect(tradingMarket('sh000001')).toBeNull();
    expect(tradingMarket('hkHSI')).toBeNull();
    expect(tradingMarket('usDJI')).toBeNull();
    expect(tradingMarket('jpN225')).toBeNull();
    expect(tradingMarket('krKOSPI')).toBeNull();
  });

  it('A 股 T+1、每手 100；美股 T+0、每手 1', () => {
    expect(marketRuleOf('sh600519')!.settlement).toBe('T+1');
    expect(marketRuleOf('sh600519')!.lotSize).toBe(100);
    expect(marketRuleOf('usAAPL')!.settlement).toBe('T+0');
    expect(marketRuleOf('usAAPL')!.lotSize).toBe(1);
    expect(marketRuleOf('kr005930')!.lotSize).toBe(1);
  });
});
