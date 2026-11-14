import { describe, expect, it } from 'vitest';
import type { Bar } from '../src/data/types';
import { DEFAULT_BOTTOMING_CONFIG, detectBottoming } from '../src/math/bottoming';

/**
 * 造 K 线：每段线性从 from 走到 to，range 控制当日振幅，wave 加正弦抖动。
 * 振幅与成交量是「降波」判定的核心，所以两者都显式可控。
 */
interface Seg {
  n: number;
  from: number;
  to: number;
  range: number;
  volume: number;
  wave?: number;
}

function build(segs: Seg[]): Bar[] {
  const out: Bar[] = [];
  for (const s of segs) {
    for (let k = 0; k < s.n; k++) {
      const t = s.n === 1 ? 1 : k / (s.n - 1);
      let close = s.from + (s.to - s.from) * t;
      if (s.wave) close += Math.sin(k * 0.7) * s.wave;
      const prev = out.length ? out[out.length - 1].close : close;
      out.push({
        date: `D${String(out.length).padStart(4, '0')}`,
        open: prev,
        close,
        high: Math.max(prev, close) * (1 + s.range),
        low: Math.min(prev, close) * (1 - s.range),
        volume: s.volume,
        amount: close * s.volume
      });
    }
  }
  return out;
}

/** 主升 +50% → 回撤 -30% → 缩量窄幅横盘（典型降波筑底） */
function bottomingBars(): Bar[] {
  return build([
    { n: 60, from: 100, to: 150, range: 0.02, volume: 2e6 },
    { n: 60, from: 150, to: 105, range: 0.035, volume: 3e6 },
    { n: 80, from: 105, to: 105, range: 0.006, volume: 6e5, wave: 0.35 }
  ]);
}

function appendBar(bars: Bar[], factor: number, volume: number, range = 0.01): Bar[] {
  const prev = bars[bars.length - 1].close;
  const close = prev * factor;
  return [
    ...bars,
    {
      date: `D${String(bars.length).padStart(4, '0')}`,
      open: prev,
      close,
      high: Math.max(prev, close) * (1 + range),
      low: Math.min(prev, close) * (1 - range),
      volume,
      amount: close * volume
    }
  ];
}

describe('降波筑底 · 形态与信号', () => {
  it('数据不足 120 根直接返回 null，不硬算', () => {
    expect(detectBottoming(bottomingBars().slice(0, 100))).toBeNull();
    expect(detectBottoming(bottomingBars())).not.toBeNull();
  });

  it('主升 → 下跌 → 双收敛横盘：识别为小仓试探，不给买入', () => {
    const a = detectBottoming(bottomingBars(), DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.runUp).toBeGreaterThan(0.3);
    expect(a.drawdown).toBeGreaterThan(0.2);
    expect(a.compress).toBeLessThan(DEFAULT_BOTTOMING_CONFIG.compression);
    expect(a.volCompress).toBeLessThan(DEFAULT_BOTTOMING_CONFIG.compression);
    expect(a.signal).toBe('筑底中·小仓试探');
    // 只收敛、没突破 → 绝不能升级为买入
    expect(a.signal).not.toBe('筑底确认·买入');
    expect(a.breakout).toBe(false);
    expect(a.plan).not.toBeNull();
    expect(a.plan!.action).toBe('probe');
    expect(a.plan!.positionPct).toBeCloseTo(DEFAULT_BOTTOMING_CONFIG.probePct, 6);
  });

  it('放量突破颈线 + MA20 转上 → 升级为筑底确认，仓位提高', () => {
    const a = detectBottoming(appendBar(bottomingBars(), 1.07, 3e6), DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.breakout).toBe(true);
    expect(a.signal).toBe('筑底确认·买入');
    expect(a.plan).not.toBeNull();
    expect(a.plan!.action).toBe('confirm');
    expect(a.plan!.positionPct).toBeGreaterThanOrEqual(DEFAULT_BOTTOMING_CONFIG.probePct);
  });

  it('下跌中继反例：缩量横盘但低点持续下移 → 只观察，不给任何仓位', () => {
    const bars = build([
      { n: 60, from: 100, to: 150, range: 0.02, volume: 2e6 },
      { n: 60, from: 150, to: 105, range: 0.035, volume: 3e6 },
      { n: 80, from: 105, to: 90, range: 0.006, volume: 6e5 }
    ]);
    const a = detectBottoming(bars, DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.compressed).toBe(true);
    expect(a.higherLow).toBe(false);
    expect(a.signal).not.toBe('筑底中·小仓试探');
    expect(a.signal).not.toBe('筑底确认·买入');
    expect(a.plan).toBeNull();
  });

  it('单日反抽不算反转：收敛但没到量比门槛，不给确认', () => {
    const bars = appendBar(bottomingBars(), 1.07, 6e5);
    const a = detectBottoming(bars, DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.breakout).toBe(false);
    expect(a.signal).not.toBe('筑底确认·买入');
  });

  it('收盘跌破底部低点 → 筑底失败，立即离场', () => {
    const a = detectBottoming(appendBar(bottomingBars(), 0.9, 3e6), DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.signal).toBe('筑底失败·离场');
    expect(a.plan).toBeNull();
  });

  it('没有主升前置（刚创新高）→ 不符合形态，不给信号', () => {
    const a = detectBottoming(appendBar(bottomingBars(), 1.5, 2e6), DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.barsFromHigh).toBe(0);
    expect(a.signal).toBe('不符合形态');
    expect(a.plan).toBeNull();
  });

  it('一路阴跌、波动未收敛 → 下跌未完', () => {
    const bars = build([
      { n: 60, from: 100, to: 150, range: 0.02, volume: 2e6 },
      { n: 140, from: 150, to: 105, range: 0.035, volume: 3e6 }
    ]);
    const a = detectBottoming(bars, DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.signal).toBe('下跌未完');
    expect(a.plan).toBeNull();
  });
});

describe('降波筑底 · 计划与解释', () => {
  it('试探计划价格关系正确：止损 < 入场 ≤ 目标 1 < 目标 2', () => {
    const a = detectBottoming(bottomingBars(), DEFAULT_BOTTOMING_CONFIG, 100)!;
    const p = a.plan!;
    expect(p.stop).toBeLessThan(p.entryLow);
    expect(p.entryLow).toBeLessThanOrEqual(p.entryHigh);
    expect(p.target1).toBeGreaterThan(p.entryHigh);
    expect(p.target2).toBeGreaterThan(p.target1);
    expect(p.rr).toBeGreaterThan(0);
    expect(p.shares).toBeGreaterThanOrEqual(0);
    expect(p.riskAmount).toBeGreaterThanOrEqual(0);
  });

  it('确认计划同样满足价格关系，且第一目标高于试探档', () => {
    const probe = detectBottoming(bottomingBars(), DEFAULT_BOTTOMING_CONFIG, 100)!.plan!;
    const confirm = detectBottoming(appendBar(bottomingBars(), 1.07, 3e6), DEFAULT_BOTTOMING_CONFIG, 100)!.plan!;
    expect(confirm.stop).toBeLessThan(confirm.entryLow);
    expect(confirm.target1).toBeGreaterThan(confirm.entryHigh);
    expect(confirm.target2).toBeGreaterThan(confirm.target1);
    expect(confirm.target1).toBeGreaterThan(probe.target1);
  });

  it('必须写明破底即走铁律与加仓触发', () => {
    const a = detectBottoming(bottomingBars(), DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.plan!.exitTriggers.join(' ')).toContain('破底即走');
    expect(a.plan!.exitTriggers.join(' ')).toContain('清仓');
    expect(a.plan!.addTriggers.join(' ')).toContain('放量站上颈线');
    expect(a.plan!.summary).toContain('小仓试探');
  });

  it('六维评分完整、总分等于分项之和', () => {
    const a = detectBottoming(bottomingBars(), DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.factors).toHaveLength(6);
    expect(a.factors.reduce((s, f) => s + f.max, 0)).toBe(100);
    expect(a.factors.reduce((s, f) => s + f.score, 0)).toBe(a.score);
    expect(a.score).toBeGreaterThanOrEqual(0);
    expect(a.score).toBeLessThanOrEqual(100);
    for (const f of a.factors) expect(f.plain.length).toBeGreaterThan(8);
  });

  it('判定说明与事实卡齐备，且明确提示下跌中继风险', () => {
    const a = detectBottoming(bottomingBars(), DEFAULT_BOTTOMING_CONFIG, 100)!;
    expect(a.lines.length).toBeGreaterThanOrEqual(5);
    expect(a.lines.join(' ')).toContain('下跌中继');
    expect(a.facts.length).toBeGreaterThanOrEqual(8);
    expect(a.closes.length).toBeCloseTo(200, 0);
    expect(a.dates.length).toBe(a.closes.length);
    expect(a.baseStart).toBeGreaterThanOrEqual(0);
  });

  it('自定义试探仓位生效', () => {
    const cfg = { ...DEFAULT_BOTTOMING_CONFIG, probePct: 0.05, capital: 200000 };
    const a = detectBottoming(bottomingBars(), cfg, 100)!;
    expect(a.plan!.positionPct).toBeCloseTo(0.05, 6);
    expect(a.plan!.amount).toBeCloseTo(10000, 2);
  });
});
