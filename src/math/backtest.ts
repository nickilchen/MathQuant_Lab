/** 向量化回测引擎：仓位信号 → 净值曲线 → 绩效指标 */

export interface BtConfig {
  /** 买入成本（万分之） */
  buyBps: number;
  /** 卖出成本（万分之） */
  sellBps: number;
  /** 卖出印花税（万分之，A 股单边千一） */
  stampBps: number;
}

export const DEFAULT_BT: BtConfig = { buyBps: 2.5, sellBps: 2.5, stampBps: 10 };

export interface BtMetrics {
  totalReturn: number;
  cagr: number;
  annVol: number;
  sharpe: number;
  maxDD: number;
  calmar: number;
  winRate: number;
  turnover: number;
  ir: number;
  beta: number;
}

export interface BtResult {
  dates: string[];
  /** 策略净值（起点 1） */
  equity: number[];
  /** 基准净值（买入持有，起点 1） */
  benchmark: number[];
  /** 每日生效仓位 */
  positions: number[];
  /** 策略日收益 */
  rets: number[];
  metrics: BtMetrics;
}

/**
 * @param dates   日期序列（长度 T）
 * @param close   标的收盘价（长度 T）
 * @param position 目标仓位序列（长度 T，position[t] 在 t 日收盘后生效，作用于 t→t+1 收益）
 * @param bench   基准收盘价（默认同标的）
 */
export function runBacktest(
  dates: string[],
  close: number[],
  position: number[],
  cfg: BtConfig = DEFAULT_BT,
  bench?: number[]
): BtResult {
  const T = close.length;
  const b = bench ?? close;
  const equity = new Array(T).fill(1);
  const benchEq = new Array(T).fill(1);
  const rets = new Array(T).fill(0);
  const pos = position.map((p) => Math.max(-1, Math.min(1, p || 0)));

  for (let t = 1; t < T; t++) {
    const r = close[t - 1] > 0 ? close[t] / close[t - 1] - 1 : 0;
    const held = pos[t - 1];
    // 换手成本：在 t 日调整仓位
    const delta = pos[t] - held;
    const costRate =
      delta > 0 ? (delta * cfg.buyBps) / 1e4 : delta < 0 ? (-delta * (cfg.sellBps + cfg.stampBps)) / 1e4 : 0;
    const net = held * r - costRate;
    rets[t] = net;
    equity[t] = equity[t - 1] * (1 + net);
    benchEq[t] = benchEq[t - 1] * (1 + (b[t - 1] > 0 ? b[t] / b[t - 1] - 1 : 0));
  }

  const benchRets = rets.map((_, t) => (t === 0 ? 0 : b[t] / b[t - 1] - 1));
  const metrics = computeMetrics(equity, benchEq, rets, benchRets, pos);

  return { dates, equity, benchmark: benchEq, positions: pos, rets, metrics };
}

export function computeMetrics(
  equity: number[],
  benchEq: number[],
  rets: number[],
  benchRets: number[],
  positions: number[]
): BtMetrics {
  const T = equity.length;
  const totalReturn = equity[T - 1] / equity[0] - 1;
  const years = Math.max(T / 252, 0.01);
  const cagr = Math.pow(Math.max(equity[T - 1], 1e-9), 1 / years) - 1;
  const r = rets.slice(1);
  const m = r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0;
  const v = r.length ? r.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(r.length - 1, 1) : 0;
  const annVol = Math.sqrt(v) * Math.sqrt(252);
  const sharpe = annVol > 1e-9 ? (m * 252) / annVol : 0;

  let peak = -Infinity;
  let maxDD = 0;
  for (const e of equity) {
    peak = Math.max(peak, e);
    maxDD = Math.max(maxDD, (peak - e) / peak);
  }
  const calmar = maxDD > 1e-9 ? cagr / maxDD : 0;

  const wins = r.filter((x) => x > 0).length;
  const winRate = r.length ? wins / r.length : 0;

  let turnover = 0;
  for (let t = 1; t < positions.length; t++) turnover += Math.abs(positions[t] - positions[t - 1]);

  // IR / Beta（对基准）
  const br = benchRets.slice(1);
  const bm = br.length ? br.reduce((a, b) => a + b, 0) / br.length : 0;
  let cov = 0;
  let varB = 0;
  for (let i = 0; i < r.length; i++) {
    cov += (r[i] - m) * (br[i] - bm);
    varB += (br[i] - bm) ** 2;
  }
  const beta = varB > 1e-12 ? cov / varB : 0;
  const active = r.map((x, i) => x - br[i]);
  const am = active.reduce((a, b) => a + b, 0) / Math.max(active.length, 1);
  const av = active.reduce((a, b) => a + (b - am) ** 2, 0) / Math.max(active.length - 1, 1);
  const ir = av > 1e-12 ? (am * Math.sqrt(252)) / Math.sqrt(av * 252) : 0;

  return {
    totalReturn,
    cagr,
    annVol,
    sharpe,
    maxDD,
    calmar,
    winRate,
    turnover,
    ir,
    beta
  };
}

export function fmtPct(x: number, digits = 2): string {
  return `${(x * 100).toFixed(digits)}%`;
}
