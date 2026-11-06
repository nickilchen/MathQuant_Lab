/**
 * 技术面体检（纯函数）
 *
 * 和「趋势法七信号」的分工：
 *  - 趋势法回答「现在该不该买、买多少、止损在哪」——偏决策，给小白看；
 *  - 技术面体检回答「这只票现在的技术状态如何」——偏体检，给具体数值。
 *
 * 所以这里不做仓位建议，只把 MACD / RSI / KDJ / BOLL / ATR / 量能 / OBV
 * 七个指标的真实读数摆出来，每个都标「超买 / 中性 / 超卖」并给一句人话解释，
 * 最后合成一个 0~100 的技术面评分。
 *
 * 评分是加减分制（基准 50），每一项都能说出为什么加分或减分，不做黑箱。
 */
import { atr, bollinger, linReg, macd, obv, rsi } from './indicators';
import type { Bar } from '../data/types';

export type TechTone = 'up' | 'down' | 'flat';

export interface TechRow {
  key: string;
  label: string;
  /** 展示值，如「DIF 2.31 / DEA 1.85」 */
  value: string;
  tone: TechTone;
  /** 状态词：超买 / 强势 / 中性 / 弱势 / 超卖 */
  state: string;
  /** 一句话解释 */
  note: string;
  /** 对总分的贡献（正=加分，负=减分） */
  delta: number;
}

export interface TechSnapshot {
  /** 0~100 技术面综合评分 */
  score: number;
  verdict: string;
  rows: TechRow[];
  /** 一句话总结 */
  summary: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const last = (x: number[]): number => {
  for (let i = x.length - 1; i >= 0; i--) if (Number.isFinite(x[i])) return x[i];
  return NaN;
};

/** KDJ(9,3,3)：RSV 的 3 日平滑 */
export function kdj(bars: Bar[], n = 9, k1 = 3, d1 = 3): { k: number[]; d: number[]; j: number[] } {
  const k: number[] = new Array(bars.length).fill(NaN);
  const d: number[] = new Array(bars.length).fill(NaN);
  const j: number[] = new Array(bars.length).fill(NaN);
  let pk = 50;
  let pd = 50;
  for (let i = 0; i < bars.length; i++) {
    if (i < n - 1) continue;
    let hi = -Infinity;
    let lo = Infinity;
    for (let t = i - n + 1; t <= i; t++) {
      hi = Math.max(hi, bars[t].high);
      lo = Math.min(lo, bars[t].low);
    }
    const rsv = hi === lo ? 50 : ((bars[i].close - lo) / (hi - lo)) * 100;
    pk = (pk * (k1 - 1) + rsv) / k1;
    pd = (pd * (d1 - 1) + pk) / d1;
    k[i] = pk;
    d[i] = pd;
    j[i] = 3 * pk - 2 * pd;
  }
  return { k, d, j };
}

/** 金叉/死叉距今天数（找不到返回 null） */
function crossDays(dif: number[], dea: number[]): { dir: 'golden' | 'dead'; days: number } | null {
  for (let i = dif.length - 1; i > 0 && dif.length - i < 40; i--) {
    const a0 = dif[i - 1] - dea[i - 1];
    const a1 = dif[i] - dea[i];
    if (!Number.isFinite(a0) || !Number.isFinite(a1)) continue;
    if (a0 <= 0 && a1 > 0) return { dir: 'golden', days: dif.length - 1 - i };
    if (a0 >= 0 && a1 < 0) return { dir: 'dead', days: dif.length - 1 - i };
  }
  return null;
}

/**
 * 技术面体检。
 * 数据不足 60 根时返回 null（指标需要预热，硬算会给出假信号）。
 */
export function analyzeTechnicals(bars: Bar[]): TechSnapshot | null {
  if (!bars || bars.length < 60) return null;

  const closes = bars.map((b) => b.close);
  const price = closes[closes.length - 1];

  const m = macd(closes);
  const dif = last(m.dif);
  const dea = last(m.dea);
  const hist = last(m.hist);
  const histPrev = m.hist[m.hist.length - 2];
  const cross = crossDays(m.dif, m.dea);

  const rsiArr = rsi(closes, 14);
  const rsiV = last(rsiArr);

  const kd = kdj(bars);
  const kV = last(kd.k);
  const dV = last(kd.d);
  const jV = last(kd.j);

  const boll = bollinger(closes, 20, 2);
  const up = last(boll.up);
  const low = last(boll.low);
  const mid = last(boll.mid);
  const pctB = up === low ? 0.5 : (price - low) / (up - low);
  const bandwidth = mid > 0 ? (up - low) / mid : 0;

  const atrArr = atr(bars, 14);
  const atrV = last(atrArr);
  const atrPct = price > 0 ? (atrV / price) * 100 : 0;

  const vol5 = bars.slice(-5).reduce((s, b) => s + (b.volume || 0), 0) / 5;
  const vol20 = bars.slice(-20).reduce((s, b) => s + (b.volume || 0), 0) / 20;
  const volRatio = vol20 > 0 ? vol5 / vol20 : 1;

  const obvArr = obv(bars);
  const obvTail = obvArr.slice(-20).filter((v) => Number.isFinite(v));
  const obvSlope = obvTail.length >= 5 ? linReg(obvTail).slope : 0;

  const rows: TechRow[] = [];

  /* ---- MACD ---- */
  let macdDelta = 0;
  let macdState = '中性';
  let macdNote = '快慢线纠缠，方向不明';
  if (Number.isFinite(hist)) {
    if (hist > 0 && hist >= (Number.isFinite(histPrev) ? histPrev : 0)) {
      macdDelta = 12;
      macdState = '多头';
      macdNote = '红柱在放大，上涨动能还在增强';
    } else if (hist > 0) {
      macdDelta = 6;
      macdState = '偏多';
      macdNote = '红柱缩短，上涨动能在衰减';
    } else if (hist < 0 && hist <= (Number.isFinite(histPrev) ? histPrev : 0)) {
      macdDelta = -12;
      macdState = '空头';
      macdNote = '绿柱在放大，下跌动能还在释放';
    } else {
      macdDelta = -6;
      macdState = '偏空';
      macdNote = '绿柱缩短，下跌动能在衰减';
    }
    if (cross) {
      macdNote += `；${cross.days === 0 ? '今日' : `${cross.days} 日前`}${cross.dir === 'golden' ? '金叉' : '死叉'}`;
      macdDelta += cross.dir === 'golden' ? 4 : -4;
    }
  }
  rows.push({
    key: 'macd',
    label: 'MACD',
    value: `DIF ${dif.toFixed(2)} / DEA ${dea.toFixed(2)} / 柱 ${hist.toFixed(2)}`,
    tone: macdDelta > 0 ? 'up' : macdDelta < 0 ? 'down' : 'flat',
    state: macdState,
    note: macdNote,
    delta: macdDelta
  });

  /* ---- RSI ---- */
  let rsiDelta = 0;
  let rsiState = '中性';
  let rsiNote = '多空力量均衡';
  if (Number.isFinite(rsiV)) {
    if (rsiV >= 75) {
      rsiDelta = -10;
      rsiState = '超买';
      rsiNote = '短期涨过头，追高容易被套';
    } else if (rsiV >= 65) {
      rsiDelta = 6;
      rsiState = '强势';
      rsiNote = '多头占优，但离超买不远';
    } else if (rsiV <= 25) {
      rsiDelta = 8;
      rsiState = '超卖';
      rsiNote = '跌过头，容易出现反弹（不是买入理由）';
    } else if (rsiV <= 35) {
      rsiDelta = -6;
      rsiState = '弱势';
      rsiNote = '空头占优，反弹力度有限';
    } else {
      rsiDelta = 0;
      rsiState = '中性';
      rsiNote = '处在 35~65 的常态区间';
    }
  }
  rows.push({
    key: 'rsi',
    label: 'RSI(14)',
    value: Number.isFinite(rsiV) ? rsiV.toFixed(1) : '—',
    tone: rsiDelta > 0 ? 'up' : rsiDelta < 0 ? 'down' : 'flat',
    state: rsiState,
    note: rsiNote,
    delta: rsiDelta
  });

  /* ---- KDJ ---- */
  let kdjDelta = 0;
  let kdjState = '中性';
  let kdjNote = 'K/D 未给出明确方向';
  if (Number.isFinite(kV) && Number.isFinite(dV)) {
    if (kV > dV && kV < 80) {
      kdjDelta = 6;
      kdjState = '偏多';
      kdjNote = 'K 在 D 上方，短线偏强';
    } else if (kV > dV && kV >= 80) {
      kdjDelta = -2;
      kdjState = '高位';
      kdjNote = '高位金叉，追进去容易吃回调';
    } else {
      kdjDelta = -6;
      kdjState = '偏空';
      kdjNote = 'K 在 D 下方，短线偏弱';
    }
    if (Number.isFinite(jV)) {
      if (jV > 100) {
        kdjDelta -= 4;
        kdjNote += '；J 值破 100，极度超买';
      } else if (jV < 0) {
        kdjDelta += 4;
        kdjNote += '；J 值跌破 0，极度超卖';
      }
    }
  }
  rows.push({
    key: 'kdj',
    label: 'KDJ(9,3,3)',
    value: `K ${kV.toFixed(1)} / D ${dV.toFixed(1)} / J ${jV.toFixed(1)}`,
    tone: kdjDelta > 0 ? 'up' : kdjDelta < 0 ? 'down' : 'flat',
    state: kdjState,
    note: kdjNote,
    delta: kdjDelta
  });

  /* ---- BOLL ---- */
  let bollDelta = 0;
  let bollState = '中性';
  let bollNote = '价格在通道中部';
  if (Number.isFinite(pctB)) {
    if (pctB > 1) {
      bollDelta = -8;
      bollState = '突破上轨';
      bollNote = '价格冲出上轨，短线极度过热，回归中轨的概率高';
    } else if (pctB > 0.95) {
      bollDelta = -6;
      bollState = '贴上轨';
      bollNote = '贴着上轨走，短线过热';
    } else if (pctB > 0.5) {
      bollDelta = 6;
      bollState = '偏强';
      bollNote = '运行在通道上半区';
    } else if (pctB > 0.05) {
      bollDelta = -4;
      bollState = '偏弱';
      bollNote = '运行在通道下半区';
    } else {
      bollDelta = 4;
      bollState = '贴下轨';
      bollNote = '贴着下轨，短线超跌';
    }
  }
  rows.push({
    key: 'boll',
    label: '布林带(20,2)',
    value: `${low.toFixed(2)} ~ ${up.toFixed(2)}（%B ${(pctB * 100).toFixed(0)}%）`,
    tone: bollDelta > 0 ? 'up' : bollDelta < 0 ? 'down' : 'flat',
    state: bollState,
    note: `${bollNote}；带宽 ${(bandwidth * 100).toFixed(1)}%${bandwidth < 0.06 ? '（收口，变盘前兆）' : ''}`,
    delta: bollDelta
  });

  /* ---- ATR 波动 ---- */
  const atrHigh = atrPct > 4;
  rows.push({
    key: 'atr',
    label: 'ATR(14)',
    value: `${atrV.toFixed(2)}（占价 ${atrPct.toFixed(1)}%）`,
    tone: atrHigh ? 'down' : 'flat',
    state: atrHigh ? '高波动' : atrPct < 1.5 ? '低波动' : '正常',
    note:
      atrPct > 4
        ? '日均波动很大，止损要放宽，仓位要放小'
        : atrPct < 1.5
          ? '波动很小，常见于横盘蓄势'
          : '波动处于常态区间',
    delta: 0
  });

  /* ---- 量能 ---- */
  let volDelta = 0;
  let volState = '正常';
  let volNote = '成交量与近期持平';
  if (volRatio > 1.3) {
    volDelta = 6;
    volState = '放量';
    volNote = '近 5 日明显放量，资金关注度提升';
  } else if (volRatio < 0.7) {
    volDelta = -6;
    volState = '缩量';
    volNote = '近 5 日明显缩量，参与意愿不足';
  }
  rows.push({
    key: 'vol',
    label: '量能（5/20 日）',
    value: `${volRatio.toFixed(2)}×`,
    tone: volDelta > 0 ? 'up' : volDelta < 0 ? 'down' : 'flat',
    state: volState,
    note: volNote,
    delta: volDelta
  });

  /* ---- OBV ---- */
  let obvDelta = 0;
  let obvState = '中性';
  let obvNote = '资金流向没有明显方向';
  if (Math.abs(obvSlope) > 0) {
    if (obvSlope > 0) {
      obvDelta = 6;
      obvState = '流入';
      obvNote = '上涨日成交更活跃，资金在进';
    } else {
      obvDelta = -6;
      obvState = '流出';
      obvNote = '下跌日成交更活跃，资金在出';
    }
  }
  rows.push({
    key: 'obv',
    label: 'OBV 资金流',
    value: obvSlope > 0 ? '向上' : obvSlope < 0 ? '向下' : '走平',
    tone: obvDelta > 0 ? 'up' : obvDelta < 0 ? 'down' : 'flat',
    state: obvState,
    note: obvNote,
    delta: obvDelta
  });

  /* ---- 综合评分 ---- */
  const raw = 50 + rows.reduce((s, r) => s + r.delta, 0);
  const score = Math.round(clamp(raw, 0, 100));
  const verdict =
    score >= 70 ? '技术面强势' : score >= 55 ? '技术面偏强' : score >= 45 ? '技术面中性' : score >= 30 ? '技术面偏弱' : '技术面弱势';

  const bull = rows.filter((r) => r.tone === 'up').length;
  const bear = rows.filter((r) => r.tone === 'down').length;
  const summary = `${rows.length} 项指标里 ${bull} 项偏多、${bear} 项偏空，技术面评分 ${score}（${verdict.replace('技术面', '')}）。`;

  return { score, verdict, rows, summary };
}
