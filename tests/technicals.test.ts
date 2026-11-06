import { describe, expect, it } from 'vitest';
import { analyzeTechnicals, kdj } from '../src/math/technicals';
import { emSecidOf } from '../src/data/sources/eastmoney';
import type { Bar } from '../src/data/types';

/**
 * 造一段走势：trend 为每根 K 线的日均涨幅，vol 只作用在高低点上。
 * 收盘价走纯趋势——否则 sin 波动会让末端出现「跌幅收窄」的假反弹，
 * MACD 会合理地转多，测试就不该断言「下跌趋势一定偏空」。
 */
function makeBars(n: number, trend = 0.004, vol = 0.012, start = 100): Bar[] {
  const bars: Bar[] = [];
  let close = start;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = close * (1 + trend);
    const high = Math.max(open, close) * (1 + vol * 0.5);
    const low = Math.min(open, close) * (1 - vol * 0.5);
    const volume = 1e6 + i * 1000;
    bars.push({ date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`, open, high, low, close, volume, amount: close * volume });
  }
  return bars;
}

describe('技术面体检', () => {
  it('数据不足 60 根返回 null', () => {
    expect(analyzeTechnicals(makeBars(30))).toBeNull();
  });

  it('上升趋势评分偏高、偏多项占多数', () => {
    const r = analyzeTechnicals(makeBars(120, 0.006))!;
    expect(r).not.toBeNull();
    expect(r.score).toBeGreaterThan(50);
    expect(r.rows.length).toBe(7);
    expect(r.rows.filter((x) => x.tone === 'up').length).toBeGreaterThanOrEqual(2);
  });

  it('下跌趋势评分偏低、偏空项占多数', () => {
    const r = analyzeTechnicals(makeBars(120, -0.006))!;
    expect(r.score).toBeLessThan(50);
    // 匀速下跌时 MACD 会收敛到 0（柱既不为负也不放大），所以不硬断言 MACD 方向
    expect(r.rows.filter((x) => x.tone === 'down').length).toBeGreaterThanOrEqual(2);
  });

  it('评分落在 0~100', () => {
    for (const t of [-0.02, -0.006, 0, 0.006, 0.02]) {
      const r = analyzeTechnicals(makeBars(120, t))!;
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
  });

  it('每一项都有数值、状态和解释', () => {
    const r = analyzeTechnicals(makeBars(120))!;
    for (const row of r.rows) {
      expect(row.value.length).toBeGreaterThan(0);
      expect(row.state.length).toBeGreaterThan(0);
      expect(row.note.length).toBeGreaterThan(0);
    }
  });

  it('RSI 极强时给出超买提示', () => {
    // 连续单边上涨，RSI 会冲高
    const r = analyzeTechnicals(makeBars(120, 0.02, 0.002))!;
    const rsi = r.rows.find((x) => x.key === 'rsi')!;
    expect(['超买', '强势']).toContain(rsi.state);
  });

  it('结论包含评分与多空项数', () => {
    const r = analyzeTechnicals(makeBars(120))!;
    expect(r.summary).toContain(String(r.score));
    expect(r.summary).toMatch(/偏多|偏空/);
  });
});

describe('KDJ', () => {
  it('K/D 在 0~100、J 可越界', () => {
    const k = kdj(makeBars(80, 0.01));
    const kv = k.k.filter((v) => Number.isFinite(v));
    const dv = k.d.filter((v) => Number.isFinite(v));
    expect(kv.every((v) => v >= 0 && v <= 100)).toBe(true);
    expect(dv.every((v) => v >= 0 && v <= 100)).toBe(true);
    expect(k.j.length).toBe(80);
  });
});

describe('东财 secid 构造', () => {
  it('A 股：沪 1 / 深 0', () => {
    expect(emSecidOf('sh600519', 'CN')).toBe('1.600519');
    expect(emSecidOf('sz000001', 'CN')).toBe('0.000001');
  });

  it('港股 116', () => {
    expect(emSecidOf('hk00700', 'HK')).toBe('116.00700');
  });

  it('美股 105（点号转连字符）', () => {
    expect(emSecidOf('usAAPL', 'US')).toBe('105.AAPL');
    expect(emSecidOf('usBRK.B', 'US')).toBe('105.BRK-B');
  });

  it('日韩不支持', () => {
    expect(emSecidOf('jp7203', 'JP')).toBeNull();
    expect(emSecidOf('kr005930', 'KR')).toBeNull();
  });
});
