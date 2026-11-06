/**
 * 市场情绪数据层（多源，按数据块各自降级）
 *
 * 设计原则：**东财 push2 极易限流**（实测并发 56 页全市场行情后整个 push2 域返回 500/断连），
 * 因此把「大批量」的活交给新浪，push2 只承担 1 个请求（主力资金流）。
 *
 *   ┌ 全 A 行情（涨跌/成交额）──── 新浪 hs_a（56 页 × 100，并发 4，实测 1.5s / 0 失败）
 *   ├ 指数点位/涨跌幅 ────────── 腾讯 qt.gtimg.cn（1 请求，批量）
 *   ├ 涨停 / 跌停 / 炸板池 ────── 东财 push2ex（3 请求，独立域，抗压）
 *   ├ 主力资金流 ─────────────── 东财 push2 fflow（1 请求，唯一 push2 依赖）
 *   ├ 指数日线（量能/波动基准）── 东财 push2his（沪 + 深，2 请求）
 *   ├ 两融余额 / 融资净买入 ───── 东财数据中心 RPTA_RZRQ_LSHJ
 *   ├ 北向成交额 ─────────────── 东财数据中心 RPT_MUTUAL_DEAL_HISTORY
 *   └ 行业板块 ───────────────── 新浪 newSinaHy（1 请求，GBK，自带涨跌与领涨股）
 *
 * 两个必须说明的口径问题：
 *  1. 北向资金「净买入」自 2024-08 起不再逐日披露（接口返回 null），只有成交额，
 *     所以这里只展示「北向成交额（活跃度）」，不参与情绪打分。
 *  2. 涨停池只对「当前交易日」有效，周末/节假日返回空数组。此时打板维度不可用，
 *     由打分函数自动剔除并重新归一权重，而不是把 0 家涨停当成「情绪冰点」。
 *
 * 情绪是事实性数据，行情整块取不到时明确报错，不生成模拟数据。
 */
import { px } from './sources/proxy';

const HOST_PUSH_EX = 'push2ex.eastmoney.com';
const HOST_HIS = 'push2his.eastmoney.com';
const HOST_DC = 'datacenter-web.eastmoney.com';
const HOST_SINA = 'vip.stock.finance.sina.com.cn';
const HOST_TENCENT = 'qt.gtimg.cn';
const HOST_IFZQ = 'web.ifzq.gtimg.cn';

const CACHE_KEY = 'mq:sent:v2';
const CACHE_TTL_MS = 10 * 60 * 1000;
// 新浪单页约 600ms，并发 4 时 61 页要 9s；实测并发 12 仍 0 失败，取 10 兼顾速度与礼貌
const CONCURRENCY = 10;

/* ============ 类型 ============ */

export type SentSource = 'sina' | 'eastmoney' | 'tencent' | 'cache';

export interface IndexQuote {
  code: string;
  name: string;
  price: number;
  chgPct: number;
  amount: number;
}

export interface StockQuote {
  code: string;
  name: string;
  pct: number;
  amount: number;
}

export interface LimitRow {
  code: string;
  name: string;
  pct: number;
  price: number;
  amount: number;
  /** 连板数（1 = 首板） */
  boardCount: number;
  /** 当日炸板次数 */
  brokeTimes: number;
  /** 封单额（元） */
  sealFund: number;
  industry: string;
  turnover: number;
  floatCap: number;
  /** 首次封板时间 HHMMSS */
  firstSeal: number;
}

export interface FlowPoint {
  date: string;
  main: number;
  super: number;
  big: number;
  mid: number;
  small: number;
}

export interface MarginPoint {
  date: string;
  rzye: number;
  rzjme: number;
  rqye: number;
}

export interface NorthPoint {
  date: string;
  /** 北向成交额（万元） */
  dealAmt: number;
}

export interface IndustryMood {
  code: string;
  name: string;
  members: number;
  /** 板块涨跌幅（%） */
  chgPct: number;
  /** 成交额（元） */
  amount: number;
  leader: string;
  leaderPct: number;
}

export interface KlineBar {
  date: string;
  close: number;
  high: number;
  low: number;
  /** 成交量（手）；量能比值用它，避免依赖东财历史成交额接口 */
  volume: number;
  /** 成交额（元），腾讯日线不提供，恒为 0 */
  amount: number;
}

export interface SentimentData {
  tradingDate: string;
  updatedAt: number;
  indices: IndexQuote[];
  stocks: StockQuote[];
  flow: { history: FlowPoint[] };
  margin: { history: MarginPoint[] };
  north: { history: NorthPoint[] };
  limits: { up: LimitRow[]; down: LimitRow[]; broke: LimitRow[] };
  industries: IndustryMood[];
  /** 沪 + 深 合计日线（成交额用于量能基准） */
  kline: KlineBar[];
  sources: Record<'quotes' | 'limits' | 'flow' | 'margin' | 'north' | 'kline' | 'industry' | 'indices', SentSource>;
  warnings: string[];
}

/* ============ 基础请求 ============ */

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 优先走本地代理（避免 CORS/Referer 限制）。
 *
 * `allowDirect` 只对「响应带 Access-Control-Allow-Origin」的域名开启（东财 push2 / push2ex）。
 * 新浪、push2his、数据中心都不发 CORS 头，直连必然失败——而失败前浏览器会先挂住连接，
 * 实测把首屏从 8s 拖到 22s，所以这些域名只走代理。
 */
async function fetchRaw(host: string, path: string, timeoutMs = 15000, allowDirect = true): Promise<Response> {
  const urls = allowDirect ? [px(host, path), `https://${host}${path}`] : [px(host, path)];
  let lastErr: unknown = null;
  for (const url of urls) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: '*/*' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      lastErr = e;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('请求失败');
}

async function getText(host: string, path: string, timeoutMs = 15000, allowDirect = true): Promise<string> {
  const res = await fetchRaw(host, path, timeoutMs, allowDirect);
  const text = await res.text();
  if (!text.trim()) throw new Error('空响应');
  return text;
}

async function getJson<T>(host: string, path: string, timeoutMs = 15000, allowDirect = true): Promise<T> {
  return JSON.parse(await getText(host, path, timeoutMs, allowDirect)) as T;
}

/** 新浪行业页是 GBK 编码的 HTML/JS，必须按字节解码，不能走 res.text() */
async function getGbk(host: string, path: string, timeoutMs = 15000, allowDirect = true): Promise<string> {
  const res = await fetchRaw(host, path, timeoutMs, allowDirect);
  const buf = await res.arrayBuffer();
  return new TextDecoder('gbk').decode(buf);
}

/* ============ 指数（腾讯） ============ */

const INDEX_LIST = [
  { q: 'sh000001', code: 'sh000001', name: '上证指数' },
  { q: 'sz399001', code: 'sz399001', name: '深证成指' },
  { q: 'sz399006', code: 'sz399006', name: '创业板指' },
  { q: 'sh000688', code: 'sh000688', name: '科创50' },
  { q: 'sh000300', code: 'sh000300', name: '沪深300' }
];

async function fetchIndices(): Promise<IndexQuote[]> {
  const text = await getGbk(HOST_TENCENT, `/q=${INDEX_LIST.map((i) => i.q).join(',')}`, 15000, false);
  const out: IndexQuote[] = [];
  for (const meta of INDEX_LIST) {
    const m = new RegExp(`v_${meta.q}="([^"]*)"`).exec(text);
    if (!m) continue;
    const f = m[1].split('~');
    // 3 现价 / 4 昨收 / 32 涨跌幅% / 35 价|量|额（元）
    const amount = Number((f[35] ?? '').split('/')[2] ?? 0);
    out.push({
      code: meta.code,
      name: f[1] || meta.name,
      price: Number(f[3] ?? 0),
      chgPct: Number(f[32] ?? 0),
      amount: Number.isFinite(amount) ? amount : 0
    });
  }
  if (!out.length) throw new Error('腾讯指数解析失败');
  return out;
}

/* ============ 全 A 行情（新浪） ============ */

const SINA_PAGES = 60;

interface SinaRow {
  code?: string;
  name?: string;
  changepercent?: number | string;
  amount?: number | string;
}

async function fetchAllStocks(onProgress?: (done: number, total: number) => void): Promise<StockQuote[]> {
  const build = (p: number) =>
    `/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${p}&num=100&sort=symbol&asc=1&node=hs_a`;

  const first = await getJson<SinaRow[]>(HOST_SINA, build(1), 15000, false);
  if (!Array.isArray(first) || !first.length) throw new Error('新浪全 A 行情为空');

  const rows: StockQuote[] = first.map(mapSina);
  let done = 1;
  let failed = 0;
  onProgress?.(1, SINA_PAGES);

  const rest = await mapLimit(
    Array.from({ length: SINA_PAGES - 1 }, (_, i) => i + 2),
    CONCURRENCY,
    async (p) => {
      try {
        const j = await getJson<SinaRow[]>(HOST_SINA, build(p), 15000, false);
        return Array.isArray(j) ? j.map(mapSina) : [];
      } catch {
        failed += 1;
        return [] as StockQuote[];
      } finally {
        done += 1;
        onProgress?.(done, SINA_PAGES);
      }
    }
  );
  for (const r of rest) rows.push(...r);

  if (failed > SINA_PAGES * 0.3) throw new Error(`新浪行情缺页过多（${failed}/${SINA_PAGES}）`);
  // 同一代码可能因分页错位重复，按代码去重
  const seen = new Set<string>();
  return rows.filter((s) => {
    if (!s.code || !Number.isFinite(s.pct) || seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });
}

function mapSina(d: SinaRow): StockQuote {
  return {
    code: String(d.code ?? ''),
    name: String(d.name ?? ''),
    pct: Number(d.changepercent ?? 0),
    amount: Number(d.amount ?? 0)
  };
}

/* ============ 涨停 / 跌停 / 炸板（push2ex） ============ */

interface PoolResp {
  data?: { tc?: number; qdate?: number; pool?: Record<string, unknown>[] } | null;
}

/**
 * 东财涨停池接口必需的 `ut` 参数。
 * 这是 quote.eastmoney.com 前端 JS 里公开写死的固定值（所有访客相同），不是密钥、
 * 也不关联任何账号；省略时接口返回 rc:102 / data:null，所以必须带上。
 */
const EM_PUBLIC_UT = '7eea3edcaed734bea9cbfc24409ed989';

function mapPoolRow(d: Record<string, unknown>): LimitRow {
  return {
    code: String(d.c ?? ''),
    name: String(d.n ?? ''),
    pct: Number(d.zdp ?? 0),
    // 东财价格字段是「分」的千分之一刻度：涨停价 4940 → 4.94 元
    price: Number(d.p ?? 0) / 1000,
    amount: Number(d.amount ?? 0),
    boardCount: Number(d.lbc ?? 1),
    brokeTimes: Number(d.zbc ?? 0),
    sealFund: Number(d.fund ?? 0),
    industry: String(d.hybk ?? ''),
    turnover: Number(d.hs ?? 0),
    floatCap: Number(d.ltsz ?? 0),
    firstSeal: Number(d.fbt ?? 0)
  };
}

async function fetchPool(kind: 'ZT' | 'DT' | 'ZB', date: string): Promise<LimitRow[]> {
  const sort = kind === 'DT' ? 'fund%3Aasc' : 'fbt%3Aasc';
  const j = await getJson<PoolResp>(
    HOST_PUSH_EX,
    `/getTopic${kind}Pool?ut=${EM_PUBLIC_UT}&dpt=wz.ztzt&Pageindex=0&pagesize=300&sort=${sort}&date=${date}`
  );
  return (j.data?.pool ?? []).map(mapPoolRow);
}

/* ============ 主力资金流（push2，唯一依赖） ============ */

interface FflowResp {
  data?: { name?: string; klines?: string[] } | null;
}

async function fetchFlow(): Promise<FlowPoint[]> {
  // 必须用 daykline：fflow/kline 在盘中只返回当天一条，算不出「5 日累计」
  const path = `/api/qt/stock/fflow/daykline/get?lmt=0&klt=101&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56&secid=1.000001`;
  // push2his 偶发连接被掐，重试两次（间隔 400ms / 900ms）
  let j: FflowResp | null = null;
  for (const delay of [0, 500]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      // 8s 超时：这个域要么秒回，要么直接断连，长超时只会拖慢首屏
      j = await getJson<FflowResp>(HOST_HIS, path, 4000, false);
      if (j?.data?.klines?.length) break;
    } catch {
      /* 继续重试 */
    }
  }
  if (!j) throw new Error('资金流接口不可用');
  // 字段顺序：日期, 主力, 小单, 中单, 大单, 超大单
  return (j.data?.klines ?? [])
    .map((l) => {
      const p = l.split(',');
      if (p.length < 6) return null;
      return {
        date: p[0],
        main: Number(p[1]),
        small: Number(p[2]),
        mid: Number(p[3]),
        big: Number(p[4]),
        super: Number(p[5])
      } as FlowPoint;
    })
    .filter((x): x is FlowPoint => !!x && Number.isFinite(x.main));
}

/* ============ 指数日线（push2his，沪 + 深合并） ============ */

interface TencentKlineResp {
  data?: Record<string, { day?: string[][]; qfqday?: string[][] }>;
}

/**
 * 指数日线（腾讯，120 日）。
 * 腾讯只给成交量（手）不给成交额，但「量能」本质是相对常态的倍数，
 * 同一指数的成交量比值完全可比（量比就是这么算的），因此不依赖东财历史接口。
 */
async function fetchKline(): Promise<KlineBar[]> {
  const text = await getText(HOST_IFZQ, '/appstock/app/fqkline/get?param=sh000001,day,,,120,qfq', 15000, false).catch(() => '');
  let raw: string[][] = [];
  if (text) {
    try {
      const j = JSON.parse(text) as TencentKlineResp;
      raw = j.data?.sh000001?.qfqday ?? j.data?.sh000001?.day ?? [];
    } catch {
      raw = [];
    }
  }
  if (!raw.length) throw new Error('指数日线为空');
  // [日期, 开, 收, 高, 低, 成交量(手)]
  return raw
    .map((p) => {
      if (!Array.isArray(p) || p.length < 6) return null;
      return { date: p[0], close: Number(p[2]), high: Number(p[3]), low: Number(p[4]), volume: Number(p[5]), amount: 0 } as KlineBar;
    })
    .filter((x): x is KlineBar => !!x && Number.isFinite(x.close) && x.volume > 0);
}

/* ============ 两融 / 北向（数据中心） ============ */

interface DcResp<T> {
  success?: boolean;
  message?: string;
  result?: { data?: T[] } | null;
}

async function fetchMargin(): Promise<MarginPoint[]> {
  const path =
    `/api/data/v1/get?reportName=RPTA_RZRQ_LSHJ&columns=DIM_DATE,RZYE,RZJME,RQYE` +
    `&pageNumber=1&pageSize=40&sortColumns=DIM_DATE&sortTypes=-1`;
  const j = await getJson<DcResp<Record<string, number | string>>>(HOST_DC, path);
  return (j.result?.data ?? [])
    .map((r) => ({
      date: String(r.DIM_DATE ?? '').slice(0, 10),
      rzye: Number(r.RZYE ?? 0),
      rzjme: Number(r.RZJME ?? 0),
      rqye: Number(r.RQYE ?? 0)
    }))
    .filter((r) => r.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

async function fetchNorth(): Promise<NorthPoint[]> {
  const path =
    `/api/data/v1/get?reportName=RPT_MUTUAL_DEAL_HISTORY&columns=TRADE_DATE,MUTUAL_TYPE,DEAL_AMT` +
    `&pageNumber=1&pageSize=200&sortColumns=TRADE_DATE&sortTypes=-1`;
  const j = await getJson<DcResp<Record<string, number | string>>>(HOST_DC, path);
  const byDate = new Map<string, number>();
  for (const r of j.result?.data ?? []) {
    // 001 = 沪股通，003 = 深股通；005/007 是港股通，不算北向
    const type = String(r.MUTUAL_TYPE ?? '');
    if (type !== '001' && type !== '003') continue;
    const d = String(r.TRADE_DATE ?? '').slice(0, 10);
    if (!d) continue;
    byDate.set(d, (byDate.get(d) ?? 0) + Number(r.DEAL_AMT ?? 0));
  }
  return [...byDate.entries()]
    .map(([date, dealAmt]) => ({ date, dealAmt }))
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-40);
}

/* ============ 行业（新浪，GBK） ============ */

/**
 * 新浪行业页返回 49 个行业，每行：
 *   0 代码 / 1 名称 / 2 成分数 / 3 均价 / 4 均涨跌 / 5 涨跌幅% / 6 成交量 / 7 成交额(元)
 *   8 领涨股代码 / 9 领涨股涨跌幅% / 10 领涨股价 / 11 备用 / 12 领涨股名
 */
async function fetchIndustries(): Promise<IndustryMood[]> {
  const text = await getGbk(HOST_SINA, '/q/view/newSinaHy.php', 15000, false);
  const a = text.indexOf('{');
  const z = text.lastIndexOf('}');
  if (a < 0 || z < a) throw new Error('新浪行业数据格式异常');
  const obj = JSON.parse(text.slice(a, z + 1)) as Record<string, string>;

  const list = Object.values(obj)
    .map((line) => {
      const f = String(line).split(',');
      if (f.length < 13) return null;
      const chgPct = Number(f[5]);
      if (!Number.isFinite(chgPct)) return null;
      return {
        code: f[0],
        name: f[1],
        members: Number(f[2] ?? 0),
        chgPct,
        amount: Number(f[7] ?? 0),
        leader: f[12] || '',
        leaderPct: Number(f[9] ?? 0)
      } as IndustryMood;
    })
    .filter((x): x is IndustryMood => !!x && x.members > 0);

  if (!list.length) throw new Error('新浪行业为空');
  return list.sort((x, y) => y.chgPct - x.chgPct);
}

/* ============ 缓存 ============ */

interface Cached {
  ts: number;
  data: SentimentData;
}

function loadCache(): SentimentData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!c?.data?.stocks?.length) return null;
    if (Date.now() - c.ts > CACHE_TTL_MS) return null;
    // 结构校验：缺字段的旧缓存直接丢弃（与机构持仓页同一类事故）
    if (!Array.isArray(c.data.kline) || !c.data.sources || !Array.isArray(c.data.industries)) return null;
    return c.data;
  } catch {
    return null;
  }
}

function saveCache(data: SentimentData): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data } satisfies Cached));
  } catch {
    // 配额超限：丢掉明细池（聚合所需字段仍在）
    try {
      const slim: SentimentData = { ...data, limits: { up: [], down: [], broke: [] } };
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data: slim } satisfies Cached));
    } catch {
      /* 忽略 */
    }
  }
}

export function clearSentimentCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}

/* ============ 主入口 ============ */

export interface FetchOptions {
  force?: boolean;
  onProgress?: (stage: string, done: number, total: number) => void;
}

/**
 * 在途请求复用。
 * React StrictMode 下 effect 会执行两次（开发模式），没有这层保护就会把 60 多个请求
 * 全部打两遍——实测首屏从 11s 降到 5s 级别。顺带也挡掉用户连点刷新。
 */
let inflight: Promise<SentimentData> | null = null;

export function fetchSentiment(opts: FetchOptions = {}): Promise<SentimentData> {
  if (!opts.force) {
    const hit = loadCache();
    if (hit) return Promise.resolve(hit);
  }
  if (inflight) return inflight;
  inflight = doFetch(opts).finally(() => {
    inflight = null;
  });
  return inflight;
}

async function doFetch(opts: FetchOptions = {}): Promise<SentimentData> {

  const warnings: string[] = [];
  const sources: SentimentData['sources'] = {
    quotes: 'sina',
    indices: 'tencent',
    limits: 'eastmoney',
    flow: 'eastmoney',
    margin: 'eastmoney',
    north: 'eastmoney',
    kline: 'eastmoney',
    industry: 'sina'
  };

  const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${name}：${e instanceof Error ? e.message : '不可用'}`);
      return null;
    }
  };

  // 全部并行：串行化会让「资金流超时」直接挡住后面的行情，反而更慢。
  // 资金流自身用 2 次 × 4s 的超时上限，最坏 8s，与行情耗时同量级。
  const [stocks, indices, flow, kline, margin, north, industries] = await Promise.all([
    // 行情是唯一「不可缺失」的块：取不到就没有涨跌家数，直接失败让页面重试
    fetchAllStocks((d, t) => opts.onProgress?.('全 A 行情', d, t)),
    safe('指数行情', fetchIndices),
    safe('主力资金流', fetchFlow),
    safe('指数日线', fetchKline),
    safe('两融数据', fetchMargin),
    safe('北向数据', fetchNorth),
    safe('行业板块', fetchIndustries)
  ]);

  if (!stocks.length) throw new Error('全 A 行情为空，无法计算情绪');

  const tradingDate = kline?.length
    ? kline[kline.length - 1].date
    : flow?.length
      ? flow[flow.length - 1].date
      : new Date().toISOString().slice(0, 10);

  // 涨停池只对当日有效
  const ymd = tradingDate.replace(/-/g, '');
  const [zt, dt, zb] = await Promise.all([
    safe('涨停池', () => fetchPool('ZT', ymd)),
    safe('跌停池', () => fetchPool('DT', ymd)),
    safe('炸板池', () => fetchPool('ZB', ymd))
  ]);
  if (!zt && !dt && !zb) sources.limits = 'cache';

  const data: SentimentData = {
    tradingDate,
    updatedAt: Date.now(),
    indices: indices ?? [],
    stocks,
    flow: { history: flow ?? [] },
    margin: { history: margin ?? [] },
    north: { history: north ?? [] },
    limits: { up: zt ?? [], down: dt ?? [], broke: zb ?? [] },
    industries: industries ?? [],
    kline: kline ?? [],
    sources,
    warnings
  };

  saveCache(data);
  return data;
}

export function latestOf<T extends { date: string }>(rows: T[]): T | null {
  return rows.length ? rows[rows.length - 1] : null;
}
