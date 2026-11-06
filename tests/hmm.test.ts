import { describe, expect, it } from 'vitest';
import { buildHmmObs, hmmPosition, hmmView, trainHmm } from '../src/math/hmm';
import { mulberry32 } from '../src/math/ml';

function gauss(rnd: () => number): number {
  const u = Math.max(rnd(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
}

/** 从已知 2 状态 HMM 生成数据 */
function genTwoState(n: number, seed = 1): { obs: number[][]; truth: number[] } {
  const rnd = mulberry32(seed);
  const mu = [
    [0.002, 0.01],  // 状态0：上涨低波
    [-0.002, 0.025] // 状态1：下跌高波
  ];
  const sd = [
    [0.008, 0.002],
    [0.015, 0.006]
  ];
  let state = 0;
  const obs: number[][] = [];
  const truth: number[] = [];
  for (let t = 0; t < n; t++) {
    if (rnd() > 0.97) state = 1 - state;
    obs.push([mu[state][0] + sd[state][0] * gauss(rnd), mu[state][1] + sd[state][1] * gauss(rnd)]);
    truth.push(state);
  }
  return { obs, truth };
}

describe('HMM', () => {
  const { obs } = genTwoState(600);

  it('Baum-Welch 能反解出两个差异显著的发射均值', () => {
    const out = trainHmm(obs, 2, 40);
    const mus = out.model.mu.map((m) => m[0]);
    const hi = Math.max(...mus);
    const lo = Math.min(...mus);
    // 均值差应显著（原始数据两状态均值差 0.004，标准化后约 0.4+）
    expect(hi - lo).toBeGreaterThan(0.2);
    expect(out.loglik).toBeGreaterThan(-Infinity);
  });

  it('滤波概率每行和为 1', () => {
    const out = trainHmm(obs, 3, 30);
    for (const row of out.filtered) {
      const s = row.reduce((a, b) => a + b, 0);
      expect(s).toBeCloseTo(1, 6);
    }
  });

  it('Viterbi 路径长度与观测一致', () => {
    const out = trainHmm(obs, 2, 20);
    expect(out.path).toHaveLength(obs.length);
    expect(out.path.every((p) => p >= 0 && p < 2)).toBe(true);
  });

  it('状态命名：K=4 互异，方向不明的状态不得被命名为上涨/下跌', () => {
    const out = trainHmm(obs, 4, 30);
    expect(out.order).toHaveLength(4);
    const names = new Set(out.labels);
    expect(names.size).toBe(4);
    const ALLOWED = ['趋势上涨', '震荡上涨', '趋势下跌', '震荡下跌', '高波动', '窄幅震荡'];
    for (const l of out.labels) expect(ALLOWED).toContain(l);
    // order[0] 必须是平均收益最高的状态
    const mus = out.model.mu.map((m) => m[0]);
    expect(out.order[0]).toBe(mus.indexOf(Math.max(...mus)));
    // 方向不明（|μ| ≤ 0.25×极差）的状态必须命名為高波动/窄幅震荡
    const spread = Math.max(...mus) - Math.min(...mus);
    out.labels.forEach((label, si) => {
      if (Math.abs(mus[si]) <= 0.25 * spread) {
        expect(['高波动', '窄幅震荡']).toContain(label);
      }
    });
  });

  it('buildHmmObs 输出 [收益, 波动] 两维且长度 = T-1', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i);
    const o = buildHmmObs(closes, 20);
    expect(o).toHaveLength(59);
    expect(o[0]).toHaveLength(2);
    expect(o[58][0]).toBeGreaterThan(0); // 单边上涨收益为正
  });

  it('hmmView/hmmPosition：概率加权期望漂移，死区内为 0、区间外饱和 ±1', () => {
    const filtered = [
      [0.9, 0.1], // 大概率在高漂移状态
      [0.5, 0.5], // 均衡 → 观点 0 → 死区
      [0.05, 0.95] // 大概率在低漂移状态
    ];
    const mu = [
      [0.5, 0],
      [-0.5, 0]
    ];
    const view = hmmView(filtered, mu);
    // 最后一行滤波：0.05×0.5 + 0.95×(−0.5) = −0.45，极差 1 → 归一化 −0.9
    expect(view).toBeCloseTo(-0.9, 6);
    const pos = hmmPosition(filtered, mu, 0.2);
    expect(pos[0]).toBeCloseTo(-0.9, 6);
    expect(pos[0]).toBeLessThanOrEqual(1);
    // 死区：观点绝对值 < 0.2 时全零
    const flat = hmmPosition([[0.5, 0.5]], mu, 0.2);
    expect(flat[0]).toBe(0);
  });

  it('hmmView 不受窗口整体漂移扭曲（长牛窗口不产生虚假极值）', () => {
    // 全部状态 μ 都偏高（长牛窗口），但当前概率集中在中间状态
    const mu = [
      [0.5, 0],
      [0.05, 0],
      [0.02, 0],
      [-0.01, 0]
    ];
    const filtered = [[0.0, 1.0, 0.0, 0.0]];
    const view = hmmView(filtered, mu);
    // 期望漂移 0.05，极差 0.51 → 归一化 ≈ 0.196，而非旧口径的 +1
    expect(view).toBeGreaterThan(0);
    expect(view).toBeLessThan(0.35);
  });
});
