/**
 * 美股 SEC EDGAR 适配器
 *
 * 两个接口：
 *   1. https://www.sec.gov/files/company_tickers.json   ticker → CIK（全量约 800KB，缓存 24h）
 *   2. https://data.sec.gov/submissions/CIK##########.json  最近 1000 条申报（缓存 30min）
 *
 * 注意：
 *  - SEC 要求 User-Agent 声明应用与联系方式，浏览器不能自定义 UA，
 *    由代理层（vite / server.mjs）统一注入；
 *  - 申报**没有标题**，只有 form 类型和 items 编号，标签靠 form 枚举映射（见 math/stockNews.classifyUs）；
 *  - 限流 10 请求/秒，我们一次查询最多 2 个请求 + 双层缓存，不会触发。
 */
import { px } from '../sources/proxy';
import { usFormLabel, type AnnInput } from '../../math/stockNews';

const CIK_HOST = 'www.sec.gov';
const DATA_HOST = 'data.sec.gov';

const CIK_CACHE_KEY = 'mq:sec:cik:v1';
const CIK_TTL_MS = 24 * 60 * 60 * 1000;
const SUB_TTL_MS = 30 * 60 * 1000;
const subKey = (cik: string) => `mq:sec:sub:v1:${cik}`;

export interface SecFetch {
  list: AnnInput[];
  total: number;
  name?: string;
}

/** usAAPL → AAPL；usBRK.B → BRK-B（SEC 用连字符） */
export function secTicker(code: string): string {
  return String(code ?? '')
    .trim()
    .replace(/^us/i, '')
    .replace(/\./g, '-')
    .toUpperCase();
}

/* ============ ticker → CIK ============ */

interface CikCache {
  ts: number;
  /** "AAPL:0000320193,MSFT:0000789019,..." 紧凑存储，避免 800KB JSON 撑爆 localStorage */
  data: string;
}

let cikMap: Map<string, string> | null = null;

function parseCikBlob(blob: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of blob.split(',')) {
    const i = pair.lastIndexOf(':');
    if (i > 0) m.set(pair.slice(0, i), pair.slice(i + 1));
  }
  return m;
}

/** 导出给估值模块复用（同一份 24h 缓存，避免重复拉 800KB 代码表） */
export async function loadCikMap(): Promise<Map<string, string>> {
  if (cikMap) return cikMap;

  try {
    const raw = localStorage.getItem(CIK_CACHE_KEY);
    if (raw) {
      const c = JSON.parse(raw) as CikCache;
      if (c?.data && Date.now() - c.ts < CIK_TTL_MS) {
        cikMap = parseCikBlob(c.data);
        return cikMap;
      }
    }
  } catch {
    /* 忽略缓存损坏 */
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let json: Record<string, { cik_str?: number; ticker?: string }>;
  try {
    const res = await fetch(px(CIK_HOST, '/files/company_tickers.json'), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`SEC 代码表 HTTP ${res.status}`);
    json = (await res.json()) as Record<string, { cik_str?: number; ticker?: string }>;
  } finally {
    clearTimeout(timer);
  }

  const m = new Map<string, string>();
  for (const k of Object.keys(json)) {
    const it = json[k];
    const t = String(it?.ticker ?? '').toUpperCase();
    const cik = String(it?.cik_str ?? '');
    if (t && cik) m.set(t, cik.padStart(10, '0'));
  }
  if (!m.size) throw new Error('SEC 代码表为空');

  cikMap = m;
  try {
    localStorage.setItem(CIK_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: [...m].map(([k, v]) => `${k}:${v}`).join(',') } satisfies CikCache));
  } catch {
    /* 忽略配额 */
  }
  return m;
}

/* ============ submissions ============ */

interface Recent {
  accessionNumber?: string[];
  filingDate?: string[];
  form?: string[];
  items?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
}

interface SubResp {
  cik?: string;
  name?: string;
  tickers?: string[];
  filings?: { recent?: Recent };
}

interface SubCache {
  ts: number;
  data: { list: AnnInput[]; total: number; name?: string };
}

export async function fetchSecFilings(code: string, size = 40): Promise<SecFetch> {
  const ticker = secTicker(code);
  if (!ticker) throw new Error('代码为空');

  const map = await loadCikMap();
  const cik = map.get(ticker);
  if (!cik) throw new Error(`SEC 未收录该代码（${ticker}）`);

  try {
    const raw = localStorage.getItem(subKey(cik));
    if (raw) {
      const c = JSON.parse(raw) as SubCache;
      if (c?.data?.list?.length && Date.now() - c.ts < SUB_TTL_MS) return c.data;
    }
  } catch {
    /* 忽略 */
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let json: SubResp;
  try {
    const res = await fetch(px(DATA_HOST, `/submissions/CIK${cik}.json`), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`SEC 申报 HTTP ${res.status}`);
    json = (await res.json()) as SubResp;
  } finally {
    clearTimeout(timer);
  }

  const r = json?.filings?.recent;
  if (!r?.form?.length) throw new Error('该标的暂无 SEC 申报');

  const cikNum = String(Number(cik));
  const n = Math.min(r.form.length, size);
  const list: AnnInput[] = [];

  for (let i = 0; i < n; i++) {
    const form = String(r.form[i] ?? '').trim();
    if (!form) continue;
    const items = String(r.items?.[i] ?? '').trim();
    const acc = String(r.accessionNumber?.[i] ?? '');
    const doc = String(r.primaryDocument?.[i] ?? '');
    const date = String(r.filingDate?.[i] ?? '').slice(0, 10);

    // SEC 没有标题：用「form + 中文说明」当标题，标签由 classifyUs 从 kind(form) 反推
    const label = usFormLabel(form);
    const title = label ? `${form} ${label}` : form;
    const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc.replace(/-/g, '')}`;

    list.push({
      id: `US:${acc || `${form}-${date}-${i}`}`,
      title,
      date,
      column: items,
      url: acc ? `${base}/${doc}` : undefined,
      market: 'US',
      kind: form
    });
  }

  if (!list.length) throw new Error('该标的暂无 SEC 申报');
  const data = { list, total: list.length, name: json.name };
  try {
    localStorage.setItem(subKey(cik), JSON.stringify({ ts: Date.now(), data } satisfies SubCache));
  } catch {
    /* 忽略配额 */
  }
  return data;
}
