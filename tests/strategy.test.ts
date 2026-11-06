import { describe, expect, it } from 'vitest';
import { applyRiskOverlays, bucketOf, buildStrategy, quickScan, PROFILES } from '../src/pipelines/strategy';
import { genSyntheticBars } from '../src/data/synthetic';
import { SYMBOLS } from '../src/data/symbols';

const bars = genSyntheticBars(SYMBOLS[0], 320);
const cfg = { buyBps: 2.5, sellBps: 2.5, stampBps: 10 };

describe('风控叠加规则（纯函数）', () => {
  it('逆势降档：综合偏多 + 20 日大跌 → 仓位减半并记录', () => {
    const r = applyRiskOverlays(0.4, -0.1, 'normal', 0, 1);
    expect(r.pos).toBeCloseTo(0.2, 10);
    expect(r.notes.some((n) => n.includes('逆势'))).toBe(true);
  });

  it('非逆势不降档', () => {
    const r = applyRiskOverlays(0.4, 0.05, 'normal', 0, 1);
    expect(r.pos).toBeCloseTo(0.4, 10);
    expect(r.notes).toHaveLength(0);
  });

  it('波动率上行 → 仓位减半', () => {
    const r = applyRiskOverlays(0.4, 0.05, 'high', 0, 1);
    expect(r.pos).toBeCloseTo(0.2, 10);
    expect(r.notes.some((n) => n.includes('波动率'))).toBe(true);
  });

  it('技术面弱 + 综合偏多 → 封顶 30%', () => {
    const r = applyRiskOverlays(0.8, 0.05, 'normal', -0.8, 1);
    expect(r.pos).toBeCloseTo(0.3, 10);
    expect(r.notes.some((n) => n.includes('封顶'))).toBe(true);
  });

  it('技术面弱但综合偏空 → 不触发封顶（本就是空仓）', () => {
    const r = applyRiskOverlays(-0.5, 0.05, 'normal', -0.8, 1);
    expect(r.pos).toBe(0);
    expect(r.notes).toHaveLength(0);
  });

  it('多规则叠加取最严格', () => {
    const r = applyRiskOverlays(0.8, -0.12, 'high', -0.9, 1);
    expect(r.pos).toBeCloseTo(0.2, 10); // 0.8 ×0.5(逆势) ×0.5(波动率) = 0.2，低于 0.3 封顶
    expect(r.notes).toHaveLength(3);
  });

  it('风险档位上限生效', () => {
    const r = applyRiskOverlays(0.9, 0.05, 'normal', 0, 0.3);
    expect(r.pos).toBeCloseTo(0.3, 10);
  });

  it('综合为负 → 空仓（只做多）', () => {
    const r = applyRiskOverlays(-0.6, -0.2, 'high', -0.9, 1);
    expect(r.pos).toBe(0);
  });

  it('bucketOf 分档', () => {
    expect(bucketOf(0.8)).toBe('进攻');
    expect(bucketOf(0.4)).toBe('标配');
    expect(bucketOf(0.1)).toBe('试探');
    expect(bucketOf(0)).toBe('空仓观望');
  });
});

describe('策略引擎（集成）', () => {
  it('产出完整策略报告', () => {
    const s = buildStrategy(bars, null, null, cfg, { profile: 'balanced' });
    expect(s.targetPosition).toBeGreaterThanOrEqual(0);
    expect(s.targetPosition).toBeLessThanOrEqual(PROFILES.balanced.maxPos + 1e-9);
    expect(s.composite).toBeGreaterThanOrEqual(-1);
    expect(s.composite).toBeLessThanOrEqual(1);
    expect(s.plan.stopLoss).toBeLessThan(s.close);
    expect(s.plan.takeProfit1).toBeGreaterThan(0);
    expect(s.plan.addTrigger).toContain('加仓');
    expect(s.plan.reduceTrigger).toContain('减半');
    expect(s.state.label).toBeTruthy();
    expect(s.date).toBe(bars[bars.length - 1].date);
  });

  it('风险档位上限生效：激进 ≥ 稳健 ≥ 保守', () => {
    const c = buildStrategy(bars, null, null, cfg, { profile: 'conservative' });
    const b = buildStrategy(bars, null, null, cfg, { profile: 'balanced' });
    const a = buildStrategy(bars, null, null, cfg, { profile: 'aggressive' });
    expect(c.targetPosition).toBeLessThanOrEqual(PROFILES.conservative.maxPos + 1e-9);
    expect(a.targetPosition).toBeGreaterThanOrEqual(b.targetPosition - 1e-9);
    expect(b.targetPosition).toBeGreaterThanOrEqual(c.targetPosition - 1e-9);
  });

  it('观点合成权重：MLP 剔除时重新归一化', () => {
    const s = buildStrategy(bars, null, null, cfg, { profile: 'aggressive' });
    let expectComposite: number;
    if (s.views.ml === null) {
      expect(s.notes.some((n) => n.includes('AUC'))).toBe(true);
      expectComposite = (0.3 * s.views.hmm + 0.3 * s.views.factor + 0.2 * s.views.vol) / 0.8;
    } else {
      expectComposite = 0.3 * s.views.hmm + 0.3 * s.views.factor + 0.2 * s.views.vol + 0.2 * s.views.ml;
    }
    expect(s.composite).toBeCloseTo(expectComposite, 6);
  });

  it('quickScan 速览结构完整', () => {
    const q = quickScan(bars, null, null, 'balanced');
    expect(q.composite).toBeGreaterThanOrEqual(-1);
    expect(q.composite).toBeLessThanOrEqual(1);
    expect(q.targetPosition).toBeLessThanOrEqual(PROFILES.balanced.maxPos + 1e-9);
    expect(['进攻', '标配', '试探', '空仓观望']).toContain(q.bucket);
    expect(q.state).toBeTruthy();
  });
});
