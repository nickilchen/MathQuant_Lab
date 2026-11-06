/**
 * 模型流水线：把数学引擎组装成页面可直接消费的结果
 * 每个函数都是纯函数（输入行情 + 参数 → 输出信号 / 回测），无副作用
 */
import type { Bar, FundFlow } from '../data/types';
import { computeMetrics, runBacktest, type BtConfig, type BtMetrics, type BtResult } from '../math/backtest';
import { logReturns, mean, simpleReturns, std } from '../math/stats';
import { realizedVol } from '../math/indicators';
import { buildHmmObs, hmmPosition, hmmStateStats, trainHmm, type HmmOutput, type HmmStats } from '../math/hmm';import {
  compositeSignal,
  computeFactors,
  factorPosition,
  signalSeriesHistory,
  type Dim,
  type FactorReport
} from '../math/factors';
import { fitGarch11, type GarchResult } from '../math/garch';
import {
  LogisticRegression,
  MLP,
  accuracyScore,
  applyScaler,
  aucScore,
  buildFeatures,
  confusionMatrix,
  fitScaler,
  mlPosition
} from '../math/ml';
import {
  ercWeights,
  hrpWeights,
  inverseVolWeights,
  portfolioVol,
  riskContributions,
  shrinkCov
} from '../math/riskparity';
import { pca, residualMeanReversion, spreadPortfolioReturns } from '../math/pca';

/* ================= M1 HMM ================= */

export interface HmmRun {
  output: HmmOutput;
  dates: string[];
  closes: number[];
  positions: number[];
  bt: BtResult;
  stats: HmmStats[];
  currentProbs: number[];
}

export function runHmmModel(bars: Bar[], K: number, deadzone: number, cfg: BtConfig): HmmRun {
  const closes = bars.map((b) => b.close);
  const obs = buildHmmObs(closes);
  const output = trainHmm(obs, K, 60);
  const dates = bars.slice(1).map((b) => b.date);
  const closes1 = closes.slice(1);
  const positions = hmmPosition(output.filtered, output.model.mu, deadzone);
  const bt = runBacktest(dates, closes1, positions, cfg);
  const stats = hmmStateStats(output.path, closes1, K).map((s) => ({ ...s, label: output.labels[s.state] }));
  const currentProbs = output.filtered[output.filtered.length - 1] ?? [];
  return { output, dates, closes: closes1, positions, bt, stats, currentProbs };
}

/* ================= M2 因子投票 ================= */

export interface FactorRun {
  report: FactorReport;
  signal: number;
  signalHistory: number[];
  positions: number[];
  bt: BtResult;
  dates: string[];
  closes: number[];
}

export function runFactorModel(
  bars: Bar[],
  fundFlow: FundFlow[] | null,
  bondBars: Bar[] | null,
  weights: Record<Dim, number>,
  threshold: number,
  cfg: BtConfig,
  factorStep?: number
): FactorRun {
  const report = computeFactors({ bars, fundFlow, bondBars });
  const signal = compositeSignal(report.dims, weights);
  // 因子历史重算步长随数据量自适应：500 日→5，1000 日→10，2000 日→20，
  // 保持重算次数约 100 次，长周期下计算耗时基本恒定
  const step = factorStep ?? Math.max(5, Math.round(bars.length / 100));
  const signalHistory = signalSeriesHistory(bars, fundFlow, bondBars, weights, step);
  const positions = factorPosition(signalHistory, threshold);
  const dates = bars.map((b) => b.date);
  const closes = bars.map((b) => b.close);
  const bt = runBacktest(dates, closes, positions, cfg);
  return { report, signal, signalHistory, positions, bt, dates, closes };
}

/* ================= M3 波动率 ================= */

export interface VolRun {
  garch: GarchResult;
  hv20: (number | null)[];
  /** IV−HV 价差代理（GARCH 预测 − 已实现） */
  spread: (number | null)[];
  positions: number[];
  bt: BtResult;
  dates: string[];
  closes: number[];
  regime: 'high' | 'low' | 'normal';
}

export function runVolModel(bars: Bar[], targetVol: number, cap: number, cfg: BtConfig): VolRun {
  const closes = bars.map((b) => b.close);
  const lr = logReturns(closes);
  const garch = fitGarch11(lr);
  const hv = realizedVol(closes, 20);
  const T = closes.length;
  const dates = bars.map((b) => b.date);

  // sigma[t] 为第 t 个收益的条件波动率（已知信息截至 t-1），仓位作用于 t→t+1
  const positions = new Array(T).fill(0);
  const spread: (number | null)[] = new Array(T).fill(null);
  const hvAligned: (number | null)[] = new Array(T).fill(null);
  for (let t = 0; t < T - 1; t++) {
    const s = garch.sigma[t];
    positions[t] = Math.max(0, Math.min(cap, targetVol / Math.max(s, 1e-6)));
    const h = hv[t];
    if (!Number.isNaN(h) && Number.isFinite(s)) {
      hvAligned[t] = h;
      spread[t] = s - h;
    }
  }
  const lastSpread = [...spread].reverse().find((v): v is number => v !== null) ?? 0;
  const regime: VolRun['regime'] = lastSpread > 0.02 ? 'high' : lastSpread < -0.02 ? 'low' : 'normal';
  const bt = runBacktest(dates, closes, positions, cfg);
  return { garch, hv20: hvAligned, spread, positions, bt, dates, closes, regime };
}

/* ================= M4 风险平价 ================= */

export type RpMethod = 'erc' | 'hrp' | 'iv' | 'eq';

export interface RpRun {
  codes: string[];
  names: string[];
  dates: string[];
  /** 最新一期权重 */
  weights: Record<RpMethod, number[]>;
  /** 风险贡献（ERC） */
  rc: number[];
  curves: Record<RpMethod, number[]>;
  benchCurve: number[];
  metrics: Record<RpMethod, BtMetrics>;
  vols: number[];
  portVols: Record<RpMethod, number>;
}

export function runRpModel(
  barsMap: Record<string, Bar[]>,
  names: Record<string, string>,
  codes: string[],
  window: number,
  freq: number,
  benchCode: string,
  cfg: BtConfig
): RpRun {
  const n = codes.length;
  const closesAll = codes.map((c) => barsMap[c].map((b) => b.close));
  const T = Math.min(...closesAll.map((c) => c.length));
  const datesAll = barsMap[codes[0]].map((b) => b.date);
  const dates = datesAll.slice(datesAll.length - T);
  const R = closesAll.map((cs) => simpleReturns(cs.slice(cs.length - T))); // 长度 T-1，索引 1..T-1

  const methods: RpMethod[] = ['erc', 'hrp', 'iv', 'eq'];
  const w: Record<RpMethod, number[]> = {
    erc: new Array(n).fill(1 / n),
    hrp: new Array(n).fill(1 / n),
    iv: new Array(n).fill(1 / n),
    eq: new Array(n).fill(1 / n)
  };
  const curves: Record<RpMethod, number[]> = { erc: [1], hrp: [1], iv: [1], eq: [1] };
  let lastWeights = { ...w };

  // R[i] 长度 T-1（索引 0..T-2）；t 时刻持有权重赚取 R[t+1]，故 t 最大为 T-3
  for (let t = window; t < T - 2; t++) {
    if ((t - window) % freq === 0) {
      const win = R.map((r) => r.slice(t - window + 1, t + 1));
      const cov = shrinkCov(win);
      lastWeights = {
        erc: ercWeights(cov),
        hrp: hrpWeights(win),
        iv: inverseVolWeights(win.map((s) => std(s))),
        eq: new Array(n).fill(1 / n)
      };
    }
    w.erc = lastWeights.erc;
    w.hrp = lastWeights.hrp;
    w.iv = lastWeights.iv;
    for (const m of methods) {
      const rNext = R.map((r) => r[t + 1]);
      const port = w[m].reduce((s, wi, i) => s + wi * rNext[i], 0);
      curves[m].push(curves[m][curves[m].length - 1] * (1 + port));
    }
  }

  // 最新一期权重与风险贡献（用全样本最后 window 天）
  const winFinal = R.map((r) => r.slice(r.length - window));
  const covFinal = shrinkCov(winFinal);
  const weights: Record<RpMethod, number[]> = {
    erc: ercWeights(covFinal),
    hrp: hrpWeights(winFinal),
    iv: inverseVolWeights(winFinal.map((s) => std(s))),
    eq: new Array(n).fill(1 / n)
  };
  const rc = riskContributions(weights.erc, covFinal);
  const vols = winFinal.map((s) => std(s) * Math.sqrt(252));

  // 基准（如沪深300ETF）：从同一 window 起点归一化，与曲线对齐
  const benchCloses = barsMap[benchCode]?.map((b) => b.close) ?? closesAll[0];
  const benchSlice = benchCloses.slice(benchCloses.length - T);
  const benchCurve = benchSlice.slice(window).map((c) => c / benchSlice[window]);

  const metrics = {} as Record<RpMethod, BtMetrics>;
  for (const m of methods) {
    const eq = curves[m];
    const rets = eq.map((v, i) => (i === 0 ? 0 : v / eq[i - 1] - 1));
    const bRets = benchCurve.map((v, i) => (i === 0 ? 0 : v / benchCurve[i - 1] - 1));
    metrics[m] = computeMetrics(eq, benchCurve, rets, bRets, new Array(eq.length).fill(0));
  }

  const portVols = {} as Record<RpMethod, number>;
  for (const m of methods) portVols[m] = portfolioVol(weights[m], covFinal) * Math.sqrt(252);

  return {
    codes,
    names: codes.map((c) => names[c] ?? c),
    dates: dates.slice(window),
    weights,
    rc,
    curves,
    benchCurve,
    metrics,
    vols,
    portVols
  };
}

/* ================= M5 PCA 统计套利 ================= */

export interface PcaRun {
  codes: string[];
  names: string[];
  dates: string[];
  eigenvalues: number[];
  explained: number[];
  loadings: number[][];
  zscores: number[][];
  composite: number[];
  equity: number[];
  benchEquity: number[];
  metrics: BtMetrics;
  benchMetrics: BtMetrics;
  activeCount: number[];
}

export function runPcaModel(
  barsMap: Record<string, Bar[]>,
  names: Record<string, string>,
  codes: string[],
  K: number,
  window: number,
  entry: number,
  exit: number,
  cfg: BtConfig
): PcaRun {
  const closesAll = codes.map((c) => barsMap[c].map((b) => b.close));
  const T = Math.min(...closesAll.map((c) => c.length));
  const datesAll = barsMap[codes[0]].map((b) => b.date);
  const dates = datesAll.slice(datesAll.length - T + 1); // 与收益序列对齐（索引 1..T-1）
  const R = closesAll.map((cs) => simpleReturns(cs.slice(cs.length - T)));

  const res = pca(R, K);
  const sig = residualMeanReversion(res.residuals, window, entry, exit);
  const portRets = spreadPortfolioReturns(sig.positions, R);

  const equity = [1];
  for (let t = 1; t < portRets.length; t++) equity.push(equity[t - 1] * (1 + portRets[t]));

  // 等权篮子基准（与组合曲线同长度：T-1）
  const benchEquity = [1];
  for (let t = 1; t < T - 1; t++) {
    const avg = R.reduce((s, r) => s + r[t], 0) / R.length;
    benchEquity.push(benchEquity[t - 1] * (1 + avg));
  }

  const eqRets = equity.map((v, i) => (i === 0 ? 0 : v / equity[i - 1] - 1));
  const bRets = benchEquity.map((v, i) => (i === 0 ? 0 : v / benchEquity[i - 1] - 1));
  const metrics = computeMetrics(equity, benchEquity, eqRets, bRets, new Array(equity.length).fill(0));
  const benchMetrics = computeMetrics(benchEquity, benchEquity, bRets, bRets, new Array(benchEquity.length).fill(0));

  const activeCount = sig.positions.map((row) => row.filter((p) => p !== 0).length);

  return {
    codes,
    names: codes.map((c) => names[c] ?? c),
    dates,
    eigenvalues: res.eigenvalues,
    explained: res.explained,
    loadings: res.loadings,
    zscores: sig.zscores,
    composite: sig.composite,
    equity,
    benchEquity,
    metrics,
    benchMetrics,
    activeCount
  };
}

/* ================= M6 机器学习 ================= */

export type MlModelType = 'mlp' | 'logreg';

export interface MlRun {
  modelType: MlModelType;
  lossHistory: number[];
  accTrain: number;
  accTest: number;
  baseRate: number;
  auc: number;
  cm: { tp: number; fp: number; tn: number; fn: number };
  importance: number[];
  importanceNames: string[];
  /** 全样本预测概率（按 bars 下标对齐，未覆盖处为 null） */
  probaByBar: (number | null)[];
  /** 测试期仓位（按 bars 下标对齐） */
  posByBar: number[];
  bt: BtResult;
  testDates: string[];
  testProba: number[];
  testTruth: number[];
  lastProba: number;
  trainSize: number;
  testSize: number;
}

export function runMlModel(bars: Bar[], modelType: MlModelType, epochs: number, cfg: BtConfig): MlRun {
  const ds = buildFeatures(bars);
  const n = ds.X.length;
  const split = Math.max(20, Math.floor(n * 0.7));
  const scaler = fitScaler(ds.X.slice(0, split));
  const Z = applyScaler(ds.X, scaler);
  const Xtr = Z.slice(0, split);
  const ytr = ds.y.slice(0, split);
  const Xte = Z.slice(split);
  const yte = ds.y.slice(split);

  let pTrain: number[];
  let pTest: number[];
  let lossHistory: number[];
  let importance: number[];

  if (modelType === 'mlp') {
    const net = new MLP(10, 8, 42);
    net.fit(Xtr, ytr, { epochs, lr: 0.05, batch: 32 });
    pTrain = net.predictProba(Xtr);
    pTest = net.predictProba(Xte);
    lossHistory = net.lossHistory;
    importance = net.featureImportance();
  } else {
    const lr = new LogisticRegression(10);
    lr.fit(Xtr, ytr, 0.2, 300);
    pTrain = lr.predictProba(Xtr);
    pTest = lr.predictProba(Xte);
    lossHistory = lr.lossHistory;
    importance = lr.w.map(Math.abs);
  }

  const accTrain = accuracyScore(pTrain, ytr);
  const accTest = accuracyScore(pTest, yte);
  const baseRate = mean(yte);
  const auc = aucScore(pTest, yte);
  const cm = confusionMatrix(pTest, yte);

  // 仓位与回测（测试期为样本外）
  const pAll = [...pTrain, ...pTest];
  const posAll = mlPosition(pAll);
  const probaByBar: (number | null)[] = new Array(bars.length).fill(null);
  const posByBar = new Array(bars.length).fill(0);
  for (let i = 0; i < n; i++) {
    probaByBar[ds.tIdx[i]] = pAll[i];
    posByBar[ds.tIdx[i]] = posAll[i];
  }
  const start = ds.tIdx[split];
  const bt = runBacktest(
    bars.slice(start).map((b) => b.date),
    bars.slice(start).map((b) => b.close),
    posByBar.slice(start),
    cfg
  );

  return {
    modelType,
    lossHistory,
    accTrain,
    accTest,
    baseRate,
    auc,
    cm,
    importance,
    importanceNames: ['日收益率', '5日动量', '20日动量', 'HV20波动率', 'RSI14', 'MACD柱', 'MA20偏离', 'MA60偏离', '量能比', '布林位置'],
    probaByBar,
    posByBar,
    bt,
    testDates: ds.dates.slice(split),
    testProba: pTest,
    testTruth: yte,
    lastProba: pTest[pTest.length - 1] ?? 0.5,
    trainSize: split,
    testSize: n - split
  };
}
