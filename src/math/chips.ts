/**
 * 筹码分布 / 持仓成本分析（纯函数）
 *
 * 回答三个问题：
 *   1. 现在这只票的筹码（持仓成本）集中在哪些价位？——成本分布 + 峰位
 *   2. 现价上方是套牢盘还是下方是获利盘？——获利比例 + 90% 成本区间
 *   3. 筹码是集中还是发散？——集中度 + 单峰/多峰形态
 *
 * 模型（流通筹码衰减法，通达信式的经典近似）：
 *   - 把价格轴切成 N 个格子，每个格子记录「当前还有多少比例的筹码成本落在这里」；
 *   - 逐日迭代：历史筹码 ×(1 − 当日换手率)，再把当日成交「按三角形分布」摊到
 *     [low, high] 区间（顶点在当日均价），乘以换手率后累加；
 *   - 这样换手越快的日子，历史筹码被冲刷得越多，新成本占比越大。
 *
 * ⚠️ 数据口径（务必在界面讲清楚，不造假）：
 *   本站只有日 K 的价格与成交量，**没有历史每日流通股本**，拿不到真实换手率。
 *   这里用「当日量 / 近 N 日均量 × 基准换手率」作为换手率的**代理**，
 *   它反映的是「相对哪几天换手更剧烈」，不是交易所披露的真实换手率。
 *   因此得到的是**近似的成本分布**，用于观察结构变化，不能当成精确的机构持仓数据。
 */
import type { Bar } from '../data/types';

export interface ChipConfig {
  /** 价格网格数（越大越精细，也越吃性能） */
  bins: number;
  /** 相对量能 = 1 时的换手率代理基准，如 0.015 表示 1.5% */
  baseTurnover: number;
  /** 计算相对量能的均量窗口 */
  volWindow: number;
  /** 回看交易日数（只用最近这么多根 K 线模拟筹码） */
  lookback: number;
}

export const DEFAULT_CHIP: ChipConfig = {
  bins: 80,
  baseTurnover: 0.015,
  volWindow: 20,
  lookback: 120
};

export interface ChipBin {
  /** 格子中心价 */
  price: number;
  /** 该价位筹码占比 0~1 */
  ratio: number;
  /** 从最低价到该价的累计占比 0~1 */
  cumulative: number;
}

export interface ChipPeak {
  price: number;
  ratio: number;
}

export type ChipShape = 'single' | 'double' | 'multi' | 'diffuse';

export interface ChipResult {
  bins: ChipBin[];
  /** 现价（最后一根收盘） */
  price: number;
  /** 平均成本 */
  avgCost: number;
  /** 中位成本（50% 分位） */
  medianCost: number;
  /** 获利盘比例 0~1：成本低于现价的筹码占比 */
  profitRatio: number;
  /** 90% 成本区间下沿（5% 分位） */
  costLow: number;
  /** 90% 成本区间上沿（95% 分位） */
  costHigh: number;
  /** 集中度 = (high−low)/(high+low)，0~1，越小越集中 */
  concentration: number;
  /** 集中度高低的文字判断 */
  concentrationLabel: string;
  /** 主要峰（最多 3 个，占比从高到低） */
  peaks: ChipPeak[];
  shape: ChipShape;
  shapeLabel: string;
  /** 现价相对成本区的位置描述 */
  position: string;
  /** 一句话结论 */
  verdict: string;
  /** 可解释结论（逐条） */
  lines: string[];
  /** 实际使用的 K 线根数 */
  usedBars: number;
}

/** 换手率代理序列：当日量 / 近 N 日均量 × 基准换手率，夹在 [0,1] */
export function turnoverSeries(bars: Bar[], cfg: ChipConfig): number[] {
  const n = bars.length;
  const out = new Array<number>(n).fill(0);
  const win = Math.max(1, Math.floor(cfg.volWindow));
  for (let i = 0; i < n; i++) {
    const start = Math.max(0, i - win + 1);
    let sum = 0;
    let cnt = 0;
    for (let t = start; t <= i; t++) {
      sum += Number.isFinite(bars[t].volume) ? bars[t].volume : 0;
      cnt++;
    }
    const avg = cnt > 0 ? sum / cnt : 0;
    const rel = avg > 0 ? (bars[i].volume || 0) / avg : 1;
    out[i] = Math.min(1, Math.max(0, cfg.baseTurnover * rel));
  }
  return out;
}

/**
 * 三角形分布权重：在 [low, high] 上以 apex 为顶点做三角，落到给定价格格子上。
 * 归一化后和为 1；区间退化或顶点非法时退化为均匀分布。
 */
export function triWeights(low: number, high: number, apex: number, grid: number[]): number[] {
  const lo = Math.min(low, high);
  const hi = Math.max(low, high);
  const raw = grid.map((p) => {
    if (hi - lo <= 1e-12) return p >= lo - 1e-9 && p <= hi + 1e-9 ? 1 : 0;
    if (p < lo || p > hi) return 0;
    // 顶点夹进区间，并用 OHLC 均价兜底非法值
    const a = Number.isFinite(apex) ? Math.min(hi, Math.max(lo, apex)) : (lo + hi) / 2;
    if (a <= lo + 1e-12) return p >= a ? 1 : (p - lo) / (hi - lo);
    if (a >= hi - 1e-12) return p <= a ? 1 : (hi - p) / (hi - lo);
    return p <= a ? (p - lo) / (a - lo) : (hi - p) / (hi - a);
  });
  const sum = raw.reduce((s, x) => s + x, 0);
  return sum > 0 ? raw.map((x) => x / sum) : raw.map(() => 1 / grid.length);
}

/** 当日均价：优先成交额/成交量，量级异常时退回 OHLC 均价（避免单位差异把顶点顶到最高价） */
function barApex(b: Bar): number {
  const ohlc = (b.open + b.close + b.high + b.low) / 4;
  const implied = b.volume > 0 && b.amount > 0 ? b.amount / b.volume : NaN;
  // A 股 amount 单位元、volume 单位手时，implied 会是每股价的 100 倍；用价格区间校验
  if (Number.isFinite(implied) && implied >= b.low * 0.9 && implied <= b.high * 1.1) return implied;
  return Number.isFinite(ohlc) ? ohlc : b.close;
}

/** 在升序网格上按累计占比插值取 q 分位价格 */
function quantile(grid: number[], ratios: number[], q: number): number {
  let acc = 0;
  for (let i = 0; i < grid.length; i++) {
    const next = acc + ratios[i];
    if (next >= q) {
      const f = ratios[i] > 1e-12 ? (q - acc) / ratios[i] : 0;
      return grid[i] + (f - 0.5) * (grid.length > 1 ? grid[1] - grid[0] : 0);
    }
    acc = next;
  }
  return grid[grid.length - 1];
}

/** 检测主要峰：局部极大且显著高于平均占比 */
function detectPeaks(grid: number[], ratios: number[]): ChipPeak[] {
  const n = grid.length;
  if (n === 0) return [];
  const avg = ratios.reduce((s, x) => s + x, 0) / n;
  const threshold = avg * 1.3;
  const cand: ChipPeak[] = [];
  for (let i = 0; i < n; i++) {
    const left = i > 0 ? ratios[i - 1] : -1;
    const right = i < n - 1 ? ratios[i + 1] : -1;
    if (ratios[i] >= left && ratios[i] >= right && ratios[i] >= threshold) {
      cand.push({ price: grid[i], ratio: ratios[i] });
    }
  }
  // 合并相邻格子的峰（间隔小于 3 格视为同一个峰，取占比最大的）
  cand.sort((a, b) => b.ratio - a.ratio);
  const picked: ChipPeak[] = [];
  const step = n > 1 ? Math.abs(grid[1] - grid[0]) : 1;
  for (const c of cand) {
    if (picked.every((p) => Math.abs(p.price - c.price) > step * 3)) picked.push(c);
    if (picked.length >= 3) break;
  }
  return picked;
}

function shapeOf(peaks: ChipPeak[], concentration: number, maxRatio: number, avgRatio: number): { shape: ChipShape; label: string } {
  if (peaks.length === 0 || maxRatio < avgRatio * 1.5) {
    return { shape: 'diffuse', label: '筹码发散·无明显峰' };
  }
  if (peaks.length === 1) {
    return concentration <= 0.3
      ? { shape: 'single', label: '单峰密集' }
      : { shape: 'diffuse', label: '单峰但偏宽' };
  }
  if (peaks.length === 2) return { shape: 'double', label: '双峰对峙' };
  return { shape: 'multi', label: '多峰分布' };
}

/**
 * 筹码分布分析。K 线不足 30 根时返回 null（样本太少，硬算会给出假结构）。
 */
export function analyzeChips(bars: Bar[], cfg: ChipConfig = DEFAULT_CHIP): ChipResult | null {
  const used = bars.slice(-Math.max(30, Math.floor(cfg.lookback)));
  if (used.length < 30) return null;

  let pMin = Infinity;
  let pMax = -Infinity;
  for (const b of used) {
    if (Number.isFinite(b.low)) pMin = Math.min(pMin, b.low);
    if (Number.isFinite(b.high)) pMax = Math.max(pMax, b.high);
  }
  if (!(pMax > pMin) || !Number.isFinite(pMin) || !Number.isFinite(pMax)) return null;

  const bins = Math.max(10, Math.min(300, Math.floor(cfg.bins)));
  const step = (pMax - pMin) / bins;
  const grid = Array.from({ length: bins }, (_, i) => pMin + step * (i + 0.5));
  const chips = new Array<number>(bins).fill(0);
  const turns = turnoverSeries(used, cfg);

  for (let i = 0; i < used.length; i++) {
    const t = turns[i];
    if (!(t > 0)) continue;
    // 历史筹码按换手率衰减
    for (let k = 0; k < bins; k++) chips[k] *= 1 - t;
    // 当日成交按三角形摊入价格格子
    const b = used[i];
    const w = triWeights(b.low, b.high, barApex(b), grid);
    for (let k = 0; k < bins; k++) chips[k] += t * w[k];
  }

  const total = chips.reduce((s, x) => s + x, 0);
  if (!(total > 0)) return null;
  const ratios = chips.map((x) => x / total);

  // 累计占比
  const chipBins: ChipBin[] = [];
  let acc = 0;
  for (let i = 0; i < bins; i++) {
    acc += ratios[i];
    chipBins.push({ price: grid[i], ratio: ratios[i], cumulative: acc });
  }

  const price = used[used.length - 1].close;
  const avgCost = grid.reduce((s, p, i) => s + p * ratios[i], 0);
  const medianCost = quantile(grid, ratios, 0.5);
  const costLow = quantile(grid, ratios, 0.05);
  const costHigh = quantile(grid, ratios, 0.95);
  // 获利盘：成本低于现价的筹码占比（用格子中心价近似）
  let profitRatio = 0;
  for (let i = 0; i < bins; i++) if (grid[i] <= price) profitRatio += ratios[i];
  profitRatio = Math.min(1, Math.max(0, profitRatio));

  const denom = costHigh + costLow;
  const concentration = denom > 0 ? Math.abs(costHigh - costLow) / denom : 1;
  const concentrationLabel = concentration <= 0.2 ? '高度集中' : concentration <= 0.35 ? '较集中' : concentration <= 0.55 ? '中等' : '发散';

  const peaks = detectPeaks(grid, ratios);
  const avgRatio = 1 / bins;
  const maxRatio = ratios.reduce((m, x) => Math.max(m, x), 0);
  const { shape, label: shapeLabel } = shapeOf(peaks, concentration, maxRatio, avgRatio);

  // 现价位置
  let position: string;
  if (price > costHigh) position = '现价在成本密集区上方，获利盘主导';
  else if (price < costLow) position = '现价在成本密集区下方，套牢盘主导';
  else if (price >= avgCost) position = '现价在成本区上半部，多数筹码已获利';
  else position = '现价在成本区下半部，多数筹码仍套牢';

  // 结论
  const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
  const lines: string[] = [];
  lines.push(
    `用最近 ${used.length} 根日 K 模拟筹码：平均成本 ${avgCost.toFixed(2)}，中位成本 ${medianCost.toFixed(2)}；` +
      `90% 的筹码成本落在 ${costLow.toFixed(2)} ~ ${costHigh.toFixed(2)} 之间。`
  );
  lines.push(
    `现价 ${price.toFixed(2)}，获利盘约 ${pct(profitRatio)}、套牢盘约 ${pct(1 - profitRatio)}。${position}。`
  );
  const peakText = peaks.length ? peaks.map((p) => `${p.price.toFixed(2)}（${pct(p.ratio)}）`).join('、') : '无明显峰';
  lines.push(`成本峰位：${peakText}；形态为「${shapeLabel}」，集中度 ${concentration.toFixed(2)}（${concentrationLabel}，数值越小越集中）。`);
  if (shape === 'single' && concentration <= 0.3) {
    lines.push('单峰且筹码集中：成本高度趋同，上方套牢盘轻、下方获利盘扎实，一旦突破密集区往往走得较顺；但若现价已在峰上方较远，要防获利盘兑现。');
  } else if (shape === 'double') {
    lines.push('双峰对峙：上方峰是套牢压力、下方峰是支撑。价格在两峰之间反复时，哪个峰被有效吞掉，往往决定下一步方向。');
  } else if (shape === 'multi') {
    lines.push('多峰分布：不同价位都有大量筹码，分歧较大，短线容易反复震荡，趋势性较弱。');
  } else {
    lines.push('筹码发散、没有明显密集峰：成本分散说明持仓分歧大，缺乏统一的支撑/压力参考，信号意义弱。');
  }
  lines.push('口径提醒：换手率由「当日量 / 近 20 日均量 × 基准换手率」代理，非交易所真实换手率；筹码分布只是对成本结构的近似模拟，用于看结构而非精确持仓。');

  let verdict: string;
  if (profitRatio >= 0.85 && price > costHigh) verdict = '获利盘高位·防兑现';
  else if (profitRatio <= 0.15 && price < costLow) verdict = '深度套牢·上方压力大';
  else if (shape === 'single' && concentration <= 0.3) verdict = '筹码集中·方向易展开';
  else if (shape === 'double') verdict = '双峰对峙·看哪边先破';
  else verdict = '成本分歧·震荡为主';

  return {
    bins: chipBins,
    price,
    avgCost,
    medianCost,
    profitRatio,
    costLow,
    costHigh,
    concentration,
    concentrationLabel,
    peaks,
    shape,
    shapeLabel,
    position,
    verdict,
    lines,
    usedBars: used.length
  };
}
