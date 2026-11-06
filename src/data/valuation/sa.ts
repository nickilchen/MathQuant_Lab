/**
 * 港股 / 美股 / 日股 / 韩股季度财报：StockAnalysis 财报页
 *
 * 为什么用它：这四个市场没有像东财那样统一的免费结构化接口。
 *  - 美股 SEC EDGAR 最权威，但 companyfacts 是 3.8MB 的 XBRL 树，且财年不固定，
 *    「累计 / 单季 / 重复申报」混在一起，前端解析成本和出错面都很大；
 *  - 港股、日股、韩股没有免 key 的官方财报 API。
 * StockAnalysis 的季度财报页把四个市场都整理成了同一张表：
 *   `.../financials/?p=quarterly`          → 单季 EPS（20 季）
 *   `.../financials/balance-sheet/?p=quarterly` → 每股净资产（20 季）
 *
 * 代价：它是 Svelte 渲染的 HTML（class 名会变），所以只能按「表头文字 + 行标题」
 * 这种语义选择器解析，不能依赖 class。改版时这里会最先坏，测试用内联 HTML 片段兜住。
 *
 * 另一个代价：没有公告日字段。估值必须用「公告之后」的股价，否则是前视偏差，
 * 所以这里按披露期限**保守估算**（季度 +60 天、年报 +100 天），并在页面上明确标注。
 */
import { px } from '../sources/proxy';
import type { QuarterReport, ValuationMarket } from './types';

const HOST = 'stockanalysis.com';

export interface SaSeries {
  /** 季度标签，如 Q1 2027 */
  quarters: string[];
  /** 期末日期 YYYY-MM-DD */
  dates: string[];
  /** 每期数值，缺失为 null */
  values: (number | null)[];
}

const strip = (s: string): string =>
  s
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** `1,234.56` / `(123)` / `-` / `n/a` → number | null */
export function parseSaNumber(raw: string): number | null {
  const t = String(raw ?? '').replace(/,/g, '').replace(/\s/g, '');
  if (!t || /^(-|—|n\/a|nan)$/i.test(t)) return null;
  const neg = /^\(.*\)$/.test(t);
  const v = Number(t.replace(/[()]/g, ''));
  if (!Number.isFinite(v)) return null;
  return neg ? -v : v;
}

/** `Jun '26 Jun 30, 2026` → `2026-06-30` */
export function parseSaDate(raw: string): string | null {
  const t = String(raw ?? '');
  const m = /([A-Z][a-z]{2})\s+(\d{1,2}),\s*(\d{4})/.exec(t);
  if (!m) return null;
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].indexOf(m[1]);
  if (mon < 0) return null;
  return `${m[3]}-${String(mon + 1).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/**
 * 从财报页 HTML 里抽一行时间序列。
 *
 * 表格结构（两行表头）：
 *   Fiscal Quarter | Q1 2027 | Q4 2026 | ... | Period Ending | Jun '26 ... | Mar '26 ...
 *   Earnings Per Share EPS Growth | 120.69 | 62.70 | ...
 * 所以：季度标签在 `Period Ending` 之前，日期在它之后，两者按顺序一一对应。
 */
export function parseSaSeries(html: string, label: RegExp): SaSeries | null {
  const tables = [...String(html ?? '').matchAll(/<table[^>]*>([\s\S]*?)<\/table>/g)].map((m) => m[1]);

  for (const t of tables) {
    const headM = /<thead[^>]*>([\s\S]*?)<\/thead>/.exec(t);
    if (!headM) continue;
    const heads = [...headM[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => strip(x[1]));
    const pe = heads.findIndex((h) => /period ending/i.test(h));
    if (pe < 1) continue;

    const quarters = heads.slice(1, pe);
    const dates = heads.slice(pe + 1).map(parseSaDate);
    if (!quarters.length || dates.some((d) => !d)) continue;

    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
      [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) => strip(x[1]))
    );
    const row = rows.find((r) => r.length > 1 && label.test(r[0]));
    if (!row) continue;

    const values = row.slice(1).map(parseSaNumber);
    const n = Math.min(quarters.length, dates.length, values.length);
    if (n < 4) continue;
    return {
      quarters: quarters.slice(0, n),
      dates: (dates.slice(0, n) as string[]),
      values: values.slice(0, n)
    };
  }
  return null;
}

/** 市场 → StockAnalysis 路径前缀 */
function pathOf(market: ValuationMarket, code: string): string | null {
  const c = String(code ?? '').trim();
  if (market === 'HK') {
    const m = /^hk(\d{5})$/i.exec(c);
    if (!m) return null;
    // 港股 5 位，StockAnalysis 用 4 位（00700 → 0700）
    return `/quote/hkg/${m[1].replace(/^0/, '')}/`;
  }
  if (market === 'US') {
    const m = /^us([A-Za-z][A-Za-z.-]*)$/i.exec(c);
    if (!m) return null;
    // BRK.B → brk-b
    return `/stocks/${m[1].toLowerCase().replace(/\./g, '-')}/`;
  }
  if (market === 'JP') {
    const m = /^jp(\d{4,5})$/i.exec(c);
    if (!m) return null;
    return `/quote/tyo/${m[1].slice(0, 4)}/`;
  }
  if (market === 'KR') {
    const m = /^kr(\d{6})$/i.exec(c);
    if (!m) return null;
    return `/quote/krx/${m[1]}/`;
  }
  return null;
}

/** 披露滞后（保守估计，宁可晚于真实公告日，也不能早） */
function lagDays(quarter: string): number {
  return /^Q4\b/i.test(quarter) ? 100 : 60;
}

function addDays(iso: string, days: number): string {
  const t = new Date(`${iso}T00:00:00Z`).getTime();
  if (!Number.isFinite(t)) return iso;
  const d = new Date(t + days * 86400000).toISOString().slice(0, 10);
  // 估算日期不能超过今天：数据源既然已经有这期财报，说明它已经公布了。
  // 否则美股 10-K 会算出「2027-01-04 公告」这种未来日期，看着像穿越。
  const today = new Date().toISOString().slice(0, 10);
  return d > today ? today : d;
}

async function fetchHtml(path: string, retry = 1): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const res = await fetch(px(HOST, path), {
      signal: ctrl.signal,
      headers: { Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    if (/Just a moment|cf-mitigated|Enable JavaScript and cookies/i.test(html.slice(0, 4000))) {
      throw new Error('数据源触发反爬校验（Cloudflare），请稍后重试');
    }
    return html;
  } catch (e) {
    // Cloudflare 偶尔会掐掉并发请求，给一次退避重试；仍失败再上抛
    if (retry > 0) {
      await new Promise((r) => setTimeout(r, 700));
      return fetchHtml(path, retry - 1);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 拉港/美/日/韩的季度财报。
 *
 * 只保留 EPS 与 BPS 两项——StockAnalysis 不给 ROE / 同比 / 毛利率，
 * 这些字段填 null，页面显示「—」，不拿别的东西凑数。
 */
export async function fetchSaReports(market: ValuationMarket, code: string): Promise<QuarterReport[]> {
  const base = pathOf(market, code);
  if (!base) throw new Error('代码格式与该市场不匹配');

  const [incomeHtml, balanceHtml] = await Promise.all([
    fetchHtml(`${base}financials/?p=quarterly`),
    fetchHtml(`${base}financials/balance-sheet/?p=quarterly`)
  ]);

  const eps = parseSaSeries(incomeHtml, /^(earnings per share|eps)\b/i);
  if (!eps) throw new Error('财报页里没有找到每股收益（EPS）序列，可能该标的未覆盖');

  const bps = parseSaSeries(balanceHtml, /^book value per share\b/i);
  const bpsByDate = new Map<string, number>();
  if (bps) {
    bps.dates.forEach((d, i) => {
      const v = bps.values[i];
      if (v != null) bpsByDate.set(d, v);
    });
  }

  // 季度 PE / PB 序列。日股拿不到长 K 线，历史分位只能靠它；
  // 其他市场也用它，好处是分位样本固定 20 季，不受「顶栏回看 500 日」限制。
  // 这一页失败不影响主流程——没有 hint 就退回用 K 线算。
  const ratioHtml = await fetchHtml(`${base}financials/ratios/?p=quarterly`).catch(() => '');
  const peSeries = ratioHtml ? parseSaSeries(ratioHtml, /^(pe ratio|price\/earnings)\b/i) : null;
  const pbSeries = ratioHtml ? parseSaSeries(ratioHtml, /^(pb ratio|price\/book)\b/i) : null;
  const toMap = (s: SaSeries | null): Map<string, number> => {
    const m = new Map<string, number>();
    if (!s) return m;
    s.dates.forEach((d, i) => {
      const v = s.values[i];
      if (v != null && v > 0) m.set(d, v);
    });
    return m;
  };
  const peByDate = toMap(peSeries);
  const pbByDate = toMap(pbSeries);

  // 按日期升序，方便算 TTM（最近 4 个单季相加）
  const asc = eps.dates
    .map((d, i) => ({ date: d, quarter: eps.quarters[i], eps: eps.values[i] }))
    // EPS = 0 是有效值（盈亏平衡），只丢真正缺失的期
    .filter((x): x is { date: string; quarter: string; eps: number } => x.eps != null)
    .sort((a, b) => a.date.localeCompare(b.date));

  const list: QuarterReport[] = asc.map((x, i) => {
    const win = asc.slice(Math.max(0, i - 3), i + 1);
    // 「最近 4 条」不等于「最近 4 季」：中间缺一期时，四条可能横跨 15 个月。
    // 正常 4 季首尾约 270~280 天，缺一期会超过 400 天；阈值取 300 天。
    const spanOk =
      win.length === 4 &&
      new Date(`${win[3].date}T00:00:00Z`).getTime() - new Date(`${win[0].date}T00:00:00Z`).getTime() <=
        300 * 86400000;
    const ttmEps = spanOk ? win.reduce((s, y) => s + y.eps, 0) : null;
    return {
      period: x.date,
      noticeDate: addDays(x.date, lagDays(x.quarter)),
      // 海外是单季值；`epsCum` 字段名保留是为了兼容旧结构，含义由 ttmEps 明确覆盖
      epsCum: x.eps,
      epsQuarter: x.eps,
      ttmEps,
      ttmProfit: null,
      netProfitCum: 0,
      revenueCum: 0,
      bps: bpsByDate.get(x.date) ?? 0,
      peHint: peByDate.get(x.date) ?? null,
      pbHint: pbByDate.get(x.date) ?? null,
      roe: null,
      profitYoY: null,
      revenueYoY: null,
      grossMargin: null,
      ocfPerShare: null,
      noticeEstimated: true
    };
  });

  if (list.length < 8) throw new Error('季度财报样本不足（至少需要 8 个季度）');
  // 与 A 股一致：最新在前
  return list.reverse();
}
