/**
 * 降波筑底信号（大涨 → 逐级下跌 → 波动与量能收敛 → 低点抬高横盘 → 放量突破）。
 *
 * 和「波段」(3~20 日回踩)、「恐慌抄底」(单日大跌) 都不同：这里识别的是一段
 * **中期底部构造过程**，时间尺度以月计。产品口径是「小仓位试探 + 破底即走」：
 *   - 🟡 筑底中：结构走平 + 低点抬高 + 双收敛达标 → 给 10% 试探仓与铁律止损
 *   - 🟢 筑底确认：必须再叠加「放量突破颈线 + MA20 转上」→ 才允许加到 30%
 *
 * 最重要的一条：**波动收敛 ≠ 见底**。下跌中继平台同样会缩量横盘，
 * 所以只收敛不突破一律停在观察档，绝不升级为买入。
 *
 * 无未来函数：找主升高点只用截至当日的数据；波动/量能峰值取自「高点 →
 * 筑底窗口之前」这一段，不把最新窗口自己算进基准；突破量比用昨日均量，
 * 避免当日放量把自己抬成基准。所有序列指标本身都是因果的。
 */
import type { Bar } from '../data/types';
import { adx, atr, bollinger, donchian, lastValid, linReg, obv, realizedVol, sma } from './indicators';

export interface BottomingConfig {
  /** 主升段：高点前 N 日内涨幅门槛 */
  runUpPct: number;
  runUpWindow: number;
  /** 高点回看窗口（交易日） */
  lookback: number;
  /** 高点距今最少 / 最多交易日 */
  minBarsFromHigh: number;
  maxBarsFromHigh: number;
  /** 自高点最大回撤门槛 */
  dropPct: number;
  /** 波动（ATR% / 布林带宽 / 已实现波动）与量能压缩到峰值的比例上限 */
  compression: number;
  /** 筑底结构观察窗 */
  baseWindow: number;
  /** 回归斜率 / 价格 的绝对值上限（走平） */
  flatSlope: number;
  /** 均线粘合：|MA5-MA20|/价、|MA20-MA60|/价 */
  maGlueShort: number;
  maGlueLong: number;
  /** ADX 力竭阈值 */
  adxMax: number;
  /** 突破量比（今日量 / 昨日 20 日均量） */
  breakoutVol: number;
  /** 进入试探档的最低评分；确认档以「放量突破」事件为准，同样要求不低于此线 */
  probeScore: number;
  /** 试探仓 / 确认后总仓（占本金比例） */
  probePct: number;
  confirmPct: number;
  /** 止损 = 底部低点 − ATR × 倍数 */
  atrStop: number;
  capital: number;
  /** 参考盈亏比 */
  minRR: number;
}

export const DEFAULT_BOTTOMING_CONFIG: BottomingConfig = {
  runUpPct: 0.3,
  runUpWindow: 60,
  lookback: 250,
  minBarsFromHigh: 20,
  maxBarsFromHigh: 180,
  dropPct: 0.2,
  compression: 0.6,
  baseWindow: 20,
  flatSlope: 0.0005,
  maGlueShort: 0.02,
  maGlueLong: 0.05,
  adxMax: 20,
  breakoutVol: 1.5,
  probeScore: 60,
  probePct: 0.1,
  confirmPct: 0.3,
  atrStop: 0.5,
  capital: 100000,
  minRR: 2
};

export type BottomSignal =
  | '不符合形态'
  | '下跌未完'
  | '降波中·观察'
  | '筑底中·小仓试探'
  | '筑底确认·买入'
  | '筑底失败·离场';

export type BottomStage = 'none' | 'decline' | 'compression' | 'base' | 'confirm' | 'failed';

export interface BottomFactor {
  key: string;
  name: string;
  icon: string;
  score: number;
  max: number;
  value: string;
  plain: string;
  ok: boolean;
}

export interface BottomPlan {
  action: 'probe' | 'confirm';
  entryLow: number;
  entryHigh: number;
  stop: number;
  target1: number;
  target2: number;
  rr: number;
  rrOk: boolean;
  neck: number;
  baseLow: number;
  positionPct: number;
  shares: number;
  amount: number;
  riskAmount: number;
  addTriggers: string[];
  exitTriggers: string[];
  summary: string;
}

export interface BottomAnalysis {
  signal: BottomSignal;
  stage: BottomStage;
  score: number;
  close: number;
  high: number;
  highIndex: number;
  barsFromHigh: number;
  runUp: number;
  drawdown: number;
  lowest: number;
  /** 波动/量能压缩比（当前 ÷ 下跌段峰值），越小越收敛 */
  compress: number;
  volCompress: number;
  atrPct: number;
  bandwidth: number;
  volRatio: number;
  adxV: number;
  slopePct: number;
  maGlueShort: number;
  maGlueLong: number;
  higherLow: boolean;
  recentLow: number;
  priorLow: number;
  neck: number;
  baseLow: number;
  compressed: boolean;
  baseStructure: boolean;
  breakout: boolean;
  factors: BottomFactor[];
  plan: BottomPlan | null;
  lines: string[];
  facts: { label: string; value: string; tone: 'up' | 'down' | 'flat' }[];
  /** 图表用：全序列，页面自行截取尾部 */
  dates: string[];
  closes: number[];
  ma20: number[];
  ma60: number[];
  /** 底部结构区起点（下标），用于图表标背景带 */
  baseStart: number;
}

const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const fin = (x: number): boolean => Number.isFinite(x);
const pct = (x: number, d = 1): string => `${(x * 100).toFixed(d)}%`;

function tailAvg(arr: number[], n: number): number {
  const v = arr.slice(-n).filter((x) => fin(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN;
}

/**
 * @param bars 日 K（前复权），至少 120 根；建议 250 根以上
 * @param lot  每手股数，由调用方按市场制度传入
 */
export function detectBottoming(
  bars: Bar[],
  cfg: BottomingConfig = DEFAULT_BOTTOMING_CONFIG,
  lot = 100
): BottomAnalysis | null {
  const T = bars.length;
  if (T < 120) return null;

  const closes = bars.map((b) => b.close);
  const lowArr = bars.map((b) => b.low);
  const vols = bars.map((b) => b.volume);
  const i = T - 1;
  const price = closes[i];
  if (!(price > 0)) return null;

  /* ---------- 因果指标序列 ---------- */
  const atrs = atr(bars, 14);
  const atrPct = atrs.map((v, k) => (closes[k] > 0 && fin(v) ? v / closes[k] : NaN));
  const boll = bollinger(closes, 20, 2);
  const bw = boll.mid.map((m, k) => (fin(m) && m > 0 && fin(boll.up[k]) ? (boll.up[k] - boll.low[k]) / m : NaN));
  const vol20 = sma(vols, 20);
  const hv = realizedVol(closes, 20);
  const ma5 = sma(closes, 5);
  const ma20 = sma(closes, 20);
  const ma60 = sma(closes, 60);
  const adxs = adx(bars, 14);
  const obvs = obv(bars);
  const don = donchian(bars, 20);

  /* ---------- S0 主升前置：只用截至 i 的数据找高点 ---------- */
  const from = Math.max(0, T - Math.min(cfg.lookback, T));
  let highIndex = from;
  for (let k = from + 1; k <= i; k++) if (closes[k] > closes[highIndex]) highIndex = k;
  const high = closes[highIndex];
  const barsFromHigh = i - highIndex;

  const ruStart = Math.max(0, highIndex - cfg.runUpWindow);
  let ruLow = Infinity;
  for (let k = ruStart; k <= highIndex; k++) ruLow = Math.min(ruLow, closes[k]);
  const runUp = ruLow > 0 ? high / ruLow - 1 : 0;
  const hasRunUp =
    runUp >= cfg.runUpPct &&
    barsFromHigh >= cfg.minBarsFromHigh &&
    barsFromHigh <= cfg.maxBarsFromHigh;

  let lowest = Infinity;
  for (let k = highIndex; k <= i; k++) lowest = Math.min(lowest, closes[k]);
  const drawdown = high > 0 ? 1 - lowest / high : 0;
  const hasDecline = drawdown >= cfg.dropPct;

  /* ---------- S2 降波：以下跌段为峰值基准，不含最新筑底窗口 ---------- */
  const W = cfg.baseWindow;
  const peakEnd = Math.min(i, Math.max(highIndex + 2, i - W));
  let atrPeak = -Infinity;
  let bwPeak = -Infinity;
  let volPeak = -Infinity;
  let hvPeak = -Infinity;
  for (let k = highIndex; k <= peakEnd; k++) {
    if (fin(atrPct[k])) atrPeak = Math.max(atrPeak, atrPct[k]);
    if (fin(bw[k])) bwPeak = Math.max(bwPeak, bw[k]);
    if (fin(vol20[k])) volPeak = Math.max(volPeak, vol20[k]);
    if (fin(hv[k])) hvPeak = Math.max(hvPeak, hv[k]);
  }
  if (!fin(atrPeak)) atrPeak = NaN;
  if (!fin(bwPeak)) bwPeak = NaN;
  if (!fin(volPeak)) volPeak = NaN;
  if (!fin(hvPeak)) hvPeak = NaN;

  const atrNow = tailAvg(atrPct, 10);
  const bwNow = tailAvg(bw, 10);
  const volNow = tailAvg(vol20, 10);
  const hvNow = tailAvg(hv, 10);
  const ratioOf = (now: number, peak: number): number =>
    fin(now) && fin(peak) && peak > 0 ? clamp(now / peak, 0, 2) : 1;
  const cAtr = ratioOf(atrNow, atrPeak);
  const cBw = ratioOf(bwNow, bwPeak);
  const cHv = ratioOf(hvNow, hvPeak);
  const compress = (cAtr + cBw + cHv) / 3;
  const volCompress = ratioOf(volNow, volPeak);
  const volRatio = fin(vol20[i - 1]) && vol20[i - 1] > 0 ? bars[i].volume / vol20[i - 1] : 1;

  /* ---------- S3 结构：低点抬高、走平、均线粘合、趋势力竭 ---------- */
  const recentLow = Math.min(...lowArr.slice(-W));
  const priorSlice = lowArr.slice(-2 * W, -W);
  const priorLow = priorSlice.length ? Math.min(...priorSlice) : recentLow;
  const lift = priorLow > 0 ? recentLow / priorLow - 1 : 0;
  const higherLow = lift >= -0.02;

  const reg = linReg(closes.slice(-40));
  const slopePct = price > 0 ? reg.slope / price : 0;
  const flat = Math.abs(slopePct) <= cfg.flatSlope;
  const glueS = fin(ma5[i]) && fin(ma20[i]) ? Math.abs(ma5[i] - ma20[i]) / price : 1;
  const glueL = fin(ma20[i]) && fin(ma60[i]) ? Math.abs(ma20[i] - ma60[i]) / price : 1;
  const glueOk = glueS <= cfg.maGlueShort && glueL <= cfg.maGlueLong;
  const adxV = fin(adxs[i]) ? adxs[i] : 30;

  const pMinNow = Math.min(...closes.slice(-W));
  const pMinPrev = Math.min(...closes.slice(-2 * W, -W));
  const oMinNow = Math.min(...obvs.slice(-W));
  const oMinPrev = Math.min(...obvs.slice(-2 * W, -W));
  const divergence = pMinNow <= pMinPrev * 1.01 && oMinNow > oMinPrev;
  const obvRising = linReg(obvs.slice(-40)).slope > 0;

  /* ---------- 关键位 ---------- */
  const neck = fin(don.upper[i - 1])
    ? don.upper[i - 1]
    : Math.max(...bars.slice(-W - 1, -1).map((b) => b.high));
  const baseLow = Math.min(...lowArr.slice(-40, -3));
  const brokeBase = price < baseLow * 0.99;
  const ma20Up =
    fin(ma20[i]) && fin(ma20[i - 2]) && ma20[i] > ma20[i - 2] && fin(ma60[i]) && price > ma60[i] * 0.98;
  const breakout = price > neck && volRatio >= cfg.breakoutVol && ma20Up;

  /* ---------- 六维打分 ---------- */
  const denom = Math.max(0.05, 1 - cfg.compression);
  const sVol = Math.round(20 * clamp((1 - compress) / denom, 0, 1));
  const sQ = Math.round(20 * clamp((1 - volCompress) / denom, 0, 1));
  const sLow = Math.round(20 * clamp((lift + 0.02) / 0.04, 0, 1));
  const sMa = (glueOk ? 9 : 0) + (flat ? 6 : 0);
  const sAdx = Math.round(15 * clamp((cfg.adxMax * 1.5 - adxV) / (cfg.adxMax), 0, 1));
  const sObv = divergence ? 10 : obvRising ? 6 : 0;
  const score = sVol + sQ + sLow + sMa + sAdx + sObv;

  const compressed = compress <= cfg.compression && volCompress <= cfg.compression;
  const baseStructure = higherLow && flat;

  let signal: BottomSignal;
  let stage: BottomStage;
  if (!hasRunUp || !hasDecline) {
    signal = '不符合形态';
    stage = 'none';
  } else if (brokeBase) {
    signal = '筑底失败·离场';
    stage = 'failed';
  } else if (breakout && higherLow && compressed && score >= cfg.probeScore) {
    // 突破当天必然打破「走平」，所以确认档不要求 flat；
    // 但低点抬高、双收敛、评分线仍然必须成立，避免把单日反抽当反转。
    signal = '筑底确认·买入';
    stage = 'confirm';
  } else if (compressed && baseStructure && score >= cfg.probeScore) {
    signal = '筑底中·小仓试探';
    stage = 'base';
  } else if (compressed || (compress < 0.85 && volCompress < 0.85)) {
    // 必须波动与量能「同时」出现收敛才算降波；单一维度轻微回落（一路阴跌也会有）
    // 不能算，否则会把下跌途中的正常缩量误报成筑底前兆。
    signal = '降波中·观察';
    stage = 'compression';
  } else {
    signal = '下跌未完';
    stage = 'decline';
  }

  /* ---------- 六维明细（白话） ---------- */
  const factors: BottomFactor[] = [
    {
      key: 'vol', name: '波动收敛', icon: '🌊', score: sVol, max: 20,
      value: `${(compress * 100).toFixed(0)}%`,
      plain: `ATR、布林带宽、已实现波动三项平均只剩下跌段的 ${(compress * 100).toFixed(0)}%。${sVol >= 14 ? '日波动明显变小，杀跌力量在衰竭。' : '波动还没压下来，说明多空仍在剧烈分歧。'}`,
      ok: sVol >= 14
    },
    {
      key: 'volume', name: '量能地量', icon: '🔋', score: sQ, max: 20,
      value: `${(volCompress * 100).toFixed(0)}%`,
      plain: `近 10 日均量是下跌段峰值的 ${(volCompress * 100).toFixed(0)}%。${sQ >= 14 ? '卖盘基本枯竭，该跑的差不多跑完了。' : '成交仍活跃，抛压未必结束。'}`,
      ok: sQ >= 14
    },
    {
      key: 'low', name: '低点抬高', icon: '📐', score: sLow, max: 20,
      value: `${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)}%`,
      plain: `最近 ${W} 日最低 ${recentLow.toFixed(2)}，前 ${W} 日最低 ${priorLow.toFixed(2)}。${higherLow ? '没有继续创新低，筑底的必要条件已满足（持平即算合格拿基础分，明显抬高才拿满 20 分）。' : '低点还在下移，这只是下跌途中的平台，不是底。'}`,
      ok: higherLow
    },
    {
      key: 'ma', name: '均线粘合走平', icon: '📏', score: sMa, max: 15,
      value: flat ? '走平' : '仍倾斜',
      plain: `MA5/MA20 差 ${pct(glueS)}、MA20/MA60 差 ${pct(glueL)}，40 日回归斜率 ${(slopePct * 100).toFixed(3)}%/日。${glueOk && flat ? '短中期成本挤在一起、价格不再下倾，筹码在换手。' : '均线还没收拢或仍在下倾，底部没成形。'}`,
      ok: glueOk && flat
    },
    {
      key: 'adx', name: '趋势力竭', icon: '🌀', score: sAdx, max: 15,
      value: adxV.toFixed(1),
      plain: `ADX ${adxV.toFixed(1)}（${cfg.adxMax} 以下视为无明显趋势）。${sAdx >= 10 ? '下跌趋势的力量已经耗尽，进入无趋势震荡。' : '趋势仍有惯性，别急着抄。'}`,
      ok: sAdx >= 10
    },
    {
      key: 'obv', name: '量价底背离', icon: '⚖️', score: sObv, max: 10,
      value: divergence ? '背离' : obvRising ? 'OBV 回升' : '无',
      plain: divergence
        ? '价格接近前低但 OBV 没创新低，说明有资金在悄悄接。'
        : obvRising ? 'OBV 缓慢回升，资金流出趋缓，但还没形成明确背离。' : 'OBV 仍在走低，暂无承接迹象。',
      ok: sObv >= 6
    }
  ];

  /* ---------- 交易计划：小仓试探 / 突破确认 ---------- */
  let plan: BottomPlan | null = null;
  if (signal === '筑底中·小仓试探' || signal === '筑底确认·买入') {
    const confirm = signal === '筑底确认·买入';
    const atrV = lastValid(atrs);
    const atrAbs = fin(atrV) && atrV > 0 ? atrV : price * 0.02;
    const rawEntryLow = confirm ? Math.max(neck * 0.985, price * 0.975) : price * 0.985;
    const rawEntryHigh = confirm ? price * 1.01 : price * 1.005;
    // 止损必须恒低于入场下沿：现价处于箱体底部时，baseLow − 0.5ATR 可能反而更高。
    const stop = Math.max(0.01, Math.min(baseLow - cfg.atrStop * atrAbs, rawEntryLow * 0.97));
    const entryLow = Math.max(rawEntryLow, stop * 1.01);
    const entryHigh = Math.max(rawEntryHigh, entryLow * 1.005);
    const boxH = Math.max(neck - baseLow, price * 0.03);
    let target1 = confirm ? neck + boxH : neck;
    let target2 = confirm ? lowest + (high - lowest) * 0.618 : neck + boxH;
    target1 = Math.max(target1, entryHigh * 1.03);
    target2 = Math.max(target2, target1 * 1.08);
    const rr = (target1 - entryHigh) / Math.max(entryHigh - stop, 0.01);
    const rrOk = rr >= cfg.minRR;
    const positionPct = confirm ? cfg.confirmPct : cfg.probePct;
    // 盈亏比不足时按试探仓执行，不一次打满
    const effPct = rrOk ? positionPct : Math.min(positionPct, cfg.probePct);
    const amount = cfg.capital * effPct;
    const unit = Math.max(1, Math.floor(lot));
    const shares = Math.floor(amount / Math.max(entryHigh, 0.01) / unit) * unit;
    const riskAmount = shares * Math.max(entryHigh - stop, 0);

    const addTriggers = confirm
      ? [
          `回踩颈线 ${neck.toFixed(2)} 不破且缩量 → 可补一次，总仓不超过 ${pct(cfg.confirmPct, 0)}`,
          `站稳 MA60 且 MA20 上穿 MA60 → 趋势确认，按波段规则另算仓位`
        ]
      : [
          `放量站上颈线 ${neck.toFixed(2)}（量比 ≥ ${cfg.breakoutVol}）→ 升为确认档，加到 ${pct(cfg.confirmPct, 0)}`,
          `回踩 ${baseLow.toFixed(2)} 不破且继续缩量 → 可补一次，累计不超过 ${pct(cfg.probePct * 1.5, 0)}`
        ];
    const exitTriggers = [
      `破底即走：收盘跌破 ${stop.toFixed(2)}（底部低点 − ${cfg.atrStop} ATR）立刻清仓，不摊平、不补仓`,
      `横盘超过 ${W * 2} 个交易日仍不突破颈线 → 试探仓减半或退出，时间也是成本`,
      `放量长阴跌破 MA20 → 先走，等形态重建`
    ];

    const summary = confirm
      ? `已放量突破颈线 ${neck.toFixed(2)}，筑底确认。按 ${pct(effPct, 0)} 总仓执行，止损 ${stop.toFixed(2)}，第一目标 ${target1.toFixed(2)}。`
      : `还在筑底，没有突破。只用 ${pct(effPct, 0)} 小仓试探，止损 ${stop.toFixed(2)}；没放量站上 ${neck.toFixed(2)} 之前绝不加满。`;

    plan = {
      action: confirm ? 'confirm' : 'probe',
      entryLow, entryHigh, stop, target1, target2, rr, rrOk, neck, baseLow,
      positionPct: effPct, shares, amount, riskAmount,
      addTriggers, exitTriggers, summary
    };
  }

  /* ---------- 判定说明 ---------- */
  const lines: string[] = [];
  lines.push(
    hasRunUp
      ? `形态前置成立：${cfg.runUpWindow} 日内主升 ${pct(runUp)}，高点 ${high.toFixed(2)} 距今 ${barsFromHigh} 个交易日。`
      : `形态前置不成立：近 ${Math.min(cfg.lookback, T)} 日主升 ${pct(runUp)}、高点距今 ${barsFromHigh} 日，未同时满足「涨幅 ≥ ${pct(cfg.runUpPct, 0)}、距顶 ${cfg.minBarsFromHigh}~${cfg.maxBarsFromHigh} 日」。`
  );
  if (hasRunUp) lines.push(`自高点最大回撤 ${pct(drawdown)}（门槛 ${pct(cfg.dropPct, 0)}），最低 ${lowest.toFixed(2)}。`);
  lines.push(
    `波动压缩 ${(compress * 100).toFixed(0)}%、量能压缩 ${(volCompress * 100).toFixed(0)}%（门槛均 ≤ ${(cfg.compression * 100).toFixed(0)}%）；今日量比 ${volRatio.toFixed(2)}，ADX ${adxV.toFixed(1)}。`
  );
  lines.push(
    higherLow
      ? `低点没有继续下移（近 ${W} 日最低 ${recentLow.toFixed(2)} vs 前 ${W} 日 ${priorLow.toFixed(2)}）。`
      : `低点仍在下移（近 ${W} 日最低 ${recentLow.toFixed(2)} 低于前 ${W} 日 ${priorLow.toFixed(2)}）——这是下跌中继的典型特征。`
  );
  lines.push(`六维评分 ${score}/100（门槛 ${cfg.probeScore}）；确认档额外要求放量突破。颈线 ${neck.toFixed(2)}，底部低点 ${baseLow.toFixed(2)}。突破当天均线会重新张开，评分自然回落属正常。`);

  if (signal === '筑底确认·买入') {
    lines.push(`放量突破颈线且 MA20 转上，底部结构确认。计划给出 ${pct(plan!.positionPct, 0)} 仓位与完整止损/目标。`);
  } else if (signal === '筑底中·小仓试探') {
    lines.push(`结构已走平但还没突破，只给小仓试探。注意：缩量横盘同样可能是下跌中继，所以仓位必须小、止损必须硬。`);
    lines.push(`破底即走：跌破 ${plan!.stop.toFixed(2)} 立即离场。加仓的唯一条件是放量站上颈线，不是「跌了更便宜」。`);
  } else if (signal === '降波中·观察') {
    lines.push(`波动或量能正在收敛，但低点、均线、评分尚未同时达标 → 只观察，不给任何仓位。收敛本身不是买入理由。`);
  } else if (signal === '下跌未完') {
    lines.push(`波动与量能都还没压下来，下跌动能未衰竭，继续空仓等待。`);
  } else if (signal === '筑底失败·离场') {
    lines.push(`收盘已跌破底部低点 ${baseLow.toFixed(2)}，形态失败。若持有试探仓，立即按铁律离场。`);
  } else {
    lines.push(`这不是「大涨后降波筑底」形态，本模块不给信号，请改用波段或恐慌抄底视角。`);
  }
  if (plan && !plan.rrOk) {
    lines.push(`⚠️ 第一目标盈亏比仅 ${plan.rr.toFixed(2)}（参考 ${cfg.minRR}），空间偏小，已把仓位压到试探档，别一次打满。`);
  }

  const facts: BottomAnalysis['facts'] = [
    { label: '主升幅度', value: pct(runUp), tone: runUp >= cfg.runUpPct ? 'up' : 'flat' },
    { label: '最大回撤', value: pct(drawdown), tone: 'down' },
    { label: '距顶天数', value: `${barsFromHigh} 日`, tone: 'flat' },
    { label: '波动压缩', value: `${(compress * 100).toFixed(0)}%`, tone: compressed ? 'up' : 'flat' },
    { label: '量能压缩', value: `${(volCompress * 100).toFixed(0)}%`, tone: volCompress <= cfg.compression ? 'up' : 'flat' },
    { label: '今日量比', value: volRatio.toFixed(2), tone: volRatio >= cfg.breakoutVol ? 'up' : 'flat' },
    { label: '低点变化', value: `${lift >= 0 ? '+' : ''}${(lift * 100).toFixed(1)}%`, tone: higherLow ? 'up' : 'down' },
    { label: 'ADX', value: adxV.toFixed(1), tone: adxV <= cfg.adxMax ? 'up' : 'down' },
    { label: '颈线', value: neck.toFixed(2), tone: 'flat' },
    { label: '底部低点', value: baseLow.toFixed(2), tone: 'flat' }
  ];

  return {
    signal, stage, score, close: price, high, highIndex, barsFromHigh,
    runUp, drawdown, lowest, compress, volCompress,
    atrPct: fin(atrNow) ? atrNow : NaN,
    bandwidth: fin(bwNow) ? bwNow : NaN,
    volRatio, adxV, slopePct, maGlueShort: glueS, maGlueLong: glueL,
    higherLow, recentLow, priorLow, neck, baseLow,
    compressed, baseStructure, breakout,
    factors, plan, lines, facts,
    dates: bars.map((b) => b.date),
    closes,
    ma20, ma60,
    baseStart: Math.max(0, T - 2 * W)
  };
}
