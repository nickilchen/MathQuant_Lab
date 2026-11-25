/**
 * 美股季度财报：SEC EDGAR companyconcept API。
 *
 * 为什么换掉 StockAnalysis：该站 2026-11 起整站 Cloudflare 403（Attention Required），
 * 港/美/日/韩四个市场的估值财报同时失效。美股改用 SEC 官方 XBRL 数据，
 * 比第三方抓 HTML 更权威，而且 `filed` 是**真实公告日**，无需再估算披露滞后。
 *
 * 接口（均免 key，SEC 要求申明 UA，由代理层统一注入）：
 *   company_tickers.json                       → ticker → CIK（复用 stockNews/sec.ts 的 24h 缓存）
 *   companyconcept/.../EarningsPerShareDiluted  → 稀释 EPS（单位 USD/shares）
 *   companyconcept/.../StockholdersEquity       → 归母权益（USD）
 *   companyconcept/.../CommonStockSharesOutstanding → 期末股本（shares）
 *
 * 单季判定：companyconcept 里同时存在「累计」（如 Q3 的 6.88 = 前三季合计）
 * 与「单季」（如 Q3 的 2.02 = 当季）。规则：start~end 跨度在 [28,120) 天视为单季。
 * 边缘标的（如 KO 财年非标准、BRK.B 用自定义 tag）取不到足够单季 → 明确报错，
 * 绝不用累计值冒充单季、也不臆造数据。
 */
import { px } from '../sources/proxy';
import { loadCikMap, secTicker } from '../stockNews/sec';
import type { QuarterReport } from './types';

const DATA_HOST = 'data.sec.gov';
const CIK_PAD = 10;

interface Fact {
  start?: string;
  end: string;
  val: number;
  form: string;
  filed: string;
  fy?: number;
  fp?: string;
  frame?: string;
}

interface ConceptResp {
  label?: string;
  units?: Record<string, Fact[]>;
}

async function fetchConcept(cik: string, concept: string): Promise<ConceptResp> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(px(DATA_HOST, `/api/xbrl/companyconcept/CIK${cik}/us-gaap/${concept}.json`), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (res.status === 404) return {}; // 该标的用自定义 tag，SEC 没有这个标准概念
    if (!res.ok) throw new Error(`SEC ${concept} HTTP ${res.status}`);
    return (await res.json()) as ConceptResp;
  } finally {
    clearTimeout(timer);
  }
}

/** 取数值型 unit 的第一个数组（EPS 是 USD/shares，权益是 USD，股本是 shares） */
function factsOf(resp: ConceptResp): Fact[] {
  const units = resp.units ?? {};
  for (const key of Object.keys(units)) {
    if (Array.isArray(units[key])) return units[key];
  }
  return [];
}

const DAY = 86400000;
function isQuarter(f: Fact): boolean {
  if (!f.start || !f.end || !Number.isFinite(f.val)) return false;
  const span = (new Date(`${f.end}T00:00:00Z`).getTime() - new Date(`${f.start}T00:00:00Z`).getTime()) / DAY;
  return span >= 28 && span < 120;
}

/** 单季 EPS：同一 end 可能有多条申报（修订），取 filed 最新的一条 */
function quarterlyEps(facts: Fact[]): Fact[] {
  const byEnd = new Map<string, Fact>();
  for (const f of facts) {
    if (!isQuarter(f)) continue;
    const prev = byEnd.get(f.end);
    if (!prev || f.filed > prev.filed) byEnd.set(f.end, f);
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** 某个期末日之前的权益/股本（取 filed 不晚于 observation 的最近一条） */
function valueAt(facts: Fact[], end: string): number | null {
  const candidates = facts.filter((f) => f.end <= end && Number.isFinite(f.val) && f.form !== '10-K/A');
  if (!candidates.length) return null;
  // 优先与 EPS 同期（end 相同）的申报，其次最近的前一期
  const exact = candidates.filter((f) => f.end === end);
  const pick = (exact.length ? exact : candidates).sort((a, b) => b.filed.localeCompare(a.filed))[0];
  return pick?.val ?? null;
}

export async function fetchSecReports(code: string): Promise<QuarterReport[]> {
  const ticker = secTicker(code);
  const map = await loadCikMap();
  const cikNum = map.get(ticker.toUpperCase());
  if (!cikNum) throw new Error(`SEC 代码表里没有 ${ticker}，该标的暂不可得`);
  const cik = cikNum.padStart(CIK_PAD, '0');

  const [epsResp, equityResp, sharesResp] = await Promise.all([
    fetchConcept(cik, 'EarningsPerShareDiluted'),
    fetchConcept(cik, 'StockholdersEquity'),
    fetchConcept(cik, 'CommonStockSharesOutstanding')
  ]);

  const quarters = quarterlyEps(factsOf(epsResp));
  // 至少需要 8 个单季才能算历史分位（与 sa.ts 一致）
  if (quarters.length < 8) {
    throw new Error(`该标的 SEC 财报暂不可得（单季样本仅 ${quarters.length} 期，需 ≥8）`);
  }

  const equities = factsOf(equityResp);
  const shares = factsOf(sharesResp);

  type Row = QuarterReport & { _filed: string };
  const rows: Row[] = quarters.map((f) => {
    const equity = valueAt(equities, f.end);
    const shareCount = valueAt(shares, f.end);
    const bps = equity != null && shareCount ? equity / shareCount : 0;
    return {
      period: f.end,
      noticeDate: f.filed, // SEC 真实公告日，不用估算
      epsCum: f.val, // 单季口径；ttmEps 由下方计算
      epsQuarter: f.val,
      netProfitCum: 0,
      revenueCum: 0,
      bps,
      roe: null,
      profitYoY: null,
      revenueYoY: null,
      grossMargin: null,
      ocfPerShare: null,
      noticeEstimated: false,
      peHint: null,
      pbHint: null,
      _filed: f.filed
    };
  });

  // TTM EPS = 最近 4 个单季相加（与 sa.ts 同一口径）
  rows.forEach((r, i) => {
    const win = rows.slice(Math.max(0, i - 3), i + 1);
    if (win.length !== 4) return;
    const span = (new Date(`${win[3].period}T00:00:00Z`).getTime() - new Date(`${win[0].period}T00:00:00Z`).getTime()) / DAY;
    if (span <= 300) r.ttmEps = win.reduce((s, x) => s + x.epsQuarter!, 0);
  });

  // 清理内部字段，返回最新在前
  const out: QuarterReport[] = rows.map(({ _filed, ...r }) => r).reverse();
  return out;
}

/** 供单测使用的纯解析函数（不依赖网络） */
export function parseSecQuarterly(epsFacts: Fact[]): { end: string; val: number; filed: string }[] {
  return quarterlyEps(epsFacts).map((f) => ({ end: f.end, val: f.val, filed: f.filed }));
}
