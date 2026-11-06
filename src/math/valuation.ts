/**
 * 价值估值评断（纯函数）
 *
 * 核心思路：**财报定分子，历史定分母**。
 *  - 分子：用最新季度财报算出 TTM EPS（或 BPS），每个季度新报告一到就自动更新；
 *  - 分母：用这只股票自己过去 N 个季度的 PE/PB 中枢（25/50/75 分位），不用拍脑袋的「行业平均 PE」；
 *  - 合理价 = TTM EPS × 历史 PE 中位数，再和现价相减，给出**具体差多少元、多少个点**。
 *
 * 两个容易被忽略、但会影响结论正确性的细节：
 *  1. 东财报表的 EPS 是**年初至今累计值**，不是单季值。TTM 必须做差分：
 *     TTM = 本期累计 + 上年全年累计 − 上年同期累计；Q4 年报的累计值本身就是 TTM。
 *  2. 估值只能用**公告日之后**的股价算历史 PE，否则等于偷看还没公布的财报（前视偏差）。
 *
 * 「每季度实时调整」体现在 history：用**扩张窗口**（只用该季度及之前已知的 PE）
 * 重算当时的合理价，形成一条随财报滚动调整的估值轨迹，而不是拿未来数据回算过去。
 *
 * 边界：亏损 / EPS≤0 时 PE 失效，自动回退到 PB；周期股、金融股、一次性损益大的公司
 * 用历史分位也会失真，页面必须说明。
 */
import type { Bar } from '../data/types';
import type { QuarterReport } from '../data/valuation';

export type ValuationMethod = 'auto' | 'pe' | 'pb';

export interface ValuationConfig {
  /** 用最近多少个季度算 PE/PB 分位 */
  window: number;
  method: ValuationMethod;
  /** 金额单位名（元 / 港元 / 美元 / 日元 / 韩元），只影响文案，不影响计算 */
  currency?: string;
}

export const DEFAULT_VALUATION_CONFIG: ValuationConfig = { window: 20, method: 'auto', currency: '元' };

export interface Percentiles {
  p25: number;
  p50: number;
  p75: number;
  count: number;
}

export interface QuarterValuation {
  period: string;
  noticeDate: string;
  ttmEps: number | null;
  ttmProfit: number | null;
  bps: number;
  /** 公告日之后第一个交易日的收盘价 */
  priceAtNotice: number | null;
  pe: number | null;
  pb: number | null;
  /** 用截至该期的已知 PE/PB 中位数算出的合理价（扩张窗口） */
  fairPrice: number | null;
  /** (合理价 - 当时股价) / 当时股价 × 100 */
  deviation: number | null;
}

export type ValuationVerdict = '明显低估' | '偏低估' | '合理' | '偏高估' | '明显高估' | '无法判断';

export interface ValuationResult {
  method: 'pe' | 'pb';
  current: number;
  ttmEps: number | null;
  ttmProfit: number | null;
  bps: number;
  peNow: number | null;
  pbNow: number | null;
  peStats: Percentiles | null;
  pbStats: Percentiles | null;
  /** 悲观 / 合理 / 乐观三档价格 */
  low: number | null;
  fair: number | null;
  high: number | null;
  /** 合理价 - 现价（元）；正 = 低估 */
  diff: number | null;
  /** 相对现价的百分比 */
  diffPct: number | null;
  verdict: ValuationVerdict;
  verdictNote: string;
  /** 为什么选 PE 还是 PB（带 EPS 数值与样本数） */
  methodReason: string;
  history: QuarterValuation[];
  latest: QuarterReport;
  /** 公告日是否为估算（海外源没有公告日字段） */
  noticeEstimated: boolean;
  /** EPS 与股价的币种/单位不一致（ADR 常见），此时不出合理价 */
  unitMismatch: boolean;
  lines: string[];
}

/** 线性插值分位（0~1） */
export function percentile(values: number[], q: number): number {
  const a = values.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return NaN;
  if (a.length === 1) return a[0];
  const pos = (a.length - 1) * Math.max(0, Math.min(1, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

export function statsOf(values: number[]): Percentiles | null {
  const a = values.filter((v) => Number.isFinite(v) && v > 0);
  if (a.length < 4) return null;
  return { p25: percentile(a, 0.25), p50: percentile(a, 0.5), p75: percentile(a, 0.75), count: a.length };
}

/** 累计值 → TTM：本期累计 + 上年全年 − 上年同期；年报直接用累计 */
export function ttmOf(reports: QuarterReport[], i: number): { eps: number | null; profit: number | null } {
  const r = reports[i];
  if (!r) return { eps: null, profit: null };

  // 海外数据源给的是单季值，TTM 在数据层已经按「最近 4 季相加」算好，直接用。
  // 不能再走累计差分——那会把单季值当成累计值，TTM 会变成负数或翻倍。
  if (r.ttmEps != null) return { eps: r.ttmEps, profit: r.ttmProfit ?? null };

  const y = Number(r.period.slice(0, 4));
  const md = r.period.slice(5);
  if (md === '12-31') return { eps: r.epsCum, profit: r.netProfitCum };

  const prevSame = reports.find((x) => x.period === `${y - 1}-${md}`);
  const prevAnnual = reports.find((x) => x.period === `${y - 1}-12-31`);
  if (!prevSame || !prevAnnual) return { eps: null, profit: null };
  return {
    eps: r.epsCum + prevAnnual.epsCum - prevSame.epsCum,
    profit: r.netProfitCum + prevAnnual.netProfitCum - prevSame.netProfitCum
  };
}

/**
 * 公告日之后第一个交易日收盘价（防前视偏差）。
 *
 * 注意：如果公告日**早于 K 线覆盖范围**，第一个满足 date>=notice 的 bar 其实已经是
 * 很久以后的价格，不能用（否则 15 年前的财报会配上今天的股价，把历史 PE 全算错）。
 * 这里要求第一个 bar 与公告日相差不超过 20 天，视为「就在公告附近」。
 */
export function priceAfterNotice(bars: Bar[], noticeDate: string): number | null {
  const i = bars.findIndex((b) => b.date >= noticeDate);
  if (i < 0) return null;
  const b = bars[i];
  const t1 = new Date(`${noticeDate}T00:00:00`).getTime();
  const t2 = new Date(`${b.date}T00:00:00`).getTime();
  if (!Number.isFinite(t1) || !Number.isFinite(t2) || t2 - t1 > 20 * 86400000) return null;
  return Number.isFinite(b.close) && b.close > 0 ? b.close : null;
}

function verdictOf(current: number, low: number, fair: number, high: number): { verdict: ValuationVerdict; note: string } {
  if (current <= low) return { verdict: '明显低估', note: '现价已跌到历史估值下沿（25 分位）之下' };
  if (current < fair * 0.92) return { verdict: '偏低估', note: '现价低于合理价 8% 以上，但还没到极端下沿' };
  if (current <= fair * 1.08) return { verdict: '合理', note: '现价落在合理价 ±8% 的常态区间' };
  if (current < high) return { verdict: '偏高估', note: '现价高于合理价 8% 以上，但还没到历史上沿' };
  return { verdict: '明显高估', note: '现价已越过历史估值上沿（75 分位）' };
}

/**
 * @param reports 季度财报，按报告期**倒序**（最新在前）
 * @param bars    日 K，按日期**升序**
 * @param current 现价（默认取最后一根 K 线收盘）
 */
export function analyzeValuation(
  reports: QuarterReport[],
  bars: Bar[],
  cfg: ValuationConfig = DEFAULT_VALUATION_CONFIG,
  current?: number
): ValuationResult | null {
  // 海外源直接给季度 PE/PB 序列（peHint），历史分位不再依赖 K 线长度，
  // 所以只要有 1 根 K 线拿现价就够；A 股没有 hint，仍然要求 60 根。
  const hasHint = reports.some((r) => r.peHint != null || r.pbHint != null);
  if (!reports.length || bars.length < (hasHint ? 1 : 60)) return null;

  const price = current && current > 0 ? current : bars[bars.length - 1].close;
  const latest = reports[0];

  // 时间升序构造每季度快照
  const asc = [...reports].reverse();
  const rows: QuarterValuation[] = asc.map((r, i) => {
    const ttm = ttmOf(asc, i);
    // 公告后股价：优先 K 线；K 线覆盖不到时用「数据源 PE × TTM EPS」反推，
    // 这样轨迹图在日股这种拿不到长 K 线的市场也能画出来，且与 PE 自洽。
    const fromBars = priceAfterNotice(bars, r.noticeDate);
    const fromHint =
      r.peHint != null && r.peHint > 0 && ttm.eps != null && ttm.eps > 0 ? r.peHint * ttm.eps : null;
    // 有 peHint 时优先用「PE × TTM EPS」反推：PE 分位与股价必须来自同一套口径，
    // 否则轨迹图上「合理价」和「股价」会各说各话。
    const priceAtNotice = fromHint ?? fromBars;
    const pe =
      r.peHint != null && r.peHint > 0
        ? r.peHint
        : ttm.eps != null && ttm.eps > 0 && fromBars
          ? fromBars / ttm.eps
          : null;
    const pb = r.pbHint != null && r.pbHint > 0 ? r.pbHint : r.bps > 0 && fromBars ? fromBars / r.bps : null;
    return {
      period: r.period,
      noticeDate: r.noticeDate,
      ttmEps: ttm.eps,
      ttmProfit: ttm.profit,
      bps: r.bps,
      priceAtNotice,
      pe,
      pb,
      fairPrice: null,
      deviation: null
    };
  });

  // 选择估值口径
  const cur = cfg.currency || '元';
  const ttmLatest = rows[rows.length - 1]?.ttmEps;
  const allPe = rows.map((r) => r.pe).filter((v): v is number => v != null && v > 0);
  const peCount = allPe.length;
  const epsOk = !!(ttmLatest && ttmLatest > 0);
  const epsText = ttmLatest != null ? `${ttmLatest.toFixed(2)} ${cur}` : '—';

  /**
   * 口径选择必须可解释：用户选了「自动」，就得看到「因为 EPS 是 X、PE 样本有 N 个，
   * 所以用 PE / 回退 PB」，而不是一句静态规则。
   *
   * 手动选择也要诚实：选了 PE 但 EPS ≤ 0 时，PE 会算出负价，没有意义，
   * 这里仍然回退 PB，并明确告诉用户「已回退」，而不是悄悄换口径。
   */
  let method: 'pe' | 'pb' = 'pe';
  let methodReason = '';
  if (cfg.method === 'pb') {
    method = 'pb';
    methodReason = '手动选择 PB（BPS × 历史 PB 分位）';
  } else if (cfg.method === 'pe') {
    if (!epsOk) {
      method = 'pb';
      methodReason = `手动选择 PE，但 TTM EPS ${epsText} ≤ 0，PE 会算出负价 → 已回退 PB`;
    } else if (peCount < 4) {
      method = 'pb';
      methodReason = `手动选择 PE，但 PE 样本只有 ${peCount} 个（< 4）→ 已回退 PB`;
    } else {
      methodReason = `手动选择 PE（TTM EPS ${epsText} > 0，PE 样本 ${peCount} 个）`;
    }
  } else if (!epsOk) {
    method = 'pb';
    methodReason = `自动：TTM EPS ${epsText} ≤ 0，PE 无意义 → 回退 PB（BPS × 历史 PB 分位）`;
  } else if (peCount < 4) {
    method = 'pb';
    methodReason = `自动：TTM EPS ${epsText} > 0，但 PE 样本只有 ${peCount} 个（< 4）→ 回退 PB`;
  } else {
    methodReason = `自动：TTM EPS ${epsText} > 0，PE 样本 ${peCount} 个（≥ 4）→ 用 PE`;
  }

  // 扩张窗口：每个季度只用「截至该期已知道」的分位，不偷看未来
  const peSeen: number[] = [];
  const pbSeen: number[] = [];
  for (const r of rows) {
    if (r.pe != null && r.pe > 0) peSeen.push(r.pe);
    if (r.pb != null && r.pb > 0) pbSeen.push(r.pb);
    const st = method === 'pe' ? statsOf(peSeen) : statsOf(pbSeen);
    const basis = method === 'pe' ? r.ttmEps : r.bps;
    if (st && basis != null && basis > 0) {
      r.fairPrice = basis * st.p50;
      if (r.priceAtNotice) r.deviation = ((r.fairPrice - r.priceAtNotice) / r.priceAtNotice) * 100;
    }
  }

  // 当前分位：最近 window 个季度
  const w = Math.max(4, Math.min(rows.length, Math.round(cfg.window)));
  const recent = rows.slice(-w);
  const peStats = statsOf(recent.map((r) => r.pe).filter((v): v is number => v != null && v > 0));
  const pbStats = statsOf(recent.map((r) => r.pb).filter((v): v is number => v != null && v > 0));
  const st = method === 'pe' ? peStats : pbStats;
  const basis = method === 'pe' ? ttmLatest : latest.bps;

  const peNow = ttmLatest && ttmLatest > 0 ? price / ttmLatest : null;
  const pbNow = latest.bps > 0 ? price / latest.bps : null;

  /**
   * 币种/单位一致性检测。
   *
   * ADR 的典型情况：财报按本币披露（SK 海力士是 KRW），股价按美元交易，
   * 两者直接相除会得到 0.003 倍这种 PE，再乘历史分位就变成「低估 134 万%」。
   * 正常股票的 PE 不会低于 0.5，也很少高于 2000——越界基本就是单位不一致，
   * 此时必须拒绝出价，而不是给一个荒谬数字再补一句免责声明。
   */
  const unitMismatch = peNow != null && (peNow < 0.5 || peNow > 2000);

  const low = !unitMismatch && st && basis != null && basis > 0 ? basis * st.p25 : null;
  const fair = !unitMismatch && st && basis != null && basis > 0 ? basis * st.p50 : null;
  const high = !unitMismatch && st && basis != null && basis > 0 ? basis * st.p75 : null;

  const diff = fair != null ? fair - price : null;
  const diffPct = diff != null && price > 0 ? (diff / price) * 100 : null;
  const vd = unitMismatch
    ? {
        verdict: '无法判断' as ValuationVerdict,
        note: `当前 PE 只有 ${peNow!.toFixed(3)} 倍，明显超出正常范围：财报 EPS 与股价的币种/单位不一致（ADR 常见——财报用本币、股价用美元）。直接相乘会放大成汇率倍数，估值不可用，请改选本土上市代码。`
      }
    : fair != null && low != null && high != null
      ? verdictOf(price, low, fair, high)
      : { verdict: '无法判断' as ValuationVerdict, note: '估值样本不足，无法给出合理价' };
  // 幅度超过 50% 基本不是「市场犯错」，而是盈利处在周期拐点、历史 PE 中枢本身失真。
  // 这种时候最容易被误读成「捡钱」，必须在结论里点名，不能只写在页面底部。
  const extreme = !unitMismatch && diffPct != null && Math.abs(diffPct) > 50;
  const note = extreme
    ? `${vd.note}（偏离幅度 ${diffPct!.toFixed(0)}% 超过 50%，通常是盈利处于周期拐点、历史 PE 中枢失真所致，不能直接当成涨跌空间）`
    : vd.note;


  const lines: string[] = [];

  // 各市场能拿到的字段不一样：A 股有 ROE / 同比 / 毛利率，海外源只有 EPS 与 BPS。
  // 拿不到就不写，不能填 0 冒充「同比零增长」。
  // 币种不一致时 EPS/BPS 的货币是财报币种，不能标成交易币种（美元）
  const epsUnit = unitMismatch ? '（财报币种）' : ` ${cur}`;
  const facts: string[] = [`TTM EPS ${ttmLatest != null ? ttmLatest.toFixed(2) : '—'}${epsUnit}`];
  if (latest.profitYoY != null) facts.push(`归母净利同比 ${latest.profitYoY >= 0 ? '+' : ''}${latest.profitYoY.toFixed(2)}%`);
  if (latest.roe != null) facts.push(`ROE ${latest.roe.toFixed(2)}%`);
  if (latest.bps > 0) facts.push(`BPS ${latest.bps.toFixed(2)}${epsUnit}`);
  lines.push(
    `最新财报 ${latest.period}（${latest.noticeDate}${latest.noticeEstimated ? ' 估算' : ''} 公告）：${facts.join('、')}。`
  );
  if (latest.noticeEstimated) {
    lines.push('该市场数据源不提供公告日，公告日按披露期限保守估算（季报 +60 天、年报 +100 天），只会偏晚、不会偏早，避免用未公布财报配当期股价。');
  }
  if (unitMismatch) {
    lines.push(
      `⚠️ 币种/单位不一致：TTM EPS ${ttmLatest!.toFixed(2)}（财报币种）与现价 ${price.toFixed(2)} ${cur} 相除得到 ${peNow!.toFixed(3)} 倍 PE——正常股票不会是这个量级。` +
        '这通常是 ADR / 双重上市：财报按本币披露、股价按美元交易。本页不出合理价，避免给出放大了汇率的假空间。'
    );
  }

  lines.push(
    `口径选择：${methodReason}。计算方式：${method === 'pe' ? 'TTM EPS × 历史 PE 分位' : 'BPS × 历史 PB 分位'}，` +
      `取最近 ${st?.count ?? 0} 个季度的分位（窗口 ${w} 季）：` +
      (st ? `下沿 ${st.p25.toFixed(1)} / 中位 ${st.p50.toFixed(1)} / 上沿 ${st.p75.toFixed(1)} 倍。` : '有效样本不足。')
  );
  if (low != null && fair != null && high != null) {
    lines.push(`三档价格：悲观 ${low.toFixed(2)} ${cur} / 合理 ${fair.toFixed(2)} ${cur} / 乐观 ${high.toFixed(2)} ${cur}；当前 PE ${peNow?.toFixed(1) ?? '—'} 倍、PB ${pbNow?.toFixed(2) ?? '—'} 倍。`);
    lines.push(
      `合理价 ${fair.toFixed(2)} ${cur} − 现价 ${price.toFixed(2)} ${cur} = ${diff! >= 0 ? '+' : ''}${diff!.toFixed(2)} ${cur}` +
        `（${diffPct! >= 0 ? '+' : ''}${diffPct!.toFixed(2)}%）——${vd.verdict}：${note}。`
    );
  }
  lines.push(
    '每季度新财报一到，TTM EPS/BPS 与历史分位都会重算，合理价随之调整；' +
      '历史轨迹用的是「截至当期已知」的扩张窗口，不拿未来数据回算过去。'
  );

  return {
    method,
    current: price,
    ttmEps: ttmLatest,
    ttmProfit: rows[rows.length - 1]?.ttmProfit ?? null,
    bps: latest.bps,
    peNow,
    pbNow,
    peStats,
    pbStats,
    low,
    fair,
    high,
    diff,
    diffPct,
    verdict: vd.verdict,
    verdictNote: note,
    methodReason,
    history: rows,
    latest,
    noticeEstimated: !!latest.noticeEstimated,
    unitMismatch,
    lines
  };
}
