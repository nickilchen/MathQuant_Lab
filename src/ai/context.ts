import type { ActionPlan } from '../math/action';
import type { MomParams, MomReport } from '../math/momentum';

/** 注入给模型的唯一事实来源：全部来自页面已算出的真实结果 */
export interface MarketSnapshot {
  code: string;
  name: string;
  marketLabel: string;
  lastDate: string;
  bars: number;
  source: string;
  price: number;
  ma: number | null;
  maLen: number;
  trendOk: boolean;
  raw: number;
  vol: number;
  score: number;
  verdict: string;
  position: number;
  budget: number;
  windows: { label: string; ret: number; ann: number }[];
  backtest: {
    totalReturn: number;
    cagr: number;
    sharpe: number;
    maxDD: number;
    calmar: number;
    winRate: number;
    trades: number;
    exposure: number;
  };
  triggers: { action: string; price: number | null; distance: number | null; note: string }[];
  params: MomParams;
}

const r4 = (v: number): number => (Number.isFinite(v) ? Math.round(v * 10000) / 10000 : 0);
const pct = (v: number, d = 2): string => (v * 100).toFixed(d) + '%';

export function buildSnapshot(args: {
  code: string;
  name: string;
  marketLabel: string;
  source: string;
  report: MomReport;
  plan: ActionPlan;
  params: MomParams;
}): MarketSnapshot {
  const { code, name, marketLabel, source, report, plan, params } = args;
  const T = report.dates.length;
  const bt = report.bt.metrics;
  return {
    code,
    name,
    marketLabel,
    lastDate: T > 0 ? report.dates[T - 1] : '',
    bars: T,
    source,
    price: r4(plan.price),
    ma: plan.ma == null ? null : r4(plan.ma),
    maLen: params.maLen,
    trendOk: plan.trendOk,
    raw: r4(report.raw),
    vol: r4(report.vol),
    score: Math.round(report.score * 10) / 10,
    verdict: report.verdictText,
    position: r4(report.currentPos),
    budget: r4(plan.budget),
    windows: report.windows.map((w) => ({ label: w.label, ret: r4(w.ret), ann: r4(w.ann) })),
    backtest: {
      totalReturn: r4(bt.totalReturn),
      cagr: r4(bt.cagr),
      sharpe: r4(bt.sharpe),
      maxDD: r4(bt.maxDD),
      calmar: r4(bt.calmar),
      winRate: r4(bt.winRate),
      trades: report.tradeCount,
      exposure: r4(report.exposure)
    },
    triggers: plan.triggers.map((t) => ({
      action: t.action,
      price: t.price == null ? null : r4(t.price),
      distance: t.distance == null ? null : r4(t.distance),
      note: t.note
    })),
    params
  };
}

/** 给模型看的紧凑事实文本 */
export function snapshotToText(s: MarketSnapshot): string {
  const L: string[] = [];
  L.push('标的：' + s.name + '（' + s.code + (s.marketLabel ? ' · ' + s.marketLabel : '') + '）');
  L.push('数据：截至 ' + s.lastDate + '，共 ' + s.bars + ' 根日线，来源 ' + s.source);
  L.push('最新收盘：' + s.price);
  L.push(
    '年线 MA' + s.maLen + '：' + (s.ma == null ? '未启用' : String(s.ma)) +
      '（' + (s.trendOk ? '价格在上方' : '价格在下方') + '）'
  );
  L.push('区间动量 r(' + s.params.lookback + ',' + s.params.skip + ')：' + pct(s.raw));
  L.push('年化波动（近20日）：' + pct(s.vol));
  L.push('动量强度分：' + s.score.toFixed(1) + ' / 100（50 中性）');
  L.push('策略判定：' + s.verdict);
  L.push('当前目标仓位：' + pct(s.position, 0) + '；风险预算上限 ' + pct(s.budget, 0));
  L.push('分周期收益：' + s.windows.map((w) => w.label + ' ' + pct(w.ret)).join('，'));
  L.push(
    '样本内回测：总收益 ' + pct(s.backtest.totalReturn) +
      '，年化 ' + pct(s.backtest.cagr) +
      '，夏普 ' + s.backtest.sharpe +
      '，最大回撤 ' + pct(s.backtest.maxDD) +
      '，卡玛 ' + s.backtest.calmar +
      '，胜率 ' + pct(s.backtest.winRate, 1) +
      '，开仓 ' + s.backtest.trades + ' 次，平均仓位 ' + pct(s.backtest.exposure, 0)
  );
  L.push('触发价：');
  for (const t of s.triggers) {
    L.push(
      '  - ' + t.action + '：' + (t.price == null ? '无' : String(t.price)) +
        (t.distance == null ? '' : '（距现价 ' + (t.distance >= 0 ? '+' : '') + pct(t.distance, 1) + '）') +
        '；' + t.note
    );
  }
  L.push(
    '参数：回看 ' + s.params.lookback + ' 日，跳过 ' + s.params.skip + ' 日，均线 ' +
      (s.params.maLen > 0 ? s.params.maLen + ' 日' : '关闭') +
      '，开仓 ' + pct(s.params.entry, 0) +
      '，离场 ' + pct(s.params.exit, 0) +
      '，目标波动 ' + (s.params.targetVol > 0 ? pct(s.params.targetVol, 0) : '关闭') +
      '，仓位上限 ' + pct(s.params.cap, 0)
  );
  return L.join('\n');
}
