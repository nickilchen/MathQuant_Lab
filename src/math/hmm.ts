/**
 * 高斯发射隐马尔可夫模型（HMM）
 *  - 发射概率：各维独立的多元高斯 N(mu_i, diag(var_i))
 *  - 训练：Baum-Welch（EM，带数值缩放）
 *  - 解码：Viterbi 最可能状态路径
 *  - 滤波：前向算法输出逐时刻状态后验概率
 */
import { mean, variance } from './stats';

export interface HmmModel {
  K: number;
  D: number;
  pi: number[];
  A: number[][];
  mu: number[][];
  var: number[][];
  scalerMean: number[];
  scalerStd: number[];
}

export interface HmmOutput {
  model: HmmModel;
  loglik: number;
  /** T×K 滤波概率 */
  filtered: number[][];
  /** T 维 Viterbi 路径 */
  path: number[];
  /** 按平均收益降序排列后的状态顺序：0=趋势上涨 … K-1=趋势下跌 */
  order: number[];
  labels: string[];
}

const EPS = 1e-10;
const VAR_FLOOR = 1e-3;

function logGauss(x: number[], mu: number[], v: number[]): number {
  let s = 0;
  for (let d = 0; d < x.length; d++) {
    const vd = Math.max(v[d], VAR_FLOOR);
    s += Math.log(2 * Math.PI * vd) + ((x[d] - mu[d]) * (x[d] - mu[d])) / vd;
  }
  return -0.5 * s;
}

function standardize(obsRaw: number[][]): { obs: number[][]; mu: number[]; sd: number[] } {
  const D = obsRaw[0].length;
  const mu: number[] = [];
  const sd: number[] = [];
  for (let d = 0; d < D; d++) {
    const col = obsRaw.map((o) => o[d]);
    mu.push(mean(col));
    sd.push(Math.max(Math.sqrt(variance(col)), 1e-6));
  }
  const obs = obsRaw.map((o) => o.map((v, d) => (v - mu[d]) / sd[d]));
  return { obs, mu, sd };
}

/** 观测序列构造：[对数收益率, 20日已实现波动率] */
export function buildHmmObs(closes: number[], volWindow = 20): number[][] {
  const T = closes.length;
  const obs: number[][] = [];
  for (let t = 1; t < T; t++) {
    const r = Math.log(closes[t] / closes[t - 1]);
    const from = Math.max(0, t - volWindow);
    const win: number[] = [];
    for (let k = from + 1; k <= t; k++) win.push(Math.log(closes[k] / closes[k - 1]));
    const v = win.length > 1 ? Math.sqrt(variance(win)) : 0.01;
    obs.push([r, v]);
  }
  return obs;
}

/**
 * 带缩放的前向算法（对任意给定模型）。
 * 返回逐时刻滤波概率与对数似然 log P(o|λ) = Σ log(scale_t)。
 * 训练（Baum-Welch 的 E 步）与外部校验共用此函数。
 */
export function hmmForward(model: HmmModel, obsRaw: number[][]): { filtered: number[][]; scale: number[]; loglik: number } {
  const { K } = model;
  const T = obsRaw.length;
  const alpha: number[][] = [];
  const scale: number[] = [];
  for (let t = 0; t < T; t++) {
    const o = obsRaw[t].map((v, d) => (v - model.scalerMean[d]) / model.scalerStd[d]);
    const row = new Array(K).fill(0);
    for (let i = 0; i < K; i++) {
      const e = Math.exp(logGauss(o, model.mu[i], model.var[i]));
      if (t === 0) row[i] = model.pi[i] * e;
      else {
        let acc = 0;
        for (let j = 0; j < K; j++) acc += alpha[t - 1][j] * model.A[j][i];
        row[i] = acc * e;
      }
    }
    const s = row.reduce((a, b) => a + b, 0) || EPS;
    scale.push(s);
    alpha.push(row.map((v) => v / s));
  }
  return { filtered: alpha, scale, loglik: scale.reduce((a, b) => a + Math.log(b), 0) };
}

export function trainHmm(obsRaw: number[][], K = 4, maxIters = 60): HmmOutput {
  const T = obsRaw.length;
  const D = obsRaw[0].length;
  const { obs, mu: sMean, sd: sStd } = standardize(obsRaw);

  // ---- 初始化：按第一维排序切分 K 组 ----
  const sortedIdx = obs.map((_, i) => i).sort((a, b) => obs[a][0] - obs[b][0]);
  let mu: number[][] = [];
  for (let k = 0; k < K; k++) {
    const lo = Math.floor((k * T) / K);
    const hi = Math.max(Math.floor(((k + 1) * T) / K), lo + 1);
    const group = sortedIdx.slice(lo, hi).map((i) => obs[i]);
    mu.push(Array.from({ length: D }, (_, d) => mean(group.map((g) => g[d]))));
  }
  const globalVar = Array.from({ length: D }, (_, d) => Math.max(variance(obs.map((o) => o[d])), 1e-4));
  let varM: number[][] = mu.map(() => globalVar.map((v) => v * 0.25));
  let pi = new Array(K).fill(1 / K);
  let A: number[][] = Array.from({ length: K }, (_, i) =>
    Array.from({ length: K }, (_, j) => (i === j ? 0.7 : 0.3 / (K - 1)))
  );

  let loglik = -Infinity;
  let alpha: number[][] = [];
  let beta: number[][] = [];
  let scale: number[] = [];

  for (let it = 0; it < maxIters; it++) {
    // ---- E 步：前向（与外部校验共用 hmmForward） ----
    const fw = hmmForward({ K, D, pi, A, mu, var: varM, scalerMean: sMean, scalerStd: sStd }, obsRaw);
    alpha = fw.filtered;
    scale = fw.scale;
    // ---- E 步：带缩放后向 ----
    beta = Array.from({ length: T }, () => new Array(K).fill(0));
    beta[T - 1] = new Array(K).fill(1);
    for (let t = T - 2; t >= 0; t--) {
      for (let i = 0; i < K; i++) {
        let s = 0;
        for (let j = 0; j < K; j++) {
          const e = Math.exp(logGauss(obs[t + 1], mu[j], varM[j]));
          s += A[i][j] * e * beta[t + 1][j];
        }
        beta[t][i] = s / (scale[t + 1] || EPS);
      }
    }
    // ---- gamma ----
    const gamma: number[][] = alpha.map((row, t) => {
      let s = 0;
      for (let i = 0; i < K; i++) s += row[i] * beta[t][i];
      s = s || EPS;
      return row.map((v, i) => (v * beta[t][i]) / s);
    });

    // ---- M 步 ----
    const piN = gamma[0].slice();
    const AN = Array.from({ length: K }, () => new Array(K).fill(0));
    const denomI = new Array(K).fill(0);
    for (let t = 0; t < T - 1; t++) {
      for (let i = 0; i < K; i++) {
        denomI[i] += gamma[t][i];
        for (let j = 0; j < K; j++) {
          const e = Math.exp(logGauss(obs[t + 1], mu[j], varM[j]));
          AN[i][j] += (alpha[t][i] * A[i][j] * e * beta[t + 1][j]) / (scale[t + 1] || EPS);
        }
      }
    }
    for (let i = 0; i < K; i++) {
      const d = denomI[i] || EPS;
      for (let j = 0; j < K; j++) AN[i][j] /= d;
    }
    const gSum = new Array(K).fill(0);
    const muN = Array.from({ length: K }, () => new Array(D).fill(0));
    for (let t = 0; t < T; t++) {
      for (let i = 0; i < K; i++) {
        gSum[i] += gamma[t][i];
        for (let d = 0; d < D; d++) muN[i][d] += gamma[t][i] * obs[t][d];
      }
    }
    for (let i = 0; i < K; i++) for (let d = 0; d < D; d++) muN[i][d] /= gSum[i] || EPS;
    const varN = Array.from({ length: K }, () => new Array(D).fill(0));
    for (let t = 0; t < T; t++) {
      for (let i = 0; i < K; i++) {
        for (let d = 0; d < D; d++) varN[i][d] += gamma[t][i] * (obs[t][d] - muN[i][d]) ** 2;
      }
    }
    for (let i = 0; i < K; i++) for (let d = 0; d < D; d++) varN[i][d] = Math.max(varN[i][d] / (gSum[i] || EPS), VAR_FLOOR);

    pi = piN;
    A = AN;
    mu = muN;
    varM = varN;

    const ll = scale.reduce((a, b) => a + Math.log(b), 0);
    const converged = Math.abs(ll - loglik) < 1e-6;
    loglik = ll;
    if (converged) break;
  }

  const model: HmmModel = { K, D, pi, A, mu, var: varM, scalerMean: sMean, scalerStd: sStd };
  const path = viterbi(obs, model);
  const order = Array.from({ length: K }, (_, i) => i).sort((a, b) => mu[b][0] - mu[a][0]);
  const labels = defaultLabels(K, mu, varM);

  return { model, loglik, filtered: alpha, path, order, labels };
}

/**
 * 状态命名（K=4）：
 *   方向带 θ = 0.25×各状态 μ 极差：|μ| ≤ θ 视为「方向不明」
 *   （长牛/长熊窗口中排名靠后的状态 μ 可能仍接近 0，此时按方向命名会误导）
 *   波动带 φ = 0.5×最大状态波动：≥ φ 为高波动
 *   六态命名表：趋势上涨/震荡上涨/趋势下跌/震荡下跌/高波动/窄幅震荡
 *   重名时按 μ 排名回退到四名称池，保证 K 个名称互不相同
 */
function defaultLabels(K: number, mu: number[][], varM: number[][]): string[] {
  const labels = new Array(K).fill('');
  if (K === 4) {
    const mus = mu.map((m) => m[0]);
    const vols = mu.map((_, i) => Math.sqrt(varM[i][1]));
    const spread = Math.max(...mus) - Math.min(...mus);
    const theta = 0.25 * spread;
    const phi = 0.5 * Math.max(...vols);
    const order = Array.from({ length: K }, (_, i) => i).sort((a, b) => mus[b] - mus[a]);
    const pool = ['趋势上涨', '震荡上涨', '震荡下跌', '趋势下跌'];
    const used = new Set<string>();
    order.forEach((si, rank) => {
      const m = mus[si];
      const hv = vols[si] >= phi;
      let name: string;
      if (m > theta) name = hv ? '趋势上涨' : '震荡上涨';
      else if (m < -theta) name = hv ? '趋势下跌' : '震荡下跌';
      else name = hv ? '高波动' : '窄幅震荡';
      if (used.has(name)) {
        // 重名回退：按 μ 排名取四名称池中未用过的名字
        name = pool.find((p) => !used.has(p)) ?? pool[Math.min(rank, 3)];
      }
      used.add(name);
      labels[si] = name;
    });
    if (new Set(labels).size === K) return labels;
  }
  const names4 = ['趋势上涨', '震荡上涨', '震荡下跌', '趋势下跌'];
  const names3 = ['趋势上涨', '震荡', '趋势下跌'];
  const names2 = ['上涨', '下跌'];
  const pool = K === 4 ? names4 : K === 3 ? names3 : K === 2 ? names2 : Array.from({ length: K }, (_, i) => `状态${i + 1}`);
  const order = Array.from({ length: K }, (_, i) => i).sort((a, b) => mu[b][0] - mu[a][0]);
  order.forEach((stateIdx, rank) => {
    labels[stateIdx] = pool[Math.min(rank, pool.length - 1)];
  });
  return labels;
}

/**
 * 状态观点：滤波概率加权的期望状态漂移（标准化 μ），按 μ 极差归一化到 [-1,1]。
 * 比「上涨侧概率」更稳健——不受窗口整体涨跌（长牛/长熊）扭曲。
 */
export function hmmView(filtered: number[][], mu: number[][]): number {
  const spread = Math.max(...mu.map((m) => m[0])) - Math.min(...mu.map((m) => m[0]));
  if (spread < 1e-9) return 0;
  const last = filtered[filtered.length - 1];
  if (!last) return 0;
  let expect = 0;
  for (let i = 0; i < mu.length; i++) expect += (last[i] ?? 0) * mu[i][0];
  return Math.max(-1, Math.min(1, expect / (spread / 2)));
}

export function viterbi(obs: number[][], model: HmmModel): number[] {
  const T = obs.length;
  const { K, pi, A, mu, var: v } = model;
  const delta = Array.from({ length: T }, () => new Array(K).fill(-Infinity));
  const psi = Array.from({ length: T }, () => new Array(K).fill(0));
  for (let i = 0; i < K; i++) delta[0][i] = Math.log(Math.max(pi[i], EPS)) + logGauss(obs[0], mu[i], v[i]);
  for (let t = 1; t < T; t++) {
    for (let j = 0; j < K; j++) {
      let best = -Infinity;
      let arg = 0;
      for (let i = 0; i < K; i++) {
        const val = delta[t - 1][i] + Math.log(Math.max(A[i][j], EPS));
        if (val > best) {
          best = val;
          arg = i;
        }
      }
      delta[t][j] = best + logGauss(obs[t], mu[j], v[j]);
      psi[t][j] = arg;
    }
  }
  const path = new Array(T).fill(0);
  let last = 0;
  let best = -Infinity;
  for (let i = 0; i < K; i++) {
    if (delta[T - 1][i] > best) {
      best = delta[T - 1][i];
      last = i;
    }
  }
  for (let t = T - 1; t >= 0; t--) {
    path[t] = last;
    last = psi[t][last];
  }
  return path;
}

export interface HmmStats {
  state: number;
  label: string;
  days: number;
  avgDailyRet: number;
  annVol: number;
  avgDuration: number;
}

/** 状态统计（用于展示） */
export function hmmStateStats(path: number[], closes: number[], K: number): HmmStats[] {
  // closes 与 path 对齐：path[t] 对应 closes[t+1]（观测从 t=1 开始）
  const rets: number[] = [];
  for (let t = 1; t < closes.length; t++) rets.push(closes[t] / closes[t - 1] - 1);
  const stats: HmmStats[] = [];
  for (let k = 0; k < K; k++) {
    const idx = path.map((p, t) => (p === k ? t : -1)).filter((t) => t >= 0);
    const rs = idx.map((t) => rets[t] ?? 0);
    // 平均持续期
    let runs = 0;
    let prev = -1;
    for (const t of idx) {
      if (t !== prev + 1) runs++;
      prev = t;
    }
    stats.push({
      state: k,
      label: '',
      days: idx.length,
      avgDailyRet: rs.length ? mean(rs) : 0,
      annVol: rs.length > 1 ? Math.sqrt(variance(rs)) * Math.sqrt(252) : 0,
      avgDuration: runs ? idx.length / runs : 0
    });
  }
  return stats;
}

/**
 * 由滤波概率生成目标仓位：
 *   观点 = 滤波概率加权的期望状态漂移（hmmView，按 μ 极差归一化），
 *   超过死区后生效，裁剪到 [-1, 1]。
 *   比「上涨侧概率差」更稳健：不受窗口整体涨跌（长牛/长熊）扭曲。
 */
export function hmmPosition(filtered: number[][], mu: number[][], deadzone = 0.15): number[] {
  const view = hmmView(filtered, mu);
  if (Math.abs(view) < deadzone) return filtered.map(() => 0);
  return filtered.map(() => view);
}
