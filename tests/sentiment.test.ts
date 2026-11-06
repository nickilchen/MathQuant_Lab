import { describe, expect, it } from 'vitest';
import {
  DIM_META,
  approxHistory,
  breadthScore,
  capitalScore,
  clamp,
  distributionOf,
  evaluateSentiment,
  limitStat,
  strengthScore,
  structureScore,
  volumeScore,
  volatilityScore,
  weatherOf,
  type BreadthInput,
  type FlowInput,
  type StructureInput,
  type VolInput
} from '../src/math/sentiment';

const breadth = (over: Partial<BreadthInput> = {}): BreadthInput => ({
  total: 5000,
  up: 3000,
  down: 1800,
  flat: 200,
  limitUp: 40,
  limitDown: 10,
  broke: 10,
  maxBoard: 4,
  medianPct: 0.5,
  ...over
});

const flow = (over: Partial<FlowInput> = {}): FlowInput => ({
  main: 5e9,
  amount: 4e11,
  main5: 1e10,
  marginNet: 2e9,
  marginBal: 2.3e12,
  marginDate: '2026-10-30',
  ...over
});

describe('单维打分', () => {
  it('广度随上涨占比单调递增，且在 0~100 内', () => {
    const low = breadthScore(breadth({ up: 500, down: 4300, flat: 200 }));
    const mid = breadthScore(breadth({ up: 2500, down: 2300, flat: 200 }));
    const high = breadthScore(breadth({ up: 4600, down: 200, flat: 200 }));
    expect(low).toBeLessThan(mid);
    expect(mid).toBeLessThan(high);
    for (const v of [low, mid, high]) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
    // 上涨占比恰好 50% 时应接近中性
    const half = breadthScore(breadth({ up: 2400, down: 2400, flat: 200, medianPct: 0 }));
    expect(half).toBeGreaterThan(45);
    expect(half).toBeLessThan(55);
  });

  it('广度会被「指数涨但中位数为负」拉低', () => {
    const same = breadthScore(breadth({ medianPct: 0 }));
    const skewed = breadthScore(breadth({ medianPct: -1.5 }));
    expect(skewed).toBeLessThan(same);
  });

  it('强度：涨停多于跌停、封板率高、有高标时更高', () => {
    const strong = strengthScore(breadth({ limitUp: 80, limitDown: 3, broke: 5, maxBoard: 6 }));
    const weak = strengthScore(breadth({ limitUp: 5, limitDown: 40, broke: 30, maxBoard: 1 }));
    expect(strong).toBeGreaterThan(weak);
    expect(strong).toBeLessThanOrEqual(100);
    expect(weak).toBeGreaterThanOrEqual(0);
  });

  it('资金：主力净流入为正时高于流出；主力缺失时退化为两融口径', () => {
    const inflow = capitalScore(flow({ main: 1e10 }));
    const outflow = capitalScore(flow({ main: -1e10 }));
    expect(inflow).toBeGreaterThan(outflow);
    expect(inflow).toBeGreaterThan(50);
    expect(outflow).toBeLessThan(50);

    // 主力缺失 → 只看两融，不应返回 50（那等于凭空中性）
    const marginOnly = capitalScore(flow({ main: null, marginNet: 4.6e10 }));
    expect(marginOnly).toBeGreaterThan(50);
    // 两融也没有 → 中性
    expect(capitalScore(flow({ main: null, marginBal: 0, marginNet: 0 }))).toBe(50);
  });

  it('量能：单调递增并饱和，缩量低于 50', () => {
    expect(volumeScore(0.5)).toBeLessThan(40);
    expect(volumeScore(1)).toBeCloseTo(50, 5);
    expect(volumeScore(1.5)).toBeGreaterThan(65);
    expect(volumeScore(2)).toBeGreaterThan(volumeScore(1.5));
    expect(volumeScore(5)).toBeLessThanOrEqual(100);
    expect(volumeScore(5)).toBeGreaterThan(95);
    // 非法输入不崩
    expect(volumeScore(0)).toBe(50);
    expect(volumeScore(Number.NaN)).toBe(50);
  });

  it('结构：上涨行业越多分越高', () => {
    const s = (upCount: number, total = 49): StructureInput => ({ upCount, total, medianPct: 0.3 });
    expect(structureScore(s(5))).toBeLessThan(structureScore(s(25)));
    expect(structureScore(s(25))).toBeLessThan(structureScore(s(45)));
  });

  it('波动：波动放大扣分（反向）', () => {
    const calm = volatilityScore({ vol20: 0.12, vol60: 0.2, amountRatio: 1 });
    const wild = volatilityScore({ vol20: 0.4, vol60: 0.2, amountRatio: 1 });
    expect(calm).toBeGreaterThan(50);
    expect(wild).toBeLessThan(50);
  });
});

describe('天气映射', () => {
  it('按阈值分档', () => {
    expect(weatherOf(90)).toBe('sunny');
    expect(weatherOf(72)).toBe('sunny');
    expect(weatherOf(71.9)).toBe('cloudy');
    expect(weatherOf(58)).toBe('cloudy');
    expect(weatherOf(50)).toBe('overcast');
    expect(weatherOf(45)).toBe('overcast');
    expect(weatherOf(40)).toBe('rain');
    expect(weatherOf(32)).toBe('rain');
    expect(weatherOf(20)).toBe('storm');
    expect(weatherOf(0)).toBe('storm');
  });
});

describe('合成', () => {
  const vol: VolInput = { vol20: 0.15, vol60: 0.2, amountRatio: 1.2 };

  it('七维齐全时权重归一为 1', () => {
    const r = evaluateSentiment({
      breadth: breadth(),
      flow: flow(),
      structure: { upCount: 35, total: 49, medianPct: 0.5 },
      vol,
      buzz: { score: 62, detail: '热帖 40 条' }
    });
    const sum = r.dims.reduce((s, d) => s + d.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
    expect(r.dims.every((d) => d.available)).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.score).toBeLessThanOrEqual(100);
    expect(r.reasons.length).toBe(7);
  });

  it('维度缺失时从权重中剔除并重新归一，而不是补 50 分', () => {
    const r = evaluateSentiment({
      breadth: breadth(),
      flow: null,
      structure: null,
      vol: null
    });
    const available = r.dims.filter((d) => d.available);
    const missing = r.dims.filter((d) => !d.available);
    // vol 同时供给「量能」和「波动」，因此这两个维度一起缺失
    expect(missing.map((d) => d.key).sort()).toEqual(['buzz', 'capital', 'structure', 'volatility', 'volume']);
    expect(missing.every((d) => d.weight === 0)).toBe(true);
    expect(available.reduce((s, d) => s + d.weight, 0)).toBeCloseTo(1, 6);
  });

  it('非交易时段（涨停池为空）不打低打板强度，而是剔除该维度', () => {
    const r = evaluateSentiment({
      breadth: breadth({ limitUp: 0, limitDown: 0, broke: 0, maxBoard: 0 }),
      flow: flow(),
      structure: { upCount: 30, total: 49, medianPct: 0.3 },
      vol
    });
    const strength = r.dims.find((d) => d.key === 'strength')!;
    expect(strength.available).toBe(false);
    expect(r.score).toBeGreaterThan(40);
  });

  it('极端亢奋触发 hot 提示', () => {
    const r = evaluateSentiment({
      breadth: breadth({ up: 4900, down: 60, flat: 40, limitUp: 90, limitDown: 1, broke: 2, maxBoard: 8, medianPct: 3 }),
      flow: flow({ main: 3e10 }),
      structure: { upCount: 49, total: 49, medianPct: 2.5 },
      vol: { vol20: 0.2, vol60: 0.2, amountRatio: 2.5 }
    });
    expect(r.score).toBeGreaterThan(80);
    expect(r.extreme).toBe('hot');
    expect(r.alerts.some((a) => a.tone === 'hot')).toBe(true);
  });

  it('极端冰点触发 cold 提示', () => {
    const r = evaluateSentiment({
      breadth: breadth({ up: 120, down: 4800, flat: 80, limitUp: 2, limitDown: 120, broke: 5, maxBoard: 1, medianPct: -4 }),
      flow: flow({ main: -3e10, marginNet: -8e10 }),
      structure: { upCount: 1, total: 49, medianPct: -3 },
      vol: { vol20: 0.5, vol60: 0.2, amountRatio: 1.8 }
    });
    expect(r.score).toBeLessThan(20);
    expect(r.extreme).toBe('cold');
  });

  it('炸板率高时提示分歧', () => {
    const r = evaluateSentiment({
      breadth: breadth({ limitUp: 30, limitDown: 5, broke: 40, maxBoard: 3 }),
      flow: flow(),
      structure: { upCount: 25, total: 49, medianPct: 0.2 },
      vol
    });
    expect(r.alerts.some((a) => a.title === '分歧加大')).toBe(true);
  });

  it('clamp 兜底非法值', () => {
    expect(clamp(Number.NaN)).toBe(0);
    expect(clamp(-5)).toBe(0);
    expect(clamp(120)).toBe(100);
  });
});

describe('涨跌分布', () => {
  it('0 单独成箱，正负分箱不重叠', () => {
    const bins = distributionOf([0, 0.5, -0.5, 10, -10, 3]);
    const total = bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(6);
    expect(bins.find((b) => b.label === '0')!.count).toBe(1);
    expect(bins.find((b) => b.label === '0~1')!.count).toBe(1);
    expect(bins.find((b) => b.label === '-1~0')!.count).toBe(1);
    expect(bins.find((b) => b.label === '≥7')!.count).toBe(1);
    expect(bins.find((b) => b.label === '≤-7')!.count).toBe(1);
  });

  it('边界值落到右侧箱体（左闭右开）', () => {
    const bins = distributionOf([1, 3, 5]);
    expect(bins.find((b) => b.label === '1~3')!.count).toBe(1); // 1 属于 [1,3)
    expect(bins.find((b) => b.label === '3~5')!.count).toBe(1); // 3 属于 [3,5)
    expect(bins.find((b) => b.label === '5~7')!.count).toBe(1); // 5 属于 [5,7)
  });

  it('空数组与非法值不崩', () => {
    expect(distributionOf([]).reduce((s, b) => s + b.count, 0)).toBe(0);
    expect(distributionOf([Number.NaN]).reduce((s, b) => s + b.count, 0)).toBe(0);
  });
});

describe('涨停统计', () => {
  it('连板梯队与封板率', () => {
    const up = [{ boardCount: 1 }, { boardCount: 1 }, { boardCount: 2 }, { boardCount: 5 }];
    const st = limitStat(up, 3, 2);
    expect(st.limitUp).toBe(4);
    expect(st.limitDown).toBe(3);
    expect(st.maxBoard).toBe(5);
    expect(st.sealRate).toBeCloseTo(4 / 6, 6);
    expect(st.ladder).toEqual([
      { level: 1, count: 2 },
      { level: 2, count: 1 },
      { level: 5, count: 1 }
    ]);
  });

  it('全空时不出现除零', () => {
    const st = limitStat([], 0, 0);
    expect(st.maxBoard).toBe(0);
    expect(st.sealRate).toBe(0);
    expect(st.ladder).toEqual([]);
  });
});

describe('历史近似温度', () => {
  it('数据不足时返回空，足够时长度受限且分数在区间内', () => {
    expect(approxHistory([], 60)).toEqual([]);
    const kline = Array.from({ length: 80 }, (_, i) => ({
      date: `2026-01-${String((i % 28) + 1).padStart(2, '0')}`,
      close: 3000 + i * 3,
      amount: 1e12,
      volume: 1e8,
      high: 0,
      low: 0
    }));
    const out = approxHistory(kline, 60);
    expect(out.length).toBe(60);
    for (const p of out) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(100);
    }
  });
});

describe('权重配置', () => {
  it('七维权重合计为 1', () => {
    const sum = Object.values(DIM_META).reduce((s, d) => s + d.weight, 0);
    expect(sum).toBeCloseTo(1, 6);
  });
});
