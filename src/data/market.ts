/**
 * 市场层数据（全市场 / 基准范围）
 *
 * 「大盘」不是沪深300，而是**整个 A 股市场**（或按顶栏基准圈定的范围）。
 * 全市场某报告期的机构持仓约 9000 行（只取 01-05 五类），18 页、约 0.6 秒、0.6MB，
 * 完全可以在浏览器端一次拉全量；结果按报告期缓存 12 小时。
 *
 * 行业归属单独拉一次（BOARD_TYPE_NEW=2，约 1.7 万行），缓存 7 天，
 * 用于把全市场聚合拆成「各行业排行」。
 */
import { isBrowser, px } from './sources/proxy';

const DC_HOST = 'datacenter-web.eastmoney.com';

const UNIVERSE_PREFIX = 'mq:mkt:u:';
const INDMAP_KEY = 'mq:mkt:indmap:v4';
const UNIVERSE_TTL = 12 * 3600 * 1000;
const INDMAP_TTL = 7 * 86400 * 1000;

/** 参与「机构口径」的官方类型：基金 / QFII / 社保 / 券商 / 保险 */
const INST_TYPES = ['01', '02', '03', '04', '05'];
const SMART_TYPES = ['02', '03', '05'];

/* ============ 范围 ============ */

export type MarketScope =
  | { kind: 'all' }
  | { kind: 'prefix'; prefixes: string[]; label: string }
  | { kind: 'board'; code: string; label: string };

export const SCOPE_ALL: MarketScope = { kind: 'all' };

/** 顶栏基准代码 → 市场范围（映射不到时回退全市场） */
export const BENCH_SCOPES: Record<string, MarketScope> = {
  sh000300: { kind: 'board', code: 'BK0500', label: '沪深300' },
  sh000016: { kind: 'board', code: 'BK0611', label: '上证50' },
  sh000001: { kind: 'prefix', prefixes: ['6'], label: '沪市（上证指数）' },
  sz399001: { kind: 'prefix', prefixes: ['0', '3'], label: '深市（深证成指）' },
  sz399006: { kind: 'prefix', prefixes: ['300', '301'], label: '创业板' },
  sh000688: { kind: 'prefix', prefixes: ['688'], label: '科创板' },
  sh000010: { kind: 'board', code: 'BK0612', label: '上证180' }
};

export function scopeLabel(scope: MarketScope): string {
  return scope.kind === 'all' ? '全市场' : scope.label;
}

/* ============ 类型 ============ */

export interface MarketStock {
  code: string;
  /** 机构合计（5 类，%） */
  inst: number;
  /** 聪明资金（QFII+社保+保险，%） */
  smart: number;
  /** 公募（%） */
  fund: number;
  /** 机构持股市值（元） */
  value: number;
  /** 所属二级行业名称 */
  industry?: string;
  /** 所属行业板块代码（BKxxxx，用于下钻） */
  industryCode?: string;
}

export interface IndustryRank {
  code: string;
  name: string;
  members: number;
  instMean: number;
  smartMean: number;
  fundMean: number;
  totalValue: number;
}

export interface MarketSnapshot {
  date: string;
  prevDate: string | null;
  scope: MarketScope;
  /** 范围内的成分股 */
  stocks: MarketStock[];
  members: number;
  instMean: number;
  instMedian: number;
  smartMean: number;
  fundMean: number;
  totalValue: number;
  instChgPp: number | null;
  smartChgPp: number | null;
  /** 机构持股比例分布（用于直方图） */
  distribution: number[];
  /** 各行业排行（仅全市场口径有意义） */
  industries: IndustryRank[];
  /** 全市场覆盖的股票数 / 行业数 */
  coverage: { stocks: number; industries: number };
}

/* ============ HTTP ============ */

async function getJson<T>(path: string): Promise<T> {
  const direct = `https://${DC_HOST}${path}`;
  const list = isBrowser ? [direct, px(DC_HOST, path)] : [direct];
  let lastErr: unknown = null;
  for (const url of list) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      const text = await res.text();
      if (text.trimStart().startsWith('<')) throw new Error('got html');
      return JSON.parse(text) as T;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('unavailable');
}

interface DcResp<T> {
  success?: boolean;
  message?: string;
  result?: { data?: T[]; count?: number; pages?: number };
}

const PAGE = 500;
const CONCURRENCY = 8;

/** 并发受限的 map */
async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/** 分页拉全量（第一页探总页数，其余并发） */
async function fetchAllPages<T>(
  reportName: string,
  columns: string,
  filter: string,
  onProgress?: (done: number, total: number) => void
): Promise<T[]> {
  const build = (p: number) =>
    `/api/data/v1/get?reportName=${reportName}&columns=${columns}` +
    `&filter=${encodeURIComponent(filter)}&pageNumber=${p}&pageSize=${PAGE}`;

  const first = await getJson<DcResp<T>>(build(1));
  if (!first?.result?.data) throw new Error(first?.message || 'datacenter empty');
  const total = first.result.pages ?? 1;
  const rows: T[] = [...first.result.data];
  onProgress?.(1, total);

  if (total > 1) {
    let done = 1;
    const pages = Array.from({ length: total - 1 }, (_, i) => i + 2);
    const chunks = await mapLimit(pages, CONCURRENCY, async (p) => {
      try {
        const j = await getJson<DcResp<T>>(build(p));
        return j?.result?.data ?? [];
      } catch {
        return [] as T[];
      } finally {
        done += 1;
        onProgress?.(done, total);
      }
    });
    for (const c of chunks) rows.push(...c);
  }
  return rows;
}

/* ============ 缓存 ============ */

interface CachedUniverse {
  ts: number;
  /** 紧凑结构：c=代码, i=机构合计, s=聪明资金, f=公募, v=市值 */
  rows: { c: string; i: number; s: number; f: number; v: number }[];
}

function loadUniverse(date: string): CachedUniverse['rows'] | null {
  try {
    const raw = localStorage.getItem(UNIVERSE_PREFIX + date);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedUniverse;
    if (!c?.rows?.length || Date.now() - c.ts > UNIVERSE_TTL) return null;
    return c.rows;
  } catch {
    return null;
  }
}

function saveUniverse(date: string, rows: CachedUniverse['rows']): void {
  try {
    localStorage.setItem(UNIVERSE_PREFIX + date, JSON.stringify({ ts: Date.now(), rows }));
  } catch {
    /* 配额超限忽略 */
  }
}

interface CachedIndMap {
  ts: number;
  /** code → { n: 行业名, b: 板块代码 } */
  map: Record<string, { n: string; b: string }>;
}

function loadIndMap(): Record<string, { n: string; b: string }> | null {
  try {
    const raw = localStorage.getItem(INDMAP_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as CachedIndMap;
    if (!c?.map || Date.now() - c.ts > INDMAP_TTL) return null;
    return c.map;
  } catch {
    return null;
  }
}

function saveIndMap(map: Record<string, { n: string; b: string }>): void {
  try {
    localStorage.setItem(INDMAP_KEY, JSON.stringify({ ts: Date.now(), map }));
  } catch {
    /* 忽略 */
  }
}

/* ============ 取数 ============ */

interface RawHold {
  SECURITY_CODE?: string;
  ORG_TYPE?: string;
  TOTALSHARES_RATIO?: number;
  HOLD_VALUE?: number;
}

interface RawBoardRow {
  TOTAL_COUNT?: number;
  SCODE?: string;
  SECURITY_CODE?: string;
  BOARD_NAME?: string;
  BOARD_CODE_BK?: string;
  BOARD_TYPE_NEW?: string;
}

const num = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

/** 某报告期的全市场机构持仓（按股票聚合） */
async function fetchUniverse(date: string, onProgress?: (done: number, total: number) => void): Promise<CachedUniverse['rows']> {
  const cached = loadUniverse(date);
  if (cached) return cached;

  const filter = `(REPORT_DATE='${date}')(ORG_TYPE in (${INST_TYPES.map((t) => `"${t}"`).join(',')}))`;
  const rows = await fetchAllPages<RawHold>('RPT_MAIN_ORGHOLD', 'SECURITY_CODE,ORG_TYPE,TOTALSHARES_RATIO,HOLD_VALUE', filter, onProgress);

  const map = new Map<string, { c: string; i: number; s: number; f: number; v: number }>();
  for (const r of rows) {
    const code = String(r.SECURITY_CODE ?? '');
    if (!code) continue;
    const type = String(r.ORG_TYPE ?? '');
    const cur = map.get(code) ?? { c: code, i: 0, s: 0, f: 0, v: 0 };
    cur.i += num(r.TOTALSHARES_RATIO);
    cur.v += num(r.HOLD_VALUE);
    if (type === '01') cur.f += num(r.TOTALSHARES_RATIO);
    if (SMART_TYPES.includes(type)) cur.s += num(r.TOTALSHARES_RATIO);
    map.set(code, cur);
  }
  const out = [...map.values()];
  saveUniverse(date, out);
  return out;
}

/** 全市场「股票 → 二级行业」映射（缓存 7 天） */
async function fetchIndustryMap(
  onProgress?: (done: number, total: number) => void
): Promise<Record<string, { n: string; b: string }>> {
  const cached = loadIndMap();
  if (cached) return cached;

  const rows = await fetchAllPages<RawBoardRow>(
    'RPT_BOARD_CONSTITUENT',
    'SCODE,SECURITY_CODE,BOARD_NAME,BOARD_CODE_BK,BOARD_TYPE_NEW,TOTAL_COUNT',
    '(BOARD_TYPE_NEW="2")',
    onProgress
  );

  // 每只股票会挂 一级/二级/三级 三个行业板块，且命名不统一
  // （煤炭 / 煤炭开采 / 动力煤，银行Ⅱ / 银行 / 股份制银行Ⅲ），无法靠后缀判断层级。
  // 但成分股数量严格分层：一级 > 二级 > 三级，所以取「成分数居中」的那个当二级行业。
  const byStock = new Map<string, { name: string; board: string; count: number }[]>();
  for (const r of rows) {
    const code = String(r.SCODE ?? '').slice(2) || String(r.SECURITY_CODE ?? '');
    const name = String(r.BOARD_NAME ?? '');
    const board = String(r.BOARD_CODE_BK ?? '');
    if (!code || !name || !board) continue;
    const list = byStock.get(code) ?? [];
    list.push({ name, board, count: Number(r.TOTAL_COUNT ?? 0) });
    byStock.set(code, list);
  }

  const map: Record<string, { n: string; b: string }> = {};
  for (const [code, list] of byStock) {
    const sorted = [...list].sort((a, b) => a.count - b.count);
    // 选取顺序：① 名称带 Ⅱ 的（申万二级，最标准）
    //          ② 三个层级齐全时取成分数居中者（一级 > 二级 > 三级）
    //          ③ 只有两个时取非 Ⅲ 的那个，避免三级行业单独成行
    const pick =
      list.find((x) => /Ⅱ|II/.test(x.name)) ??
      (sorted.length >= 3 ? sorted[1] : sorted.find((x) => !/Ⅲ|III/.test(x.name)) ?? sorted[0]);
    if (pick) map[code] = { n: pick.name, b: pick.board };
  }
  saveIndMap(map);
  return map;
}

/** 板块成分（用于「跟随基准」） */
async function fetchBoardMembers(boardCode: string): Promise<string[]> {
  const rows = await fetchAllPages<RawBoardRow>(
    'RPT_BOARD_CONSTITUENT',
    'SCODE,SECURITY_CODE',
    `(BOARD_CODE_BK="${boardCode}")`
  );
  return rows.map((r) => String(r.SCODE ?? '').slice(2) || String(r.SECURITY_CODE ?? '')).filter(Boolean);
}

/**
 * 对外暴露「股票 → 二级行业」映射（带 7 天 localStorage 缓存）。
 * 情绪页复用它做行业口径，保证两个页面的行业集合完全一致。
 */
export async function getIndustryMap(
  onProgress?: (done: number, total: number) => void
): Promise<Record<string, { n: string; b: string }>> {
  return fetchIndustryMap(onProgress);
}

/* ============ 聚合 ============ */

const mean = (arr: number[]) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0);
const median = (arr: number[]): number => {
  const a = [...arr].sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

function aggregate(
  rows: CachedUniverse['rows'],
  indMap: Record<string, { n: string; b: string }>
): { stocks: MarketStock[]; industries: IndustryRank[] } {
  const stocks: MarketStock[] = rows.map((r) => ({
    code: r.c,
    inst: r.i,
    smart: r.s,
    fund: r.f,
    value: r.v,
    industry: indMap[r.c]?.n,
    industryCode: indMap[r.c]?.b
  }));

  const byInd = new Map<string, MarketStock[]>();
  for (const s of stocks) {
    if (!s.industry) continue;
    const arr = byInd.get(s.industry) ?? [];
    arr.push(s);
    byInd.set(s.industry, arr);
  }
  const industries: IndustryRank[] = [...byInd.entries()]
    .map(([name, list]) => ({
      code: list[0].industryCode ?? '',
      name,
      members: list.length,
      instMean: mean(list.map((x) => x.inst)),
      smartMean: mean(list.map((x) => x.smart)),
      fundMean: mean(list.map((x) => x.fund)),
      totalValue: list.reduce((s, x) => s + x.value, 0)
    }))
    // 成分太少的行业均值噪声极大（3-5 只就能刷到榜首），至少 8 只才纳入排行
    .filter((x) => x.members >= 8)
    .sort((a, b) => b.instMean - a.instMean);

  return { stocks, industries };
}

function inScope(stock: MarketStock, scope: MarketScope, boardSet: Set<string> | null): boolean {
  if (scope.kind === 'all') return true;
  if (scope.kind === 'prefix') return scope.prefixes.some((p) => stock.code.startsWith(p));
  return boardSet ? boardSet.has(stock.code) : true;
}

/**
 * 市场快照：按范围聚合成「机构合计 / 聪明资金 / 公募」的均值、分布与行业排行。
 * @param onProgress 进度回调（用于首屏进度条）
 */
export async function fetchMarketSnapshot(
  date: string,
  prevDate: string | null,
  scope: MarketScope = SCOPE_ALL,
  onProgress?: (done: number, total: number) => void
): Promise<MarketSnapshot> {
  // 进度：三个并行任务各自上报页数，汇总成总进度
  const state = new Map<string, { d: number; t: number }>();
  const track = (id: string) => (d: number, t: number) => {
    state.set(id, { d, t });
    if (!onProgress) return;
    let sd = 0;
    let st = 0;
    for (const v of state.values()) {
      sd += v.d;
      st += v.t;
    }
    onProgress(sd, st);
  };

  const [curRows, prevRows, indMap] = await Promise.all([
    fetchUniverse(date, track('cur')),
    prevDate ? fetchUniverse(prevDate, track('prev')) : Promise.resolve([] as CachedUniverse['rows']),
    fetchIndustryMap(track('ind'))
  ]);

  const { stocks: allStocks, industries } = aggregate(curRows, indMap);

  let boardSet: Set<string> | null = null;
  if (scope.kind === 'board') {
    try {
      boardSet = new Set(await fetchBoardMembers(scope.code));
    } catch {
      boardSet = null;
    }
  }

  const stocks = allStocks.filter((s) => inScope(s, scope, boardSet));
  const prevStocks = prevRows.map((r) => ({ code: r.c, inst: r.i, smart: r.s, fund: r.f, value: r.v } as MarketStock));
  const prevScoped = prevStocks.filter((s) => inScope(s, scope, boardSet));

  const instArr = stocks.map((s) => s.inst);
  const instMean = mean(instArr);
  const smartMean = mean(stocks.map((s) => s.smart));

  return {
    date,
    prevDate: prevDate ?? null,
    scope,
    stocks,
    members: stocks.length,
    instMean,
    instMedian: median(instArr),
    smartMean,
    fundMean: mean(stocks.map((s) => s.fund)),
    totalValue: stocks.reduce((s, x) => s + x.value, 0),
    instChgPp: prevScoped.length ? instMean - mean(prevScoped.map((s) => s.inst)) : null,
    smartChgPp: prevScoped.length ? smartMean - mean(prevScoped.map((s) => s.smart)) : null,
    distribution: instArr,
    industries,
    coverage: { stocks: allStocks.length, industries: industries.length }
  };
}

/** 清空市场层缓存（调试/手动刷新用） */
export function clearMarketCache(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(UNIVERSE_PREFIX) || k === INDMAP_KEY)
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* 忽略 */
  }
}
