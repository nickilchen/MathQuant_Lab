import { describe, expect, it } from 'vitest';
import { buildActionPlan, priceForMomentum, type ActionPlan } from '../src/math/action';
import { DEFAULT_MOM, buildMomentumReport, momReturn, type MomParams } from '../src/math/momentum';
import { DEFAULT_BT } from '../src/math/backtest';
import type { Bar } from '../src/data/types';

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

const P = (patch: Partial<MomParams> = {}): MomParams => ({ ...DEFAULT_MOM, ...patch });

/** 先涨后跌，制造多头转空头 */
const upThenDown = (): number[] => {
  const up = Array.from({ length: 320 }, (_, i) => 100 * Math.pow(1.0025, i));
  const top = up[up.length - 1];
  const down = Array.from({ length: 60 }, (_, i) => top * Math.pow(0.995, i + 1));
  return [...up, ...down];
};

const uptrend = (): number[] => Array.from({ length: 400 }, (_, i) => 100 * Math.pow(1.002, i));

const find = (plan: ActionPlan, key: string) => plan.triggers.find((t) => t.action.includes(key));

describe('触发价反解', () => {
  it('skip=0 时反解价是精确解', () => {
    const closes = upThenDown();
    const p = P({ skip: 0 });
    for (const target of [-0.05, 0, 0.02, 0.08]) {
      const px = priceForMomentum(closes, p, target);
      expect(px).not.toBeNull();
      const patched = [...closes];
      patched[patched.length - 1] = px as number;
      expect(momReturn(patched, patched.length - 1, p.lookback, p.skip)).toBeCloseTo(target, 6);
    }
  });

  it('skip>0 时为近似解，方向正确', () => {
    const closes = upThenDown();
    const p = P();
    const cur = closes[closes.length - 1];
    expect(priceForMomentum(closes, p, 0.5) as number).toBeGreaterThan(cur);
    expect(priceForMomentum(closes, p, -0.5) as number).toBeLessThan(cur);
  });

  it('历史不足时返回 null 而不是抛错', () => {
    expect(priceForMomentum([100, 101], P(), 0.02)).toBeNull();
    expect(priceForMomentum([], P(), 0.02)).toBeNull();
  });
});

describe('操作策略推导', () => {
  it('下跌趋势中趋势过滤把仓位归零，并给出翻多价', () => {
    const closes = upThenDown();
    const p = P();
    const plan = buildActionPlan(buildMomentumReport(barsOf(closes), p, DEFAULT_BT), p);
    expect(plan.trendOk).toBe(false);
    expect(plan.position).toBe(0);
    expect(plan.tone === 'avoid' || plan.tone === 'watch').toBe(true);
    expect(plan.triggers).toHaveLength(3);

    const entry = find(plan, '翻多');
    expect(entry).toBeDefined();
    expect(entry!.price as number).toBeGreaterThan(closes[closes.length - 1]);

    // 空仓时不应出现清仓动作
    expect(find(plan, '清仓')).toBeUndefined();
    const idle = find(plan, '不动作');
    expect(idle).toBeDefined();
    expect(idle!.price).toBeNull();
  });

  it('上涨趋势中给出持有信号、正仓位与清仓价', () => {
    const closes = uptrend();
    const p = P();
    const plan = buildActionPlan(buildMomentumReport(barsOf(closes), p, DEFAULT_BT), p);
    expect(plan.trendOk).toBe(true);
    expect(plan.tone).toBe('hold');
    expect(plan.position).toBeGreaterThan(0);
    expect(plan.position).toBeLessThanOrEqual(p.cap);

    expect(find(plan, '持仓维持')).toBeDefined();
    expect(find(plan, '清仓')).toBeDefined();
    expect(find(plan, '翻多')).toBeUndefined();
  });

  it('建议仓位不超过上限，且触发价有序', () => {
    const closes = uptrend();
    const p = P({ cap: 0.6 });
    const plan = buildActionPlan(buildMomentumReport(barsOf(closes), p, DEFAULT_BT), p);
    expect(plan.position).toBeLessThanOrEqual(0.6 + 1e-12);

    const keep = find(plan, '持仓维持')!.price as number;
    const add = find(plan, '加仓')!.price as number;
    const exit = find(plan, '清仓')!.price as number;
    expect(add).toBeGreaterThanOrEqual(keep - 1e-9);
    expect(exit).toBeLessThanOrEqual(keep + 1e-9);
  });
});