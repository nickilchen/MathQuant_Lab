/**
 * 趋势法个股分析（Trend-Following Analysis）——小白友好版
 *
 * 输出三层：
 *   1. 七大白话信号（均线排列/金叉死叉/价格位置/趋势强度/通道突破/趋势线/量价配合）
 *   2. 0–100 趋势评分（五维加权）
 *   3. 操作策略：买入/持股/观望/减持/卖出 + 强度星级 + 买入区间 + 建议仓位 + 止损 + 目标位
 *      + 加仓触发条件 + 卖出触发条件（全部用具体价位，小白可直接照着做）
 */
import type { Bar } from '../data/types';
import { adx, donchian, lastValid, linReg, obv, corrTail, sma } from '../math/indicators';

export type SignalStatus = 'bullish' | 'bearish' | 'neutral';

export interface TrendSignal {
  key: string;
  name: string;
  icon: string;
  status: SignalStatus;
  /** 信号强度 0–3 星 */
  stars: number;
  /** 当前状态一句话 */
  statusText: string;
  /** 小白解读：这个信号是什么意思、该怎么做 */
  plain: string;
}

export type ActionType = 'buy' | 'hold' | 'wait' | 'reduce' | 'sell';

export interface TrendStrategy {
  action: ActionType;
  actionLabel: string;
  actionIcon: string;
  /** 综合强度 1–5 星 */
  stars: number;
  /** 建议买入区间（仅 buy/hold 有意义） */
  entryZone: [number, number];
  /** 建议仓位说明 */
  positionPct: string;
  stopLoss: number;
  targets: number[];
  /** 加仓/跟进触发条件（具体价位） */
  buyTriggers: string[];
  /** 卖出触发条件（出现任一条就执行） */
  sellTriggers: string[];
  /** 一句话总结 */
  summary: string;
}

export interface TrendReport {
  price: number;
  date: string;
  ma: { ma5: number; ma10: number; ma20: number; ma60: number; ma250: number };
  maScore: number;
  maAlignment: '多头排列' | '空头排列' | '缠绕';
  /** 5 日均线是否上穿 20 日均线（近 5 日内发生） */
  cross: '金叉' | '死叉' | '无';
  crossDaysAgo: number | null;
  adx: number;
  adxLevel: '强趋势' | '弱趋势' | '无趋势';
  donchian: { upper: number; lower: number; mid: number };
  donchianPos: number;
  breakout: '上破' | '下破' | '通道内';
  regression: { slope: number; r2: number; direction: '上升' | '下降' | '横盘' };
  pvCorr: number;
  obvSlope: number;
  pos52: number;
  high52: number;
  low52: number;
  score: number;
  verdict: '强势上涨' | '温和上涨' | '震荡整理' | '温和下跌' | '强势下跌';
  support: number;
  resistance: number;
  stopLoss: number;
  target: number;
  signals: TrendSignal[];
  strategy: TrendStrategy;
}

export function analyzeTrend(bars: Bar[]): TrendReport {
  const closes = bars.map((b) => b.close);
  const vols = bars.map((b) => b.volume);
  const T = closes.length;
  const price = closes[T - 1];

  /* ================= 基础指标 ================= */
  const ma5 = lastValid(sma(closes, 5));
  const ma10 = lastValid(sma(closes, 10));
  const ma20 = lastValid(sma(closes, 20));
  const ma60 = lastValid(sma(closes, 60));
  const ma250 = lastValid(sma(closes, 250));
  const ma5s = sma(closes, 5);
  const ma20s = sma(closes, 20);
  const mas = [ma5, ma10, ma20, ma60];
  let maScore = 0;
  for (let i = 0; i < mas.length - 1; i++) if (mas[i] > mas[i + 1]) maScore++;
  const maAlignment: TrendReport['maAlignment'] =
    maScore === 3 ? '多头排列' : maScore === 0 && ma5 < ma10 && ma10 < ma20 && ma20 < ma60 ? '空头排列' : '缠绕';

  // 近 5 日金叉/死叉检测
  let cross: TrendReport['cross'] = '无';
  let crossDaysAgo: number | null = null;
  for (let back = 1; back <= 5 && back < T; back++) {
    const i = T - 1 - back;
    if (Number.isNaN(ma5s[i]) || Number.isNaN(ma20s[i]) || Number.isNaN(ma5s[i - 1]) || Number.isNaN(ma20s[i - 1])) continue;
    if (ma5s[i - 1] <= ma20s[i - 1] && ma5s[i] > ma20s[i]) {
      cross = '金叉';
      crossDaysAgo = back;
      break;
    }
    if (ma5s[i - 1] >= ma20s[i - 1] && ma5s[i] < ma20s[i]) {
      cross = '死叉';
      crossDaysAgo = back;
      break;
    }
  }

  const adxArr = adx(bars, 14);
  const adxV = Number.isFinite(lastValid(adxArr)) ? lastValid(adxArr) : 0;
  const adxLevel: TrendReport['adxLevel'] = adxV >= 25 ? '强趋势' : adxV >= 18 ? '弱趋势' : '无趋势';

  const dc = donchian(bars, 20);
  const dcU = lastValid(dc.upper);
  const dcL = lastValid(dc.lower);
  const dcM = lastValid(dc.mid);
  const range = dcU - dcL;
  const donchianPos = range > 0 ? Math.max(0, Math.min(1, (price - dcL) / range)) : 0.5;
  const prevClose = closes[T - 2] ?? price;
  const prevU = dc.upper[T - 2] ?? dcU;
  const prevL = dc.lower[T - 2] ?? dcL;
  const breakout: TrendReport['breakout'] =
    prevClose <= prevU && price > dcU ? '上破' : prevClose >= prevL && price < dcL ? '下破' : '通道内';

  const win = Math.min(60, T);
  const reg = linReg(closes.slice(-win));
  const regSlopePct = reg.slope / price;
  const regDirection: TrendReport['regression']['direction'] =
    reg.r2 > 0.25 && regSlopePct > 0.0003 ? '上升' : reg.r2 > 0.25 && regSlopePct < -0.0003 ? '下降' : '横盘';

  const pvCorr = corrTail(closes, vols, 20);
  const obvArr = obv(bars);
  const obvReg = linReg(obvArr.slice(-20));
  const obvSlope = obvReg.slope / (Math.abs(lastValid(obvArr)) || 1);

  const win52 = Math.min(250, T);
  const slice = closes.slice(-win52);
  const high52 = Math.max(...slice);
  const low52 = Math.min(...slice);
  const pos52 = high52 > low52 ? (price - low52) / (high52 - low52) : 0.5;

  /* ================= 五维评分 ================= */
  const sMa = 0.7 * (maScore / 3) + 0.3 * Math.max(-1, Math.min(1, (ma5 / ma60 - 1) / 0.06));
  const sReg = Math.max(-1, Math.min(1, (regSlopePct / 0.0015) * reg.r2));
  const sAdx = Math.min(1, adxV / 40) * Math.sign(sReg);
  const sDc = (donchianPos - 0.5) * 2;
  const sPv = Math.max(-1, Math.min(1, pvCorr * 1.5)) * 0.5 + Math.max(-1, Math.min(1, obvSlope * 20)) * 0.5;
  const raw = 0.3 * sMa + 0.25 * sReg + 0.2 * sAdx + 0.15 * sDc + 0.1 * sPv;
  const score = Math.round(50 + 50 * Math.max(-1, Math.min(1, raw)));
  const verdict: TrendReport['verdict'] =
    score >= 75 ? '强势上涨' : score >= 58 ? '温和上涨' : score > 42 ? '震荡整理' : score > 25 ? '温和下跌' : '强势下跌';

  /* ================= 关键位 ================= */
  const support = Math.max(dcL, ma60 > 0 ? Math.min(ma60, dcL * 1.02) : dcL);
  const resistance = Math.min(dcU, ma60 > 0 ? Math.max(ma60, dcU * 0.98) : dcU);
  const stopLoss = Math.max(low52, Math.min(support, price * 0.92));
  // 目标位：取 阻力/52周高/现价+12% 的合理值；价格已在高位时保底 +5%（新高后无既有阻力，用趋势投影）
  const target = Math.max(Math.min(high52, Math.max(resistance, price * 1.12)), price * 1.05);

  /* ================= 七大白话信号 ================= */
  const signals: TrendSignal[] = [];

  // 1. 均线排列
  signals.push({
    key: 'ma',
    name: '均线排列',
    icon: '📏',
    status: maAlignment === '多头排列' ? 'bullish' : maAlignment === '空头排列' ? 'bearish' : 'neutral',
    stars: maAlignment === '多头排列' ? 3 : maAlignment === '空头排列' ? 3 : maScore >= 2 ? 2 : maScore <= 1 ? 1 : 1,
    statusText:
      maAlignment === '多头排列'
        ? `多头排列（MA5 ${ma5.toFixed(2)} > MA10 > MA20 > MA60）`
        : maAlignment === '空头排列'
          ? `空头排列（MA5 ${ma5.toFixed(2)} < MA10 < MA20 < MA60）`
          : `均线缠绕（MA5 ${ma5.toFixed(2)}，趋势方向不明）`,
    plain:
      maAlignment === '多头排列'
        ? '短期均线在长期均线上方，说明最近买入的人平均成本更高，是典型的上升趋势，可以顺势持股或买入。'
        : maAlignment === '空头排列'
          ? '短期均线在长期均线下方，说明下跌趋势中抢反弹的人都被套住，反弹容易遇阻，应谨慎。'
          : '各条均线纠缠在一起，说明多空双方力量均衡，没有明确方向，此时最忌追涨杀跌，建议观望。'
  });

  // 2. 金叉死叉
  signals.push({
    key: 'cross',
    name: '金叉 / 死叉',
    icon: '✂️',
    status: cross === '金叉' ? 'bullish' : cross === '死叉' ? 'bearish' : 'neutral',
    stars: cross === '无' ? 0 : 3,
    statusText:
      cross === '金叉'
        ? `${crossDaysAgo} 日前出现金叉（MA5 上穿 MA20）`
        : cross === '死叉'
          ? `${crossDaysAgo} 日前出现死叉（MA5 下穿 MA20）`
          : '近 5 日无金叉/死叉',
    plain:
      cross === '金叉'
        ? '金叉是最经典的买入信号之一：5 日均线（短期成本）上穿 20 日均线（中期成本），说明短期资金开始占上风，通常视为买入时机。'
        : cross === '死叉'
          ? '死叉是经典卖出信号：5 日均线下穿 20 日均线，说明短期资金撤离，下跌可能刚开始，持股者应减仓避险。'
          : '近期没有出现金叉或死叉，趋势没有发生转折，维持原有方向判断即可。'
  });

  // 3. 价格位置
  const aboveMa20 = price > ma20;
  signals.push({
    key: 'price',
    name: '价格位置',
    icon: '📍',
    status: aboveMa20 ? 'bullish' : 'bearish',
    stars: aboveMa20 ? 2 : 2,
    statusText: `现价 ${price.toFixed(2)} ${aboveMa20 ? '站上' : '跌破'} 20 日均线（${ma20.toFixed(2)}），位于 52 周区间 ${(pos52 * 100).toFixed(0)}% 位置`,
    plain: aboveMa20
      ? `价格站在 20 日均线上方，属于强势区域。目前处于近一年高低点之间的 ${(pos52 * 100).toFixed(0)}% 位置${pos52 > 0.8 ? '，接近一年高位，追高需谨慎' : pos52 < 0.3 ? '，接近一年低位，性价比相对较高' : '，位置中性'}。`
      : `价格跌到 20 日均线下方，属于弱势区域。目前处于近一年高低点之间的 ${(pos52 * 100).toFixed(0)}% 位置，此时买入如同"徒手接飞刀"，建议等价格重新站上均线再考虑。`
  });

  // 4. 趋势强度 ADX
  signals.push({
    key: 'adx',
    name: '趋势强度 (ADX)',
    icon: '💪',
    status: adxLevel === '强趋势' ? (sReg >= 0 ? 'bullish' : 'bearish') : 'neutral',
    stars: adxLevel === '强趋势' ? 2 : adxLevel === '弱趋势' ? 1 : 0,
    statusText: `ADX = ${adxV.toFixed(1)}（${adxLevel}）`,
    plain:
      adxLevel === '强趋势'
        ? `ADX 大于 25，说明趋势非常明显（当前为${regDirection === '上升' ? '上升' : regDirection === '下降' ? '下降' : '横盘'}趋势）。趋势越强，顺势操作的成功率越高，可以按信号方向操作。`
        : adxLevel === '弱趋势'
          ? 'ADX 在 18–25 之间，趋势存在但不够强，此时操作要降低仓位、设好止损。'
          : 'ADX 低于 18，说明市场没有明确趋势、来回震荡。此时任何趋势信号都容易失效，最适合的策略是空仓观望，等趋势明朗再说。'
  });

  // 5. 通道突破
  signals.push({
    key: 'donchian',
    name: '通道突破',
    icon: '🚪',
    status: breakout === '上破' ? 'bullish' : breakout === '下破' ? 'bearish' : 'neutral',
    stars: breakout === '通道内' ? 0 : 3,
    statusText:
      breakout === '上破'
        ? `今日突破 20 日新高 ${dcU.toFixed(2)}！`
        : breakout === '下破'
          ? `今日跌破 20 日新低 ${dcL.toFixed(2)}！`
          : `通道内运行（${dcL.toFixed(2)} ~ ${dcU.toFixed(2)}），处于通道 ${(donchianPos * 100).toFixed(0)}% 位置`,
    plain:
      breakout === '上破'
        ? '价格创出近 20 日新高并突破"通道"上轨，这是强烈的做多信号，说明买盘力量压过卖盘，可考虑跟进（注意结合大盘环境）。'
        : breakout === '下破'
          ? '价格创出近 20 日新低并跌破通道下轨，这是强烈的看空信号，持股者应止损离场，不要盲目抄底。'
          : `价格在近 20 日高低点之间运行，处于通道的 ${(donchianPos * 100).toFixed(0)}% 位置。靠近上轨（${dcU.toFixed(2)}）遇阻可考虑减仓，靠近下轨（${dcL.toFixed(2)}）缩量止跌可考虑轻仓试多。`
  });

  // 6. 趋势线
  signals.push({
    key: 'regline',
    name: '趋势线',
    icon: '📈',
    status: regDirection === '上升' ? 'bullish' : regDirection === '下降' ? 'bearish' : 'neutral',
    stars: regDirection === '横盘' ? 0 : reg.r2 > 0.5 ? 3 : 2,
    statusText: `60 日趋势线${regDirection}（日均 ${(regSlopePct * 100).toFixed(3)}%，可信度 R²=${reg.r2.toFixed(2)}）`,
    plain:
      regDirection === '上升'
        ? `把最近 60 天的收盘价用一条直线拟合，直线向上倾斜且可信度 ${reg.r2 > 0.5 ? '较高' : '一般'}，说明中期趋势向上，每次回调到趋势线附近都是相对安全的买入参考区。`
        : regDirection === '下降'
          ? `拟合趋势线向下倾斜，说明中期趋势向下，反弹到趋势线附近会遇阻，是减仓/回避区域。`
          : '拟合趋势线基本走平，说明中期没有方向，属于横盘震荡，适合高抛低吸或观望。'
  });

  // 7. 量价配合
  signals.push({
    key: 'pv',
    name: '量价配合',
    icon: '📊',
    status: pvCorr > 0.2 ? 'bullish' : pvCorr < -0.2 ? 'bearish' : 'neutral',
    stars: Math.abs(pvCorr) > 0.4 ? 2 : 1,
    statusText: `价量相关系数 ${pvCorr.toFixed(2)}（${pvCorr > 0.2 ? '量价齐升，健康' : pvCorr < -0.2 ? '价涨量缩/价跌量增，乏力' : '量价关系中性'}）`,
    plain:
      pvCorr > 0.2
        ? '价格上涨时成交量也放大，说明上涨有真实资金推动，是健康的上涨，可持续性较强。'
        : pvCorr < -0.2
          ? '价格上涨时成交量反而萎缩（或下跌放量），说明上涨缺乏资金支持，可能是"虚涨"，要警惕回落。'
          : '价格与成交量关系不明显，暂时看不出资金态度，结合其他信号判断。'
  });

  /* ================= 操作策略 ================= */
  const strategy = buildStrategy({
    price, score, adxV, adxLevel, ma5, ma20, ma60, dcU, dcL,
    support, resistance, stopLoss, target, high52, low52,
    maAlignment, cross, breakout, regDirection
  });

  return {
    price, date: bars[T - 1].date,
    ma: { ma5, ma10, ma20, ma60, ma250 },
    maScore, maAlignment, cross, crossDaysAgo,
    adx: adxV, adxLevel,
    donchian: { upper: dcU, lower: dcL, mid: dcM },
    donchianPos, breakout,
    regression: { slope: regSlopePct, r2: reg.r2, direction: regDirection },
    pvCorr, obvSlope, pos52, high52, low52,
    score, verdict, support, resistance, stopLoss, target,
    signals, strategy
  };
}

function buildStrategy(ctx: {
  price: number; score: number; adxV: number; adxLevel: string;
  ma5: number; ma20: number; ma60: number; dcU: number; dcL: number;
  support: number; resistance: number; stopLoss: number; target: number;
  high52: number; low52: number;
  maAlignment: string; cross: string; breakout: string; regDirection: string;
}): TrendStrategy {
  const { price, score, adxLevel, ma20, dcU, stopLoss, target } = ctx;

  // 行动映射
  let action: ActionType;
  if (score >= 70) action = 'buy';
  else if (score >= 58) action = 'buy';
  else if (score > 45) action = 'wait';
  else if (score > 30) action = 'reduce';
  else action = 'sell';

  const actionMeta: Record<ActionType, { label: string; icon: string }> = {
    buy: { label: '买入', icon: '🟢' },
    hold: { label: '持股', icon: '🔵' },
    wait: { label: '观望', icon: '🟡' },
    reduce: { label: '减持', icon: '🟠' },
    sell: { label: '卖出', icon: '🔴' }
  };

  // 强度星级 1–5：由评分与 ADX 共同决定
  let stars = 1;
  if (action === 'buy') stars = score >= 75 && adxLevel === '强趋势' ? 5 : score >= 70 ? 4 : 3;
  else if (action === 'wait') stars = 3;
  else if (action === 'reduce') stars = 2;
  else stars = score <= 25 && adxLevel === '强趋势' ? 5 : score <= 40 ? 4 : 3;

  // 买入区间：现价 ~ MA20 回踩区（不追高）
  const entryLow = Math.min(price, ma20) * 0.995;
  const entryHigh = Math.max(price, ma20) * 1.005;
  const entryZone: [number, number] = [Number(entryLow.toFixed(2)), Number(entryHigh.toFixed(2))];

  // 建议仓位
  let positionPct: string;
  if (action === 'buy') {
    positionPct = stars >= 5 ? '40%–60%' : stars >= 4 ? '30%–50%' : '20%–30%';
  } else if (action === 'wait') {
    positionPct = '0–20%（试探仓）';
  } else if (action === 'reduce') {
    positionPct = '降至 20% 以下';
  } else {
    positionPct = '0%（清仓离场）';
  }

  // 加仓/跟进触发
  const buyTriggers: string[] = [];
  if (ctx.breakout !== '上破') buyTriggers.push(`放量突破 ${dcU.toFixed(2)}（20 日高点）可跟进`);
  buyTriggers.push(`回踩 ${ma20.toFixed(2)}（20 日均线）不破且缩量，是低风险买点`);
  buyTriggers.push(`站稳 ${ctx.ma60.toFixed(2)}（60 日均线）后可加一档仓`);

  // 卖出触发
  const sellTriggers: string[] = [
    `跌破止损价 ${stopLoss.toFixed(2)}，无条件卖出（止损铁律）`,
    `出现 MA5 下穿 MA20 死叉，减仓至少一半`,
    `单日大跌超过 7%，次日不能快速收回则离场`
  ];
  if (ctx.cross === '死叉') sellTriggers.push('近期已出现死叉，持股者优先降低仓位');

  // 一句话总结
  const summaryMap: Record<ActionType, string> = {
    buy: `趋势向上且评分 ${score} 分，可在 ${entryZone[0]}–${entryZone[1]} 区间分批买入，止损 ${stopLoss.toFixed(2)}，第一目标 ${target.toFixed(2)}。`,
    hold: '趋势仍在，继续持股，让利润奔跑，用止损价保护本金。',
    wait: `趋势不明显（评分 ${score} 分），建议观望。等放量突破 ${dcU.toFixed(2)} 或回踩 ${ma20.toFixed(2)} 缩量止跌再考虑。`,
    reduce: `趋势转弱（评分 ${score} 分），建议减仓至轻仓，跌破 ${stopLoss.toFixed(2)} 则清仓。`,
    sell: `趋势向下且评分 ${score} 分，空仓回避。等待重新站上 ${ma20.toFixed(2)} 并出现金叉后再评估。`
  };

  return {
    action,
    actionLabel: actionMeta[action].label,
    actionIcon: actionMeta[action].icon,
    stars,
    entryZone,
    positionPct,
    stopLoss,
    // 第二目标：默认取 52 周高点；若与第一目标重合（价格已在新高），改用趋势投影 +20%
    targets: [target, target >= ctx.high52 - 1e-9 ? price * 1.2 : ctx.high52],
    buyTriggers,
    sellTriggers,
    summary: summaryMap[action]
  };
}
