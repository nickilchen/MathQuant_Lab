/**
 * 多维度因子投票择时模型
 *  因子 → 子维度（估值/情绪/资金/技术）→ 加权投票 → 综合信号 S ∈ [-1, +1]
 *  投票映射：分位数模式 vote = dir·(2·pct−1)；z 分数模式 vote = dir·tanh(z/1.5)
 */
import type { Bar, FundFlow } from '../data/types';
import { lastValid, macd, realizedVol, rollingSeries, rsi, sma, bollinger } from './indicators';
import { mean, quantile, rankOf, std } from './stats';

export type Dim = '估值' | '情绪' | '资金' | '技术';

export interface FactorContext {
  bars: Bar[];
  fundFlow: FundFlow[] | null;
  bondBars: Bar[] | null;
}

export interface FactorDef {
  id: string;
  name: string;
  dim: Dim;
  /** +1：指标越高越看多；-1：逆向 */
  dir: 1 | -1;
  mode: 'pct' | 'z';
  desc: string;
  compute: (ctx: FactorContext) => { raw: number; hist: number[] } | null;
}

export interface FactorValue {
  def: FactorDef;
  raw: number;
  vote: number;
  stat: number; // pct 或 z
}

const fmtRatio = (x: number[]) => x.filter(Number.isFinite);

function alignFlow(bars: Bar[], flow: FundFlow[]): { main: number[]; xlarge: number[] } {
  const map = new Map(flow.map((f) => [f.date, f]));
  const main = bars.map((b) => map.get(b.date)?.main ?? NaN);
  const xlarge = bars.map((b) => map.get(b.date)?.xlarge ?? NaN);
  return { main, xlarge };
}

function rollingSum(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  let s = 0;
  let valid = 0;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isNaN(x[i])) {
      s += x[i];
      valid++;
    }
    if (i >= n && !Number.isNaN(x[i - n])) {
      s -= x[i - n];
      valid--;
    }
    if (i >= n - 1 && valid === n) out[i] = s;
  }
  return out;
}

function rollingCountPos(x: number[], n: number): number[] {
  const out = new Array(x.length).fill(NaN);
  for (let i = n - 1; i < x.length; i++) {
    let c = 0;
    let ok = true;
    for (let k = i - n + 1; k <= i; k++) {
      if (Number.isNaN(x[k])) ok = false;
      else if (x[k] > 0) c++;
    }
    if (ok) out[i] = c / n;
  }
  return out;
}

function rollingConsecutive(closes: number[]): number[] {
  const out = new Array(closes.length).fill(NaN);
  let cur = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d === 0) cur = 0;
    else if (i === 1 || (closes[i - 1] - closes[i - 2]) * d <= 0) cur = d > 0 ? 1 : -1;
    else cur += d > 0 ? 1 : -1;
    out[i] = cur;
  }
  return out;
}

function maScore(closes: number[]): number[] {
  const ma5 = sma(closes, 5);
  const ma10 = sma(closes, 10);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  return closes.map((_, i) => {
    if ([ma5[i], ma10[i], ma20[i], ma60[i]].some(Number.isNaN)) return NaN;
    let s = 0;
    if (ma5[i] > ma10[i]) s++;
    if (ma10[i] > ma20[i]) s++;
    if (ma20[i] > ma60[i]) s++;
    return s;
  });
}

export const FACTOR_DEFS: FactorDef[] = [
  // ================= 估值 =================
  {
    id: 'val_ma250', name: '价格/年线偏离', dim: '估值', dir: -1, mode: 'pct',
    desc: '收盘价相对 250 日均线的偏离度，衡量估值贵贱（逆向）',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const ma = sma(closes, 250);
      const series = closes.map((c, i) => (Number.isNaN(ma[i]) ? NaN : c / ma[i] - 1));
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'val_pos52', name: '52 周价格位置', dim: '估值', dir: -1, mode: 'pct',
    desc: '现价在过去 250 日 [最低, 最高] 区间中的位置（逆向）',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const series = closes.map((_, i) => {
        if (i < 249) return NaN;
        const win = closes.slice(i - 249, i + 1);
        const lo = Math.min(...win);
        const hi = Math.max(...win);
        return hi > lo ? (closes[i] - lo) / (hi - lo) : 0.5;
      });
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'val_bond', name: '股债相对动量', dim: '估值', dir: 1, mode: 'z',
    desc: '指数 20 日收益 − 国债 ETF 20 日收益，股债性价比的动量代理',
    compute: ({ bars, bondBars }) => {
      if (!bondBars || bondBars.length < 25) return null;
      const c = bars.map((b) => b.close);
      const b = bondBars.map((x) => x.close);
      const n = Math.min(c.length, b.length);
      const series: number[] = new Array(n).fill(NaN);
      for (let i = 20; i < n; i++) {
        series[i] = c[i] / c[i - 20] - 1 - (b[i] / b[i - 20] - 1);
      }
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },

  // ================= 情绪 =================
  {
    id: 'emo_amount', name: '成交额分位', dim: '情绪', dir: -1, mode: 'pct',
    desc: '当日成交额在过去一年中的分位，过热看空（逆向）',
    compute: ({ bars }) => {
      const amt = bars.map((b) => b.amount);
      const ma = sma(amt, 20);
      const series = amt.map((a, i) => (Number.isNaN(ma[i]) ? NaN : a / ma[i]));
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'emo_vol', name: '量能比', dim: '情绪', dir: -1, mode: 'z',
    desc: '成交量 / 20 日均量，放量意味着情绪亢奋（逆向）',
    compute: ({ bars }) => {
      const vol = bars.map((b) => b.volume);
      const ma = sma(vol, 20);
      const series = vol.map((v, i) => (Number.isNaN(ma[i]) ? NaN : v / ma[i]));
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'emo_amp', name: '振幅分位', dim: '情绪', dir: -1, mode: 'pct',
    desc: '20 日平均 (最高−最低)/收盘，高波动代表情绪不稳（逆向）',
    compute: ({ bars }) => {
      const amp = bars.map((b) => (b.high - b.low) / b.close);
      const series = rollingSeries(amp, 20, mean);
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'emo_consec', name: '连续涨跌天数', dim: '情绪', dir: -1, mode: 'z',
    desc: '连续上涨/下跌天数，逆向指标',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const series = rollingConsecutive(closes);
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },

  // ================= 资金 =================
  {
    id: 'cap_main20', name: '主力20日净流入', dim: '资金', dir: 1, mode: 'z',
    desc: '近 20 日主力资金净流入累计（亿元）',
    compute: ({ bars, fundFlow }) => {
      if (!fundFlow || fundFlow.length < 25) return null;
      const { main } = alignFlow(bars, fundFlow);
      const series = rollingSum(main, 20).map((v) => (Number.isNaN(v) ? NaN : v / 1e8));
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'cap_ratio', name: '主力净流入强度', dim: '资金', dir: 1, mode: 'z',
    desc: '近 20 日主力净流入 / 成交额 均值',
    compute: ({ bars, fundFlow }) => {
      if (!fundFlow || fundFlow.length < 25) return null;
      const { main } = alignFlow(bars, fundFlow);
      const amt = bars.map((b) => b.amount);
      const n = Math.min(main.length, amt.length);
      const series: number[] = new Array(n).fill(NaN);
      for (let i = 19; i < n; i++) {
        let s = 0;
        let ok = true;
        for (let k = i - 19; k <= i; k++) {
          if (Number.isNaN(main[k]) || amt[k] <= 0) ok = false;
          else s += main[k];
        }
        if (ok) {
          const avgAmt = amt.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20;
          series[i] = avgAmt > 0 ? s / avgAmt : NaN;
        }
      }
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'cap_xlarge5', name: '超大单5日趋势', dim: '资金', dir: 1, mode: 'z',
    desc: '近 5 日超大单净流入累计（亿元）',
    compute: ({ bars, fundFlow }) => {
      if (!fundFlow || fundFlow.length < 25) return null;
      const { xlarge } = alignFlow(bars, fundFlow);
      const series = rollingSum(xlarge, 5).map((v) => (Number.isNaN(v) ? NaN : v / 1e8));
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'cap_posdays', name: '资金流入持续性', dim: '资金', dir: 1, mode: 'pct',
    desc: '近 20 日主力净流入为正的天数占比',
    compute: ({ bars, fundFlow }) => {
      if (!fundFlow || fundFlow.length < 25) return null;
      const { main } = alignFlow(bars, fundFlow);
      const series = rollingCountPos(main, 20);
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },

  // ================= 技术 =================
  {
    id: 'tech_ma', name: '均线多头排列', dim: '技术', dir: 1, mode: 'z',
    desc: 'MA5>MA10>MA20>MA60 成立个数（0–3）',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const series = maScore(closes);
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'tech_mom20', name: '20日动量', dim: '技术', dir: 1, mode: 'z',
    desc: '过去 20 个交易日涨跌幅',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const series = closes.map((c, i) => (i < 20 ? NaN : c / closes[i - 20] - 1));
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'tech_rsi', name: 'RSI(14)', dim: '技术', dir: 1, mode: 'z',
    desc: '相对强弱指标，>70 超买 / <30 超卖',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const series = rsi(closes, 14);
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'tech_macd', name: 'MACD 柱', dim: '技术', dir: 1, mode: 'z',
    desc: 'MACD 柱状图（DIF−DEA），归一化到价格',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const { hist } = macd(closes);
      const series = hist.map((h, i) => (Number.isNaN(h) ? NaN : (h / closes[i]) * 100));
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'tech_boll', name: '布林带位置', dim: '技术', dir: 1, mode: 'z',
    desc: '现价在布林带 (20,2) 中的相对位置 %B',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const { up, low } = bollinger(closes, 20, 2);
      const series = closes.map((c, i) => {
        if (Number.isNaN(up[i]) || up[i] <= low[i]) return NaN;
        return (c - low[i]) / (up[i] - low[i]);
      });
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  },
  {
    id: 'tech_hv', name: '已实现波动率', dim: '技术', dir: -1, mode: 'z',
    desc: '20 日年化已实现波动率，高波动环境下谨慎（逆向）',
    compute: ({ bars }) => {
      const closes = bars.map((b) => b.close);
      const series = realizedVol(closes, 20);
      const raw = lastValid(series);
      if (!Number.isFinite(raw)) return null;
      return { raw, hist: fmtRatio(series) };
    }
  }
];

export interface DimScore {
  dim: Dim;
  score: number;
  count: number;
}

export interface FactorReport {
  values: FactorValue[];
  dims: DimScore[];
  signal: number;
}

export function computeFactors(ctx: FactorContext): FactorReport {
  const values: FactorValue[] = [];
  for (const def of FACTOR_DEFS) {
    let out: { raw: number; hist: number[] } | null = null;
    try {
      out = def.compute(ctx);
    } catch {
      out = null;
    }
    if (!out || out.hist.length < 20) continue;
    let stat: number;
    let vote: number;
    if (def.mode === 'pct') {
      stat = rankOf(out.raw, out.hist);
      vote = def.dir * (2 * stat - 1);
    } else {
      const m = mean(out.hist);
      const s = std(out.hist);
      stat = s > 1e-12 ? (out.raw - m) / s : 0;
      vote = def.dir * Math.tanh(stat / 1.5);
    }
    values.push({ def, raw: out.raw, vote: Math.max(-1, Math.min(1, vote)), stat });
  }

  const dimOrder: Dim[] = ['估值', '情绪', '资金', '技术'];
  const dims: DimScore[] = dimOrder.map((dim) => {
    const vs = values.filter((v) => v.def.dim === dim);
    return { dim, score: vs.length ? mean(vs.map((v) => v.vote)) : 0, count: vs.length };
  });

  return { values, dims, signal: 0 };
}

/** 加权合成综合信号 */
export function compositeSignal(dims: DimScore[], weights: Record<Dim, number>): number {
  let num = 0;
  let den = 0;
  for (const d of dims) {
    num += d.score * weights[d.dim];
    den += weights[d.dim];
  }
  return den > 0 ? num / den : 0;
}

/** 信号 → 仓位：超过阈值后线性放大到 ±1 */
export function factorPosition(signalSeries: number[], threshold = 0.15): number[] {
  return signalSeries.map((s) => {
    if (Math.abs(s) < threshold) return 0;
    const mag = Math.min(1, (Math.abs(s) - threshold) / 0.35);
    return Math.sign(s) * mag;
  });
}

/** 全历史信号序列（供回测）：每 step 日用当时可见数据重算，严格无未来函数 */
export function signalSeriesHistory(
  bars: Bar[],
  fundFlow: FundFlow[] | null,
  bondBars: Bar[] | null,
  weights: Record<Dim, number> = { 估值: 0.25, 情绪: 0.25, 资金: 0.25, 技术: 0.25 },
  step = 5
): number[] {
  const out: number[] = [];
  let cur = 0;
  for (let t = 0; t < bars.length; t++) {
    if (t % step === 0) {
      const rep = computeFactors({ bars: bars.slice(0, t + 1), fundFlow, bondBars });
      cur = compositeSignal(rep.dims, weights);
    }
    out.push(cur);
  }
  return out;
}

export { quantile };
