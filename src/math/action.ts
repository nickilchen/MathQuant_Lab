import { positionSize, type MomParams, type MomReport } from './momentum';
import { sma } from './indicators';

export type ActionTone = 'hold' | 'watch' | 'avoid';

export interface ActionTrigger {
  action: string;
  price: number | null;
  distance: number | null;
  note: string;
}

export interface ActionParamRow {
  label: string;
  value: string;
}

export interface ActionPlan {
  tone: ActionTone;
  headline: string;
  detail: string;
  /** 当前策略建议仓位（已含趋势过滤与滞后带） */
  position: number;
  positionText: string;
  price: number;
  ma: number | null;
  trendOk: boolean;
  /** 风险预算上限（不含趋势过滤） */
  budget: number;
  triggers: ActionTrigger[];
  rules: string[];
  params: ActionParamRow[];
}

const pct = (v: number, d = 2): string => (v * 100).toFixed(d) + '%';

/**
 * 使区间动量恰好等于 target 所需的当前收盘价。
 * 动量取的是 t-skip 与 t-skip-L 两根 K 线之比，因此先算出「分子需要到多少」，
 * 再按最近一根到分子的比例折算回当前价。skip=0 时为精确解，skip>0 时为近似值。
 */
export function priceForMomentum(closes: number[], p: MomParams, target: number): number | null {
  const T = closes.length;
  const numIdx = T - 1 - p.skip;
  const denIdx = numIdx - p.lookback;
  if (T < 2 || denIdx < 0 || numIdx < 0) return null;
  const den = closes[denIdx];
  const num = closes[numIdx];
  const px = closes[T - 1];
  if (!(den > 0) || !(num > 0) || !(px > 0)) return null;
  const need = den * (1 + target);
  const out = px * (need / num);
  return Number.isFinite(out) && out > 0 ? out : null;
}

const maxOf = (...xs: (number | null)[]): number | null => {
  const v = xs.filter((x): x is number => x != null && Number.isFinite(x));
  return v.length > 0 ? Math.max(...v) : null;
};

const same = (a: number | null, b: number | null): boolean =>
  a != null && b != null && Math.abs(a - b) < 1e-9;

export function buildActionPlan(report: MomReport, p: MomParams): ActionPlan {
  const closes = report.closes;
  const T = closes.length;
  const price = T > 0 ? closes[T - 1] : 0;

  const maArr = p.maLen > 0 ? sma(closes, p.maLen) : null;
  const lastMa = maArr && T > 0 ? maArr[T - 1] : null;
  const ma = lastMa != null && Number.isFinite(lastMa) && lastMa > 0 ? lastMa : null;
  const trendOk = ma == null ? true : price >= ma;

  const budget = T > 0 ? positionSize(closes, T - 1, p) : 0;
  const position = report.currentPos;
  const holding = position > 0;

  const entryMom = priceForMomentum(closes, p, p.entry);
  const addTarget = Math.max(p.entry, 0.05);
  const addMom = priceForMomentum(closes, p, addTarget);
  const exitMom = priceForMomentum(closes, p, p.exit);

  // 开仓：站上均线 且 动量 > entry，两条都要满足 → 取较高价
  const entryPx = maxOf(ma, entryMom);
  const addPx = maxOf(ma, addMom);
  // 离场：跌破均线 或 动量 < exit，任一成立即离场 → 下跌途中先触及较高者
  const exitPx = maxOf(ma, exitMom);

  const dist = (x: number | null): number | null => (x != null && price > 0 ? x / price - 1 : null);
  const maName = ma != null ? 'MA' + p.maLen : '均线';
  const maOnly = same(entryPx, ma) && same(addPx, ma);

  const triggers: ActionTrigger[] = [];
  if (holding) {
    triggers.push({
      action: '持仓维持',
      price: ma,
      distance: dist(ma),
      note: '收盘站在 ' + maName + ' 上方即继续持有；跌破即进入清仓判断',
    });
    triggers.push({
      action: '加仓至上限',
      price: addPx,
      distance: dist(addPx),
      note: '动量升至 ' + pct(addTarget, 0) + ' 以上再补，避免在震荡里反复加仓',
    });
    triggers.push({
      action: '清仓',
      price: exitPx,
      distance: dist(exitPx),
      note:
        '收盘跌破即离场（' +
        (ma != null ? '失守 ' + maName + ' 或 ' : '') +
        '动量 < ' +
        pct(p.exit, 0) +
        '）',
    });
  } else {
    triggers.push({
      action: '翻多试仓 1/3',
      price: entryPx,
      distance: dist(entryPx),
      note: '收盘同时满足：站上 ' + maName + '，且区间动量 > ' + pct(p.entry, 0),
    });
    triggers.push({
      action: '补足至目标仓位',
      price: addPx,
      distance: dist(addPx),
      note: maOnly
        ? '与试仓同价：当前均线是唯一约束，站上 ' + maName + ' 即同时满足两条'
        : '动量升至 ' + pct(addTarget, 0) + ' 以上，确认是趋势而非假突破',
    });
    triggers.push({
      action: '当前不动作',
      price: null,
      distance: null,
      note:
        '现价 ' +
        price.toFixed(2) +
        ' 仍在触发价下方，保持空仓；不因跌幅大而提前布局',
    });
  }

  let tone: ActionTone;
  let headline: string;
  let detail: string;
  if (holding) {
    tone = 'hold';
    if (report.raw >= p.entry) {
      headline = '持有 · 动能确认';
      detail =
        '目标仓位 ' + pct(position, 0) + '（风险预算 ' + pct(budget, 0) + '）。动量仍在开仓阈值上方，按信号持有。';
    } else {
      headline = '持有观察 · 动能转弱';
      detail =
        '动量 ' + pct(report.raw) + ' 已回落到开仓阈值下方，但未触及离场线 ' + pct(p.exit, 0) + '，继续持有并盯住清仓价。';
    }
  } else if (!trendOk && report.raw <= p.exit) {
    tone = 'avoid';
    headline = '空仓 · 趋势与动量双弱';
    detail =
      '价格在 ' + maName + ' 下方 ' + pct(1 - price / (ma as number), 1) +
      '，且区间动量 ' + pct(report.raw) + ' 已低于离场线。不参与，不抄底' +
      (entryPx != null ? '；距翻多触发价还需 +' + pct(entryPx / price - 1, 1) : '') + '。';
  } else if (!trendOk) {
    tone = 'watch';
    headline = '空仓 · 趋势过滤否决';
    detail =
      '风险预算本可给到 ' + pct(budget, 0) + '，但价格仍在 ' + maName + ' 下方，趋势过滤把仓位强制归零。低波动不等于低风险。';
  } else {
    tone = 'watch';
    headline = '临界 · 等待动量确认';
    detail =
      '价格已站上 ' + maName + '，但区间动量 ' + pct(report.raw) + ' 尚未超过开仓阈值 ' + pct(p.entry, 0) + '。等触发价再动手。';
  }

  const rules: string[] = [
    ma != null
      ? '年线（' + maName + '）之下不抄底、不补仓、不摊平成本。'
      : '均线过滤已关闭：缺少趋势保护，建议至少保留 200 日均线。',
    holding && exitPx != null
      ? '每周五收盘复核：跌破 ' + exitPx.toFixed(2) + ' 的持仓，次一交易日开盘清仓。'
      : '每周五收盘复核：动量是否跌破 ' + pct(p.exit, 0) + '，以及价格是否重新站上 ' + maName + '。',
    '单标的仓位不超过 ' +
      pct(p.cap, 0) +
      '；目标波动 ' +
      (p.targetVol > 0 ? pct(p.targetVol, 0) : '关闭') +
      '，波动上升会自动缩仓，无需人工干预。',
    holding
      ? '持仓期间不做主观加码：只有清仓价触发或动量跌破离场线才动作。'
      : '站上开仓价先建 1/3，动量确认后再补足，避免假突破被打回。',
  ];
  if (report.vol > 0.25) {
    rules.push('当前年化波动 ' + pct(report.vol, 1) + ' 偏高，建议分批建仓并把目标波动下调到 10%~12%。');
  }
  if (T > 0 && report.tradeCount / T > 1 / 60) {
    rules.push(
      '样本内开仓 ' + report.tradeCount + ' 次，换手偏高：可把开仓阈值上调到 5%、离场线下调到 -5% 以降低磨损。'
    );
  }
  rules.push(
    holding
      ? '每月末按强度分复核一次，若分数跌回 50 以下则主动降仓。'
      : '空仓期间持有现金或短债，把资金留给确认后的趋势。'
  );

  const params: ActionParamRow[] = [
    { label: '回看', value: p.lookback + ' 日' },
    { label: '跳过', value: p.skip + ' 日' },
    { label: '均线', value: p.maLen > 0 ? p.maLen + ' 日' : '关闭' },
    { label: '开仓阈值', value: pct(p.entry, 0) },
    { label: '离场阈值', value: pct(p.exit, 0) },
    { label: '目标波动', value: p.targetVol > 0 ? pct(p.targetVol, 0) : '关闭' },
    { label: '仓位上限', value: pct(p.cap, 0) },
  ];

  const positionText = pct(position, 0) + (budget > 0 ? ' / 预算 ' + pct(budget, 0) : '');

  return {
    tone,
    headline,
    detail,
    position,
    positionText,
    price,
    ma,
    trendOk,
    budget,
    triggers,
    rules,
    params,
  };
}