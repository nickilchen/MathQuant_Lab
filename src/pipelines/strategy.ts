/**
 * 策略引擎：把各模型输出合成为可执行的买卖策略
 *
 * 合成规则（全部透明、可复现）：
 *   1. 观点归一化：HMM / 因子 / 波动率 / MLP 各自映射到 [-1, +1]
 *   2. 加权合成：0.3·HMM + 0.3·因子 + 0.2·波动率 + 0.2·MLP；
 *      MLP 样本外 AUC<0.5 视为无预测力，剔除后权重重新归一化
 *   3. 风险叠加（按序生效）：
 *      a. 逆势降档：综合>+0.1 但 20 日跌幅>8% → 仓位×0.5（等右侧确认）
 *      b. 波动率收缩：GARCH 预测>已实现（上行 regime）→ 仓位×0.5
 *      c. 技术分歧：技术因子<-0.5 且综合偏多 → 仓位封顶 30%
 *      d. 风险档位上限：保守 30% / 稳健 70% / 激进 100%
 *   4. 输出：目标仓位 + 加仓触发 + 减仓触发 + 止损价 + 目标位
 */
import type { Bar, FundFlow } from '../data/types';
import type { BtConfig } from '../math/backtest';
import { lastValid, sma } from '../math/indicators';
import type { Dim } from '../math/factors';
import { runFactorModel, runHmmModel, runMlModel, runVolModel } from './index';
import { hmmView as hmmViewOf } from '../math/hmm';

export type RiskProfile = 'conservative' | 'balanced' | 'aggressive';

const PROFILES: Record<RiskProfile, { maxPos: number; stopPct: number; label: string; desc: string }> = {
  conservative: { maxPos: 0.3, stopPct: 0.05, label: '保守', desc: '单标的最大 30% 仓位，止损 5%' },
  balanced: { maxPos: 0.7, stopPct: 0.08, label: '稳健', desc: '单标的最大 70% 仓位，止损 8%' },
  aggressive: { maxPos: 1.0, stopPct: 0.1, label: '激进', desc: '单标的最大 100% 仓位，止损 10%' }
};

export interface StrategyPlan {
  /** 当前动作 */
  current: string;
  /** 加仓触发条件（含具体价位/信号） */
  addTrigger: string;
  /** 减仓/离场触发条件 */
  reduceTrigger: string;
  /** 止损价 */
  stopLoss: number;
  /** 第一目标位（年线） */
  takeProfit1: number;
  /** 第二目标位（250 日高点） */
  takeProfit2: number;
}

export interface StrategyReport {
  date: string;
  close: number;
  ma20: number;
  ma60: number;
  ma250: number;
  low20: number;
  high250: number;
  rets20: number;
  /** 各模型观点 ∈ [-1,1]；ml 为 null 表示未采用 */
  views: { hmm: number; factor: number; vol: number; ml: number | null };
  composite: number;
  /** 建议目标仓位（已含全部风控规则）∈ [0,1] */
  targetPosition: number;
  bucket: string;
  notes: string[];
  plan: StrategyPlan;
  state: { label: string; prob: number; view: number };
  dims: { dim: Dim; score: number }[];
  proba: number | null;
  volRegime: 'high' | 'low' | 'normal';
  profile: RiskProfile;
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
const pct0 = (x: number) => `${(x * 100).toFixed(0)}%`;

/**
 * 风控叠加规则（纯函数，可独立单测）。
 * 按序生效：逆势降档 → 波动率收缩 → 技术分歧封顶 → 风险档位上限。
 */
export function applyRiskOverlays(
  composite: number,
  rets20: number,
  volRegime: 'high' | 'low' | 'normal',
  techScore: number,
  maxPos: number
): { pos: number; notes: string[] } {
  let pos = Math.max(0, composite);
  const notes: string[] = [];
  if (composite > 0.1 && rets20 < -0.08) {
    pos *= 0.5;
    notes.push(`逆势信号：20 日跌 ${(rets20 * 100).toFixed(1)}%，综合虽偏多但仓位减半，等站稳确认`);
  }
  if (volRegime === 'high') {
    pos *= 0.5;
    notes.push('波动率上行 regime（GARCH 预测>已实现）：仓位减半、止损收紧');
  }
  if (techScore < -0.5 && composite > 0.1) {
    pos = Math.min(pos, 0.3);
    notes.push(`技术面因子 ${techScore.toFixed(2)} 趋势仍弱：仓位封顶 30%`);
  }
  pos = clamp(pos, 0, maxPos);
  return { pos, notes };
}

/** 综合观点 → 仓位档位描述 */
export function bucketOf(pos: number): string {
  return pos >= 0.6 ? '进攻' : pos >= 0.3 ? '标配' : pos > 0.05 ? '试探' : '空仓观望';
}

export function buildStrategy(
  bars: Bar[],
  fundFlow: FundFlow[] | null,
  bondBars: Bar[] | null,
  cfg: BtConfig,
  opts: { hmmK?: number; profile?: RiskProfile } = {}
): StrategyReport {
  const K = opts.hmmK ?? 4;
  const profile = opts.profile ?? 'balanced';
  const prof = PROFILES[profile];

  const hmm = runHmmModel(bars, K, 0.15, cfg);
  const fac = runFactorModel(
    bars,
    fundFlow,
    bondBars,
    { 估值: 0.25, 情绪: 0.25, 资金: 0.25, 技术: 0.25 },
    0.15,
    cfg
  );
  const vol = runVolModel(bars, 0.15, 1.2, cfg);
  const ml = runMlModel(bars, 'mlp', 150, cfg);

  const closes = bars.map((b) => b.close);
  const last = closes.length - 1;
  const ma20 = lastValid(sma(closes, 20));
  const ma60 = lastValid(sma(closes, 60));
  const ma250 = lastValid(sma(closes, 250));
  const low20 = Math.min(...closes.slice(-20));
  const high250 = Math.max(...closes.slice(-250));
  const rets20 = closes.length > 21 ? closes[last] / closes[last - 21] - 1 : 0;

  // ---- 观点归一化 ----
  const mostLikely = hmm.currentProbs.indexOf(Math.max(...hmm.currentProbs));
  // HMM 观点：滤波概率加权的期望状态漂移（不受窗口整体涨跌扭曲）
  const hmmView = hmmViewOf(hmm.output.filtered, hmm.output.model.mu);
  const lastHv = [...vol.hv20].reverse().find((v) => v !== null) ?? 0.15;
  const volView = -clamp((vol.garch.forecast - lastHv) / 0.1, -1, 1);
  const mlUsed = ml.auc >= 0.5;
  const mlView = clamp((ml.lastProba - 0.5) * 4, -1, 1);

  const W = { hmm: 0.3, factor: 0.3, vol: 0.2, ml: 0.2 };
  const wSum = W.hmm + W.factor + W.vol + (mlUsed ? W.ml : 0);
  const composite =
    (W.hmm * hmmView + W.factor * fac.signal + W.vol * volView + (mlUsed ? W.ml * mlView : 0)) / wSum;

  // ---- 风控叠加 ----
  const tech = fac.report.dims.find((d) => d.dim === '技术')?.score ?? 0;
  const overlay = applyRiskOverlays(composite, rets20, vol.regime, tech, prof.maxPos);
  const pos = overlay.pos;
  const notes = overlay.notes.slice();
  if (!mlUsed) notes.unshift('MLP 样本外 AUC<0.5（无预测力），未计入综合观点');

  const bucket = bucketOf(pos);

  const stopLoss = Math.min(low20, closes[last] * (1 - prof.stopPct));
  const plan: StrategyPlan = {
    current:
      pos >= 0.6
        ? `顺势持仓约 ${pct0(pos)}，跟随信号持有`
        : pos >= 0.3
          ? `标配持仓约 ${pct0(pos)}，回调至均线可分批补`
          : pos > 0.05
            ? `试探性仓位约 ${pct0(pos)}，严设止损，等信号转强再加`
            : '空仓观望，等待做多信号共振',
    addTrigger: `HMM 进入上涨侧（概率>60%）且因子 S 站上 +0.15 → 加仓至 ${pct0(clamp(pos + 0.3, 0, prof.maxPos))}`,
    reduceTrigger: `HMM 切换至下跌侧，或因子 S 跌破 −0.15 → 仓位减半；收盘跌破止损价 ${stopLoss.toFixed(2)} → 清仓离场`,
    stopLoss,
    takeProfit1: ma250,
    takeProfit2: high250
  };

  return {
    date: bars[last].date,
    close: closes[last],
    ma20,
    ma60,
    ma250,
    low20,
    high250,
    rets20,
    views: { hmm: hmmView, factor: fac.signal, vol: volView, ml: mlUsed ? mlView : null },
    composite,
    targetPosition: pos,
    bucket,
    notes,
    plan,
    state: { label: hmm.output.labels[mostLikely], prob: hmm.currentProbs[mostLikely] ?? 0, view: hmmView },
    dims: fac.report.dims.map((d) => ({ dim: d.dim, score: d.score })),
    proba: ml.lastProba,
    volRegime: vol.regime,
    profile
  };
}

export interface QuickScan {
  state: string;
  view: number;
  hmmView: number;
  factorSignal: number;
  volRegime: 'high' | 'low' | 'normal';
  composite: number;
  targetPosition: number;
  bucket: string;
  rets20: number;
  close: number;
  /** 数据来源（页面填充，用于降级可见） */
  source?: string;
}

/** 多指数速览：HMM + 因子 + 波动率（不含 MLP，求快），应用相同风控规则 */
export function quickScan(
  bars: Bar[],
  fundFlow: FundFlow[] | null,
  bondBars: Bar[] | null,
  profile: RiskProfile = 'balanced'
): QuickScan {
  const hmm = runHmmModel(bars, 4, 0.15, { buyBps: 0, sellBps: 0, stampBps: 0 });
  const fac = runFactorModel(
    bars,
    fundFlow,
    bondBars,
    { 估值: 0.25, 情绪: 0.25, 资金: 0.25, 技术: 0.25 },
    0.15,
    { buyBps: 0, sellBps: 0, stampBps: 0 },
    Math.max(10, Math.round(bars.length / 100)) // 速览用更粗步长求快
  );
  const vol = runVolModel(bars, 0.15, 1.2, { buyBps: 0, sellBps: 0, stampBps: 0 });

  const closes = bars.map((b) => b.close);
  const rets20 = closes.length > 21 ? closes[closes.length - 1] / closes[closes.length - 22] - 1 : 0;
  const mostLikely = hmm.currentProbs.indexOf(Math.max(...hmm.currentProbs));
  const hmmView = hmmViewOf(hmm.output.filtered, hmm.output.model.mu);
  const lastHv = [...vol.hv20].reverse().find((v) => v !== null) ?? 0.15;
  const volView = -clamp((vol.garch.forecast - lastHv) / 0.1, -1, 1);

  const W = { hmm: 0.375, factor: 0.375, vol: 0.25 };
  const composite = W.hmm * hmmView + W.factor * fac.signal + W.vol * volView;

  const tech = fac.report.dims.find((d) => d.dim === '技术')?.score ?? 0;
  const overlay = applyRiskOverlays(composite, rets20, vol.regime, tech, PROFILES[profile].maxPos);
  const pos = overlay.pos;

  return {
    state: hmm.output.labels[mostLikely],
    view: hmmView,
    hmmView,
    factorSignal: fac.signal,
    volRegime: vol.regime,
    composite,
    targetPosition: pos,
    bucket: bucketOf(pos),
    rets20,
    close: closes[closes.length - 1]
  };
}

export { PROFILES };
