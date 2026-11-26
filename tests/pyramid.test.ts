import { describe, it, expect } from 'vitest';
import type { Bar } from '../src/data/types';
import {
  analyzePyramid,
  detectSwingRange,
  DEFAULT_PYRAMID_CONFIG,
  FIB_LEVELS,
  FIB_LABELS,
  OLIVE_WEIGHTS,
  FIB_WEIGHTS,
  PYRAMID_RISKS,
  type PyramidConfig
} from '../src/math/pyramid';

/** 构造「先拉升 → 后回撤」的合成日 K：主升段 100→200（60 根），随后回撤到 end（60 根）。 */
function makeBars(end: number, n = 120): Bar[] {
  const half = Math.floor(n / 2);
  const bars: Bar[] = [];
  for (let i = 0; i < half; i++) {
    const c = 100 + (100 * i) / (half - 1);
    bars.push({ date: `2024-${String(1 + Math.floor(i / 30)).padStart(2, '0')}-${String(1 + (i % 30)).padStart(2, '0')}`, open: c, close: c, high: c, low: c, volume: 1000, amount: c * 1000 });
  }
  for (let i = 0; i < n - half; i++) {
    const c = 200 + ((end - 200) * i) / (n - half - 1);
    bars.push({ date: `2024-07-${String(1 + i).padStart(2, '0')}`, open: c, close: c, high: c, low: c, volume: 1000, amount: c * 1000 });
  }
  return bars;
}

const cfg = (over: Partial<PyramidConfig> = {}): PyramidConfig => ({ ...DEFAULT_PYRAMID_CONFIG, ...over });

describe('detectSwingRange', () => {
  it('识别主升段高低点，且低点在高点之前', () => {
    const r = detectSwingRange(makeBars(160), 120);
    expect(r).not.toBeNull();
    expect(r!.high).toBeCloseTo(200, 6);
    expect(r!.low).toBeCloseTo(100, 6);
    expect(r!.lowIdx).toBeLessThan(r!.highIdx);
  });
});

describe('analyzePyramid · 结构与边界', () => {
  it('日 K 不足 60 根返回 null', () => {
    expect(analyzePyramid(makeBars(160, 59))).toBeNull();
  });

  it('下跌段（低点在高点之后）不构成有效回撤结构', () => {
    // 先跌后横：最高点在开头，最低点在后面 → lowIdx >= highIdx 不成立，但幅度来自下跌
    const bars: Bar[] = [];
    for (let i = 0; i < 60; i++) {
      const c = 200 - i;
      bars.push({ date: `d${i}`, open: c, close: c, high: c, low: c, volume: 1, amount: c });
    }
    for (let i = 0; i < 60; i++) {
      const c = 140 + i * 0.2;
      bars.push({ date: `e${i}`, open: c, close: c, high: c, low: c, volume: 1, amount: c });
    }
    const r = analyzePyramid(bars, cfg());
    expect(r).not.toBeNull();
    expect(r!.valid).toBe(false);
    expect(r!.verdict).toBe('不适合');
    expect(r!.invalidReason).toBeTruthy();
  });
});

describe('analyzePyramid · 回撤位与权重', () => {
  const r = analyzePyramid(makeBars(165), cfg())!;

  it('五档回撤位价格 = 高点 − 幅度 × 比例', () => {
    expect(r.rows.map((x) => x.label)).toEqual([...FIB_LABELS]);
    expect(r.rows.map((x) => x.price)).toEqual(
      FIB_LEVELS.map((lv) => Math.round((200 - 100 * lv) * 100) / 100)
    );
    // 23.6% 位 176.4，38.2% 位 161.8，50% 位 150，61.8% 位 138.2，76.4% 位 123.6
    expect(r.rows[0].price).toBeCloseTo(176.4, 2);
    expect(r.rows[2].price).toBeCloseTo(150, 2);
    expect(r.rows[4].price).toBeCloseTo(123.6, 2);
  });

  it('橄榄型权重为 1/3/5/3/1，核心区（38.2/50/61.8）占绝大多数', () => {
    expect(r.weights).toEqual([...OLIVE_WEIGHTS]);
    expect(r.coreSharePct).toBeGreaterThan(70);
    expect(r.rows[2].weight).toBe(5);
    expect(r.rows[0].weight).toBe(1);
    expect(r.rows[4].weight).toBe(1);
  });

  it('逆势斐波那契对照模式越跌越重，核心区占比明显更低', () => {
    const fib = analyzePyramid(makeBars(165), cfg({ mode: 'fib' }))!;
    expect(fib.weights).toEqual([...FIB_WEIGHTS]);
    expect(fib.weights[4]).toBeGreaterThan(fib.weights[0]);
    expect(fib.coreSharePct).toBeLessThan(r.coreSharePct);
    expect(fib.notes.join()).toContain('越跌越重');
  });

  it('每档股数按每手取整，累计股数单调不减且末档等于总股数', () => {
    for (const row of r.rows) expect(row.shares % 100).toBe(0);
    for (let i = 1; i < r.rows.length; i++) expect(r.rows[i].cumShares).toBeGreaterThanOrEqual(r.rows[i - 1].cumShares);
    expect(r.rows[r.rows.length - 1].cumShares).toBe(r.totalShares);
  });
});

describe('analyzePyramid · 止损模式', () => {
  it('止损 618：末端档停用、止损价 = 138.2', () => {
    const r = analyzePyramid(makeBars(165), cfg({ stopMode: '618' }))!;
    expect(r.stopPrice).toBeCloseTo(138.2, 2);
    expect(r.weights[4]).toBe(0);
    expect(r.rows[4].active).toBe(false);
    expect(r.rows[4].shares).toBe(0);
    expect(r.notes.join()).toContain('76.4% 末端档已停用');
  });

  it('止损 786：末端档保留、止损价 = 121.4，最大亏损按平均成本计', () => {
    const r = analyzePyramid(makeBars(165), cfg({ stopMode: '786' }))!;
    expect(r.stopPrice).toBeCloseTo(121.4, 2);
    expect(r.rows[4].active).toBe(true);
    expect(r.weights[4]).toBe(1);
    expect(r.maxLoss).toBeCloseTo(Math.max(0, r.avgCost - r.stopPrice) * r.totalShares, 0);
    expect(r.maxLossPct).toBeCloseTo((r.maxLoss / DEFAULT_PYRAMID_CONFIG.capital) * 100, 4);
  });
});

describe('analyzePyramid · 成本、盈亏比与判定', () => {
  it('平均成本落在全档价格区间内，核心区占比与逐档累计一致', () => {
    const r = analyzePyramid(makeBars(165), cfg())!;
    const active = r.rows.filter((x) => x.active);
    expect(r.avgCost).toBeGreaterThanOrEqual(Math.min(...active.map((x) => x.price)));
    expect(r.avgCost).toBeLessThanOrEqual(Math.max(...active.map((x) => x.price)));
    const core = active.filter((x) => x.zone === '核心区').reduce((s, x) => s + x.shares, 0);
    expect(r.coreSharePct).toBeCloseTo((core / r.totalShares) * 100, 4);
    expect(r.rr).toBeGreaterThan(0);
  });

  it('现价在核心区（回撤 40%）→ 可执行', () => {
    const r = analyzePyramid(makeBars(160), cfg())!;
    expect(r.retrace).toBeCloseTo(0.4, 2);
    expect(r.verdict).toBe('可执行');
    expect(r.verdictNote).toContain('黄金分割核心区');
  });

  it('浅回撤（10%）→ 等回撤', () => {
    expect(analyzePyramid(makeBars(190), cfg())!.verdict).toBe('等回撤');
  });

  it('跌破止损位 → 不适合，且文案强调整体止损而非摊平', () => {
    const r = analyzePyramid(makeBars(110), cfg())!;
    expect(r.verdict).toBe('不适合');
    expect(r.verdictNote).toContain('整体止损');
  });

  it('越过核心区但未破止损 → 风险过高', () => {
    const r = analyzePyramid(makeBars(130), cfg())!;
    expect(r.retrace).toBeGreaterThan(0.618);
    expect(r.verdict).toBe('风险过高');
  });
});

describe('analyzePyramid · 风险提示（策略前置条件）', () => {
  it('四条致命风险始终全部保留', () => {
    const r = analyzePyramid(makeBars(165), cfg())!;
    for (const risk of PYRAMID_RISKS) expect(r.warnings).toContain(risk);
    expect(r.warnings.join()).toContain('快速穿透');
    expect(r.warnings.join()).toContain('反复被扫');
    expect(r.warnings.join()).toContain('黄金分割带一定撑住');
  });

  it('无论哪种判定，风险提示都不消失', () => {
    for (const end of [190, 165, 130, 110]) {
      const r = analyzePyramid(makeBars(end), cfg())!;
      expect(r.warnings).toHaveLength(PYRAMID_RISKS.length);
    }
  });
});
