import type { Bar, SymbolDef } from './types';

/** 确定性伪随机（mulberry32），保证同一标的模拟数据可复现 */
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

function hashCode(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** 标准正态（Box-Muller） */
function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-9);
  const v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 离线降级数据：带隐性市场状态切换的几何布朗运动，
 * 让 HMM / GARCH 等模型在演示数据上也能展现真实行为。
 */
export function genSyntheticBars(sym: SymbolDef, days: number): Bar[] {
  const rnd = mulberry32(hashCode(sym.code));
  const bars: Bar[] = [];
  let price = sym.base;
  // 初始日期：从 2023-01-03 起推 days 个自然日中的交易日
  const start = new Date(Date.UTC(2023, 0, 3));
  let d = new Date(start);
  const driftSet = [-0.0009, 0.0001, 0.0007];
  const volSet = [0.022, 0.013, 0.008];
  let regime = 1;
  const push = () => {
    // 跳到下一个工作日
    do {
      d = new Date(d.getTime() + 864e5);
    } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  };
  for (let t = 0; t < days; t++) {
    if (rnd() > 0.985) regime = Math.floor(rnd() * 3);
    const drift = driftSet[regime];
    const vol = volSet[regime] * (0.85 + 0.3 * rnd());
    const ret = drift + vol * gauss(rnd);
    const open = price * (1 + (rnd() - 0.5) * vol * 0.5);
    const close = price * Math.exp(ret);
    const hi = Math.max(open, close) * (1 + Math.abs(gauss(rnd)) * vol * 0.4);
    const lo = Math.min(open, close) * (1 - Math.abs(gauss(rnd)) * vol * 0.4);
    const volume = Math.round((1e6 + rnd() * 4e6) * (1 + Math.abs(ret) * 30));
    bars.push({
      date: d.toISOString().slice(0, 10),
      open,
      close,
      high: hi,
      low: lo,
      volume,
      amount: volume * close
    });
    price = close;
    push();
  }
  return bars;
}
