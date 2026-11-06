/**
 * 机构持仓数据层（多源 + 行业维度）
 *
 * 数据按「块」组织，每块有自己的源链，互不阻塞：
 *   ┌ 类型汇总 / 机构明细 ── 东财数据中心 RPT_MAIN_ORGHOLD / RPT_MAINDATA_MAIN_POSITIONDETAILS
 *   ├ 股东户数 ──────────── 东财 F10（新浪无此字段）
 *   └ 十大流通股东 ──────── 东财 F10 → 新浪 F10（HTML/GBK 解析）
 *
 * 东财数据中心整块不可用时，页面进入「降级模式」：只用十大流通股东做结构与集中度，
 * 不再展示需要全量明细的指标——降级是显式的，不会把样本 10 条当成全量机构。
 *
 * 行业维度：RPT_BOARD_CONSTITUENT 取所属行业与成分股，再用 `in` 过滤一次批量取全行业持仓。
 *
 * 机构持仓属于事实性数据，取不到就明确失败（页面给重试），绝不用模拟数据冒充。
 */
import type { HolderLike } from '../math/holdings';
import { isBrowser, px } from './sources/proxy';
import { fetchSinaTopHolders } from './sources/sinaF10';

const DC_HOST = 'datacenter-web.eastmoney.com';
const F10_HOST = 'emweb.securities.eastmoney.com';

// v2：数据集新增 sources / degraded / topHolders 等字段，旧结构（v1）不再兼容，
// 直接换前缀让旧缓存自然失效（否则老用户读到没有 sources 的对象会在渲染时崩）。
const CACHE_PREFIX = 'mq:inst:v2:';
const LEGACY_PREFIX = 'mq:inst:';
const CACHE_TTL_MS = 12 * 3600 * 1000;

/* ============ 类型 ============ */

export type OrgTypeKey = 'total' | 'fund' | 'qfii' | 'social' | 'broker' | 'insurance' | 'other';

export const ORG_TYPE_LABEL: Record<OrgTypeKey, string> = {
  total: '机构汇总',
  fund: '基金',
  qfii: 'QFII',
  social: '社保',
  broker: '券商',
  insurance: '保险',
  other: '其他'
};

/** 数据块来源标识（用于页面徽标与降级判断） */
export type SourceTag = 'eastmoney-dc' | 'eastmoney-f10' | 'sina-f10' | 'cache';

export const SOURCE_LABEL: Record<SourceTag, string> = {
  'eastmoney-dc': '东财数据中心',
  'eastmoney-f10': '东财 F10',
  'sina-f10': '新浪 F10',
  cache: '本地缓存'
};

/** 官方口径：某报告期、某机构类型的持仓 */
export interface OrgTypePoint {
  date: string;
  type: OrgTypeKey;
  typeName: string;
  holders: number;
  shares: number;
  value: number;
  ratio: number;
  chg: string | null;
  chgShares: number;
  chgRatio: number;
}

/** 单报告期机构明细 */
export interface HolderRow extends HolderLike {
  date: string;
  name: string;
  parent?: string;
  orgType: string;
  netAssetRatio?: number | null;
}

/** 十大流通股东（东财 F10 / 新浪 F10 统一结构） */
export interface TopHolderRow {
  name: string;
  /** 占流通股比例（%） */
  ratio: number;
  shares: number;
  /** 变动股数（东财有，新浪无） */
  chgShares: number | null;
  /** 东财的 HOLDER_TYPE 或新浪的股本性质 */
  kind: string;
}

/** 股东户数（筹码集中度） */
export interface HolderNumPoint {
  date: string;
  holders: number;
  chgPct: number | null;
  avgFreeShares: number;
  avgHoldAmt: number;
  focus: string;
  price: number;
}

export interface InstSources {
  orgHold: SourceTag | null;
  detail: SourceTag | null;
  holderNum: SourceTag | null;
  topHolders: SourceTag | null;
}

export interface InstDataset {
  code: string;
  name: string;
  updatedAt: number;
  /** 主数据源（用于整体徽标）：有类型汇总时为 dc，否则为兜底源 */
  source: SourceTag;
  cacheTs?: number;
  sources: InstSources;
  /** true = 缺少类型汇总/明细，只能按十大流通股东分析 */
  degraded: boolean;
  periods: string[];
  typePoints: OrgTypePoint[];
  summary: { date: string; holders: number; ratio: number; value: number }[];
  detailDate: string;
  detail: HolderRow[];
  detailTotal: number;
  prevDetailDate: string | null;
  prevDetail: HolderRow[];
  prevDetailTotal: number;
  holderNums: HolderNumPoint[];
  topHolders: TopHolderRow[];
  topHolderDate: string;
  warnings: string[];
}

/* ============ HTTP ============ */

function urls(host: string, path: string): string[] {
  const direct = `https://${host}${path}`;
  return isBrowser ? [direct, px(host, path)] : [direct];
}

async function getJson<T>(host: string, path: string): Promise<T> {
  let lastErr: unknown = null;
  for (const url of urls(host, path)) {
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

async function datacenter<T>(reportName: string, params: Record<string, string | number>): Promise<{ rows: T[]; total: number }> {
  const qs = Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const j = await getJson<DcResp<T>>(DC_HOST, `/api/data/v1/get?reportName=${reportName}&${qs}`);
  if (!j?.result?.data) throw new Error(j?.message || 'datacenter empty');
  return { rows: j.result.data, total: j.result.count ?? j.result.data.length };
}

/* ============ 解析 ============ */

const n = (v: unknown): number => {
  const x = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(x) ? x : 0;
};

const day = (s: unknown): string => String(s ?? '').slice(0, 10);

function mapOrgType(code: string): OrgTypeKey {
  switch (String(code)) {
    case '00':
      return 'total';
    case '01':
      return 'fund';
    case '02':
      return 'qfii';
    case '03':
      return 'social';
    case '04':
      return 'broker';
    case '05':
      return 'insurance';
    default:
      return 'other';
  }
}

interface RawOrgHold {
  SECURITY_CODE?: string;
  SECURITY_NAME_ABBR?: string;
  REPORT_DATE?: string;
  ORG_TYPE?: string;
  ORG_TYPE_NAME?: string;
  HOULD_NUM?: number;
  TOTAL_SHARES?: number;
  HOLD_VALUE?: number;
  TOTALSHARES_RATIO?: number;
  HOLDCHA?: string | null;
  HOLDCHA_NUM?: number;
  HOLDCHA_RATIO?: number;
}

interface RawPosition {
  REPORT_DATE?: string;
  HOLDER_NAME?: string;
  PARENT_ORG_NAME?: string | null;
  ORG_TYPE?: string;
  TOTAL_SHARES?: number;
  HOLD_MARKET_CAP?: number;
  TOTAL_SHARES_RATIO?: number;
  NETASSET_RATIO?: number | null;
}

interface RawF10 {
  gdrs?: {
    END_DATE?: string;
    HOLDER_TOTAL_NUM?: number;
    TOTAL_NUM_RATIO?: number | null;
    AVG_FREE_SHARES?: number;
    AVG_HOLD_AMT?: number;
    HOLD_FOCUS?: string;
    PRICE?: number;
  }[];
  sdltgd?: {
    END_DATE?: string;
    HOLDER_NAME?: string;
    HOLDER_TYPE?: string;
    FREE_HOLDNUM_RATIO?: number;
    HOLD_NUM?: number;
    HOLD_NUM_CHANGE?: number | null;
  }[];
}

interface RawBoard {
  BOARD_TYPE_NEW?: string;
  BOARD_CODE?: string;
  BOARD_NAME?: string;
  BOARD_CODE_BK?: string;
  SECURITY_CODE?: string;
  SCODE?: string;
}

/* ============ 取数（各数据块） ============ */

async function fetchOrgHold(bare: string): Promise<RawOrgHold[]> {
  const { rows } = await datacenter<RawOrgHold>('RPT_MAIN_ORGHOLD', {
    columns:
      'SECURITY_NAME_ABBR,REPORT_DATE,ORG_TYPE,ORG_TYPE_NAME,HOULD_NUM,TOTAL_SHARES,HOLD_VALUE,TOTALSHARES_RATIO,HOLDCHA,HOLDCHA_NUM,HOLDCHA_RATIO',
    filter: `(SECURITY_CODE="${bare}")`,
    pageNumber: 1,
    pageSize: 500,
    sortColumns: 'REPORT_DATE',
    sortTypes: -1
  });
  return rows;
}

/** 明细：按市值降序，最多 3 页（1500 条） */
async function fetchDetail(bare: string, date: string): Promise<{ rows: RawPosition[]; total: number }> {
  const PAGE = 500;
  const MAX_PAGES = 3;
  const rows: RawPosition[] = [];
  let total = 0;
  for (let p = 1; p <= MAX_PAGES; p++) {
    const j = await getJson<DcResp<RawPosition>>(
      DC_HOST,
      `/api/data/v1/get?reportName=RPT_MAINDATA_MAIN_POSITIONDETAILS` +
        `&columns=REPORT_DATE,HOLDER_NAME,PARENT_ORG_NAME,ORG_TYPE,TOTAL_SHARES,HOLD_MARKET_CAP,TOTAL_SHARES_RATIO,NETASSET_RATIO` +
        `&filter=${encodeURIComponent(`(SECURITY_CODE="${bare}")(REPORT_DATE='${date}')`)}` +
        `&pageNumber=${p}&pageSize=${PAGE}&sortColumns=HOLD_MARKET_CAP&sortTypes=-1`
    );
    if (!j?.result?.data) {
      if (p === 1) throw new Error(j?.message || 'detail empty');
      break;
    }
    total = j.result.count ?? j.result.data.length;
    rows.push(...j.result.data);
    if (j.result.data.length < PAGE) break;
  }
  return { rows, total };
}

/** F10 站不返回 CORS 头，浏览器优先走本地代理 */
async function getJsonF10<T>(path: string): Promise<T> {
  const direct = `https://${F10_HOST}${path}`;
  const list = isBrowser ? [px(F10_HOST, path), direct] : [direct];
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

/** F10 代码：sh600519 → SH600519 */
const f10Code = (code: string) => code.toUpperCase();

async function fetchF10(code: string): Promise<RawF10> {
  return getJsonF10<RawF10>(`/PC_HSF10/ShareholderResearch/PageAjax?code=${f10Code(code)}`);
}

function mapDetail(rows: RawPosition[]): HolderRow[] {
  return rows.map((r) => ({
    date: day(r.REPORT_DATE),
    name: String(r.HOLDER_NAME ?? '').trim(),
    parent: r.PARENT_ORG_NAME ?? undefined,
    orgType: String(r.ORG_TYPE ?? ''),
    shares: n(r.TOTAL_SHARES),
    value: n(r.HOLD_MARKET_CAP),
    ratio: n(r.TOTAL_SHARES_RATIO),
    netAssetRatio: r.NETASSET_RATIO == null ? null : n(r.NETASSET_RATIO)
  }));
}

/** 单独取某报告期的机构明细（页面切换报告期时按需调用） */
export async function fetchInstitutionDetail(
  code: string,
  date: string
): Promise<{ rows: HolderRow[]; total: number }> {
  const bare = code.replace(/^(sh|sz|bj)/, '');
  const { rows, total } = await fetchDetail(bare, date);
  return { rows: mapDetail(rows), total };
}

/* ============ 报告期口径（可比性） ============ */

/**
 * 报告期披露口径：
 *  - full   ：Q2（半年报）/ Q4（年报）→ 基金披露**全部**持仓
 *  - partial：Q1 / Q3（季报）→ 基金只披露**前十大重仓股**
 *
 * 因此两类报告期的机构持仓水平系统性不同（实测沪深300：半年报均值 ~8-11%，季报 ~6-7%），
 * 跨类型比较会得出虚假的暴增/暴跌。所有环比、时序都必须限制在同类报告期之间。
 */
export type ReportKind = 'full' | 'partial';

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  full: '半年报/年报（全量披露）',
  partial: '季报（仅前十大重仓）'
};

export function reportKind(date: string): ReportKind {
  const m = date.slice(5, 7);
  return m === '06' || m === '12' ? 'full' : 'partial';
}

/** 在报告期列表里找「同口径」的上一期（通常就是去年同期） */
export function sameKindPrev(periods: string[], date: string): string | null {
  const kind = reportKind(date);
  const earlier = periods.filter((d) => d < date && reportKind(d) === kind).sort((a, b) => (a < b ? 1 : -1));
  return earlier[0] ?? null;
}

/** 只保留与 date 同口径的报告期（升序） */
export function sameKindPeriods(periods: string[], date: string): string[] {
  const kind = reportKind(date);
  return periods.filter((d) => reportKind(d) === kind).sort((a, b) => (a < b ? -1 : 1));
}

/* ============ 披露完整性 ============ */

/** 家数低于上期的 80% 视为「该期尚未披露完整」 */
export const DISCLOSURE_RATIO = 0.8;

export function incompleteDates(ds: Pick<InstDataset, 'periods' | 'summary'>): Set<string> {
  const out = new Set<string>();
  const sum = new Map(ds.summary.map((s) => [s.date, s]));
  for (const d of ds.periods) {
    const cur = sum.get(d);
    // 家数也要同口径比较：季报天然只披露前十大重仓，和半年报比会误判成「披露未完整」
    const prevDate = sameKindPrev(ds.periods, d);
    const prev = prevDate ? sum.get(prevDate) : null;
    if (cur && prev && prev.holders > 0 && cur.holders < prev.holders * DISCLOSURE_RATIO) out.add(d);
  }
  return out;
}

export function defaultDisplayDate(ds: Pick<InstDataset, 'periods' | 'summary'>): string {
  const bad = incompleteDates(ds);
  // 优先最近一个「全量披露（半年报/年报）」且披露完整的期：
  // 季报只披露前十大重仓，作为首屏会让机构持仓被系统性低估。
  for (let i = ds.periods.length - 1; i >= 0; i--) {
    const d = ds.periods[i];
    if (!bad.has(d) && reportKind(d) === 'full') return d;
  }
  // 没有全量期时退而求其次：最近一个披露完整的期
  for (let i = ds.periods.length - 1; i >= 0; i--) if (!bad.has(ds.periods[i])) return ds.periods[i];
  return ds.periods[ds.periods.length - 1] ?? '';
}

/* ============ 缓存 ============ */

interface Cached {
  ts: number;
  data: Omit<InstDataset, 'source' | 'cacheTs'>;
}

function saveCache(code: string, data: Omit<InstDataset, 'source' | 'cacheTs'>): void {
  try {
    localStorage.setItem(CACHE_PREFIX + code, JSON.stringify({ ts: Date.now(), data }));
  } catch {
    /* 配额超限忽略 */
  }
}

/**
 * 结构校验：缓存可能是旧版本写入的（字段缺失），直接拿来渲染会抛
 * 「Cannot read properties of undefined (reading 'orgHold')」这类错误。
 * 这里按页面真正用到的字段做白名单校验，不合格就丢弃并清掉。
 */
export function isValidCached(data: unknown): data is Omit<InstDataset, 'source' | 'cacheTs'> {
  if (!data || typeof data !== 'object') return false;
  const d = data as Partial<InstDataset>;
  return (
    Array.isArray(d.periods) &&
    Array.isArray(d.typePoints) &&
    Array.isArray(d.summary) &&
    Array.isArray(d.detail) &&
    Array.isArray(d.topHolders) &&
    Array.isArray(d.holderNums) &&
    typeof d.degraded === 'boolean' &&
    !!d.sources &&
    typeof d.sources === 'object'
  );
}

function loadCache(code: string): { data: Omit<InstDataset, 'source' | 'cacheTs'>; ts: number } | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + code);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!c?.data || !Number.isFinite(c.ts) || !isValidCached(c.data)) {
      localStorage.removeItem(CACHE_PREFIX + code);
      return null;
    }
    return { data: c.data, ts: c.ts };
  } catch {
    return null;
  }
}

/** 清掉 v1 前缀的旧缓存，释放配额（模块加载时执行一次） */
function purgeLegacyCache(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LEGACY_PREFIX) && !k.startsWith(CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* 隐私模式忽略 */
  }
}

if (typeof localStorage !== 'undefined') purgeLegacyCache();

export function invalidateInstCache(code: string): void {
  try {
    localStorage.removeItem(CACHE_PREFIX + code);
  } catch {
    /* 忽略 */
  }
}

/* ============ 组装主数据集 ============ */

export interface FetchInstOptions {
  force?: boolean;
}

/** 十大流通股东：东财 F10 → 新浪 F10 */
async function fetchTopHolders(
  code: string,
  f10: RawF10 | null
): Promise<{ rows: TopHolderRow[]; date: string; source: SourceTag | null }> {
  const em = (f10?.sdltgd ?? [])
    .map((h) => ({
      name: String(h.HOLDER_NAME ?? '').trim(),
      ratio: n(h.FREE_HOLDNUM_RATIO),
      shares: n(h.HOLD_NUM),
      chgShares: h.HOLD_NUM_CHANGE == null ? null : n(h.HOLD_NUM_CHANGE),
      kind: h.HOLDER_TYPE ?? ''
    }))
    .filter((h) => h.name);
  if (em.length) {
    const date = day(f10?.sdltgd?.[0]?.END_DATE);
    return { rows: em, date, source: 'eastmoney-f10' };
  }

  // 备用源：新浪（只有最新一期、无变动股数）
  try {
    const sina = await fetchSinaTopHolders(code);
    if (sina?.holders.length) {
      return {
        rows: sina.holders.map((h) => ({
          name: h.name,
          ratio: h.ratio,
          shares: h.shares,
          chgShares: null,
          kind: h.nature
        })),
        date: sina.date,
        source: 'sina-f10'
      };
    }
  } catch {
    /* 两个源都失败 */
  }
  return { rows: [], date: '', source: null };
}

/**
 * 取某只 A 股的机构持仓数据集（多源编排）。
 * 全部失败时抛错，除非有缓存。
 */
export async function fetchInstitutions(code: string, opts: FetchInstOptions = {}): Promise<InstDataset> {
  const bare = code.replace(/^(sh|sz|bj)/, '');
  const cached = opts.force ? null : loadCache(code);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return { ...cached.data, source: 'cache', cacheTs: cached.ts };
  }

  const warnings: string[] = [];
  const sources: InstSources = { orgHold: null, detail: null, holderNum: null, topHolders: null };

  // 1) 并行取「类型汇总」与「东财 F10」——两者互不依赖
  const [orgHoldRes, f10Res] = await Promise.allSettled([fetchOrgHold(bare), fetchF10(code)]);
  const raw = orgHoldRes.status === 'fulfilled' ? orgHoldRes.value : [];
  const f10 = f10Res.status === 'fulfilled' ? f10Res.value : null;
  if (f10) sources.holderNum = 'eastmoney-f10';
  if (!f10) warnings.push('东财 F10 未取到');

  // 2) 十大流通股东（F10 → 新浪）
  const top = await fetchTopHolders(code, f10);
  sources.topHolders = top.source;

  // 3) 类型汇总解析
  const typePoints: OrgTypePoint[] = [];
  const summary: InstDataset['summary'] = [];
  const dates = new Set<string>();
  for (const r of raw) {
    const date = day(r.REPORT_DATE);
    if (!date) continue;
    const type = mapOrgType(String(r.ORG_TYPE ?? ''));
    dates.add(date);
    if (type === 'total') {
      summary.push({ date, holders: n(r.HOULD_NUM), ratio: n(r.TOTALSHARES_RATIO), value: n(r.HOLD_VALUE) });
    } else {
      typePoints.push({
        date,
        type,
        typeName: r.ORG_TYPE_NAME || ORG_TYPE_LABEL[type],
        holders: n(r.HOULD_NUM),
        shares: n(r.TOTAL_SHARES),
        value: n(r.HOLD_VALUE),
        ratio: n(r.TOTALSHARES_RATIO),
        chg: r.HOLDCHA ?? null,
        chgShares: n(r.HOLDCHA_NUM),
        chgRatio: n(r.HOLDCHA_RATIO)
      });
    }
  }
  const periods = [...dates].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  summary.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (periods.length) sources.orgHold = 'eastmoney-dc';

  // 4) 明细（仅当类型汇总可用；取「默认展示期」及其上一期）
  let detailDate = '';
  let detail: HolderRow[] = [];
  let detailTotal = 0;
  let prevDetailDate: string | null = null;
  let prevDetail: HolderRow[] = [];
  let prevDetailTotal = 0;

  if (periods.length) {
    detailDate = defaultDisplayDate({ periods, summary });
    // 上一期必须同口径（季报只披露前十大重仓，和半年报不可比）
    prevDetailDate = sameKindPrev(periods, detailDate);
    const [cur, prev] = await Promise.all([
      fetchDetail(bare, detailDate).catch(() => ({ rows: [] as RawPosition[], total: 0 })),
      prevDetailDate
        ? fetchDetail(bare, prevDetailDate).catch(() => ({ rows: [] as RawPosition[], total: 0 }))
        : Promise.resolve({ rows: [] as RawPosition[], total: 0 })
    ]);
    detail = mapDetail(cur.rows);
    detailTotal = cur.total;
    prevDetail = mapDetail(prev.rows);
    prevDetailTotal = prev.total;
    if (detail.length) sources.detail = 'eastmoney-dc';
    else warnings.push('当期机构明细未取到，仅展示类型汇总');
  } else {
    warnings.push('东财数据中心不可达，已降级为「十大流通股东」口径');
  }

  // 5) 股东户数
  const holderNums: HolderNumPoint[] = (f10?.gdrs ?? [])
    .map((g) => ({
      date: day(g.END_DATE),
      holders: n(g.HOLDER_TOTAL_NUM),
      chgPct: g.TOTAL_NUM_RATIO == null ? null : n(g.TOTAL_NUM_RATIO),
      avgFreeShares: n(g.AVG_FREE_SHARES),
      avgHoldAmt: n(g.AVG_HOLD_AMT),
      focus: g.HOLD_FOCUS ?? '',
      price: n(g.PRICE)
    }))
    .filter((p) => p.date)
    .sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!holderNums.length) warnings.push('股东户数未取到，筹码集中度分析不可用');

  const degraded = !sources.orgHold;
  if (degraded && !top.rows.length) {
    // 连十大流通股东都没有：视为彻底失败，走缓存
    const fallback = loadCache(code);
    if (fallback) {
      return {
        ...fallback.data,
        source: 'cache',
        cacheTs: fallback.ts,
        warnings: [...fallback.data.warnings, '实时源暂不可达，当前为本地缓存']
      };
    }
    throw new Error('机构持仓数据不可达（东财数据中心、东财 F10、新浪 F10 均失败）');
  }

  const data: Omit<InstDataset, 'source' | 'cacheTs'> = {
    code,
    // 名称只认官方报表；降级时留空，由页面用搜索到的标的名兜底（否则会误用第一大股东的名字）
    name: raw[0]?.SECURITY_NAME_ABBR || '',
    updatedAt: Date.now(),
    sources,
    degraded,
    periods,
    typePoints,
    summary,
    detailDate,
    detail,
    detailTotal,
    prevDetailDate,
    prevDetail,
    prevDetailTotal,
    holderNums,
    topHolders: top.rows,
    topHolderDate: top.date,
    warnings
  };
  saveCache(code, data);
  const primary: SourceTag = sources.orgHold ?? sources.topHolders ?? 'eastmoney-dc';
  return { ...data, source: primary };
}

/* ============ 行业维度 ============ */

export interface IndustryInfo {
  code: string;
  name: string;
  memberCount: number;
}

export interface IndustryPeer {
  code: string;
  name: string;
  /** 官方口径机构持股比例（基金+QFII+社保+券商+保险，剔除「其他」） */
  instRatio: number;
  holders: number;
  value: number;
  /** 各类型占比（官方口径） */
  byType: Partial<Record<OrgTypeKey, number>>;
}

export interface IndustrySnapshot {
  industry: IndustryInfo;
  date: string;
  peers: IndustryPeer[];
  /** 该股在行业内的排名（1 = 最高）；找不到为 null */
  rank: number | null;
  mean: number;
  median: number;
  /** 行业机构持股市值合计（元） */
  totalValue: number;
  /** 行业机构家数合计 */
  totalHolders: number;
  /** 行业各类型平均占比（用于与该股做结构对比） */
  typeMean: { type: OrgTypeKey; label: string; ratio: number }[];
  /** 行业公募持仓强度时序（成分股基金持股比例的均值） */
  history: { date: string; fundRatio: number }[];
}

/** 所属行业：东财行业板块（BOARD_TYPE_NEW=2），优先二级（Ⅱ）再三级（Ⅲ） */
export async function fetchIndustry(code: string): Promise<IndustryInfo | null> {
  const bareCode = code.replace(/^(sh|sz|bj)/, '');
  const { rows } = await datacenter<RawBoard>('RPT_BOARD_CONSTITUENT', {
    columns: 'BOARD_TYPE_NEW,BOARD_CODE,BOARD_NAME,BOARD_CODE_BK',
    filter: `(SECURITY_CODE="${bareCode}")`,
    pageNumber: 1,
    pageSize: 50
  });
  const inds = rows.filter((r) => String(r.BOARD_TYPE_NEW) === '2' && r.BOARD_CODE_BK);
  if (!inds.length) return null;
  const pick =
    inds.find((r) => /Ⅱ|II/.test(String(r.BOARD_NAME))) ??
    inds.find((r) => /Ⅲ|III/.test(String(r.BOARD_NAME))) ??
    inds[0];
  return { code: String(pick.BOARD_CODE_BK), name: String(pick.BOARD_NAME), memberCount: 0 };
}

/** 行业成分股代码 */
async function fetchIndustryMembers(boardCode: string): Promise<{ code: string; name: string }[]> {
  const out: { code: string; name: string }[] = [];
  for (let p = 1; p <= 3; p++) {
    const { rows, total } = await datacenter<RawBoard>('RPT_BOARD_CONSTITUENT', {
      columns: 'SECURITY_CODE,SCODE,BOARD_NAME',
      filter: `(BOARD_CODE_BK="${boardCode}")`,
      pageNumber: p,
      pageSize: 200
    });
    for (const r of rows) {
      const scode = String(r.SCODE ?? '');
      const code = scode.toLowerCase() || String(r.SECURITY_CODE ?? '');
      if (code) out.push({ code, name: '' });
    }
    if (out.length >= total || rows.length < 200) break;
  }
  return out;
}

const CHUNK = 60;
/** 行业时序回看的报告期数 */
const HISTORY_PERIODS = 8;

const chunked = <T,>(arr: T[], size = CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

/**
 * 行业快照：当期各成分股持仓 + 类型结构 + 公募持仓强度时序。
 * 全部用 `in` 批量过滤，180 只成分股也只需 7 个请求左右。
 */
export async function fetchIndustrySnapshot(
  industry: IndustryInfo,
  date: string,
  focusCode?: string
): Promise<IndustrySnapshot> {
  const members = await fetchIndustryMembers(industry.code);
  if (!members.length) throw new Error('行业成分股为空');

  const codes = members.map((m) => m.code.replace(/^(sh|sz|bj)/, ''));
  const chunks = chunked(codes);

  const current = (c: string[]) =>
    datacenter<RawOrgHold>('RPT_MAIN_ORGHOLD', {
      columns: 'SECURITY_CODE,SECURITY_NAME_ABBR,REPORT_DATE,ORG_TYPE,HOULD_NUM,TOTALSHARES_RATIO,HOLD_VALUE',
      filter: `(SECURITY_CODE in (${c.map((x) => `"${x}"`).join(',')}))(REPORT_DATE='${date}')`,
      pageNumber: 1,
      pageSize: 500
    })
      .then((r) => r.rows)
      .catch(() => [] as RawOrgHold[]);

  // 时序只取「基金」一类：60 只 × 8 期 ≈ 480 行，一页即可
  const historyOf = (c: string[]) =>
    datacenter<RawOrgHold>('RPT_MAIN_ORGHOLD', {
      columns: 'SECURITY_CODE,REPORT_DATE,ORG_TYPE,TOTALSHARES_RATIO',
      filter: `(SECURITY_CODE in (${c.map((x) => `"${x}"`).join(',')}))(ORG_TYPE="01")`,
      pageNumber: 1,
      pageSize: 500,
      sortColumns: 'REPORT_DATE',
      sortTypes: -1
    })
      .then((r) => r.rows)
      .catch(() => [] as RawOrgHold[]);

  const [curChunks, histChunks] = await Promise.all([
    Promise.all(chunks.map(current)),
    Promise.all(chunks.map(historyOf))
  ]);

  const rows = curChunks.flat();
  const histRows = histChunks.flat();

  const byCode = new Map<string, IndustryPeer>();
  for (const r of rows) {
    const type = mapOrgType(String(r.ORG_TYPE ?? ''));
    // 只用纯机构类型：剔除「机构汇总」(00) 与「其他」(07，混有控股股东)
    if (type === 'total' || type === 'other') continue;
    const code = String(r.SECURITY_CODE ?? '');
    if (!code) continue;
    const cur =
      byCode.get(code) ??
      ({ code, name: r.SECURITY_NAME_ABBR ?? '', instRatio: 0, holders: 0, value: 0, byType: {} } as IndustryPeer);
    cur.instRatio += n(r.TOTALSHARES_RATIO);
    cur.holders += n(r.HOULD_NUM);
    cur.value += n(r.HOLD_VALUE);
    cur.byType[type] = (cur.byType[type] ?? 0) + n(r.TOTALSHARES_RATIO);
    byCode.set(code, cur);
  }

  const peers = [...byCode.values()].sort((a, b) => b.instRatio - a.instRatio);
  const vals = peers.map((p) => p.instRatio);
  const mean = vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const medianV = sorted.length
    ? sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : 0;

  // 行业各类型平均占比（分母为成分股数，含未持有该类型的 0）
  const typeMean: IndustrySnapshot['typeMean'] = (['fund', 'qfii', 'social', 'insurance', 'broker'] as OrgTypeKey[]).map((t) => ({
    type: t,
    label: ORG_TYPE_LABEL[t],
    ratio: peers.length ? peers.reduce((s, p) => s + (p.byType[t] ?? 0), 0) / peers.length : 0
  }));

  // 行业公募持仓强度时序：只保留与当期同口径的报告期，避免季报/半年报混画成锯齿
  const kind = reportKind(date);
  const byDate = new Map<string, number[]>();
  for (const r of histRows) {
    const d = day(r.REPORT_DATE);
    if (!d || reportKind(d) !== kind) continue;
    const arr = byDate.get(d) ?? [];
    arr.push(n(r.TOTALSHARES_RATIO));
    byDate.set(d, arr);
  }
  const history = [...byDate.entries()]
    .map(([d, arr]) => ({ date: d, fundRatio: arr.reduce((s, v) => s + v, 0) / arr.length }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-HISTORY_PERIODS);

  const bareFocus = (focusCode ?? '').replace(/^(sh|sz|bj)/, '');
  const idx = peers.findIndex((p) => p.code === bareFocus);

  return {
    industry: { ...industry, memberCount: peers.length },
    date,
    peers,
    rank: idx >= 0 ? idx + 1 : null,
    mean,
    median: medianV,
    totalValue: peers.reduce((s, p) => s + p.value, 0),
    totalHolders: peers.reduce((s, p) => s + p.holders, 0),
    typeMean,
    history
  };
}
