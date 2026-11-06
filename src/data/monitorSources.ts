/**
 * 实时监控的多源适配层
 *
 * 单源有两个致命问题：一是被限流后整个面板瞎掉，二是不同源覆盖的消息本来就不一样
 * （财联社偏政策、新浪 7x24 偏盘面播报、东财快讯偏公司与行业）。
 * 所以这里做两件事：
 *
 *  行情：腾讯（五市场）为主，东财 / 新浪（A 股·港·美）、Naver（韩）、Yahoo JP（日）为备；
 *        主源失效时按市场补齐，平时低频交叉验证，避免单源错价。
 *  快讯：财联社为主，新浪 7x24 / 东财快讯为备；默认「主源 + 故障切换 + 低频交叉」，
 *        不默认三源齐发——那会把请求量直接翻三倍，正是要避免的。
 *
 * 所有请求都经过 rateLimit.guardedFetch；被预算/冷却拦下时抛 BudgetSkipped，
 * 由调用方沿用上一轮快照，不把错误抛到界面。
 */
import {
  guardedFetch, guardedGbk, guardedJson, BudgetSkipped,
  canRequest, noteSuccess, noteFailure, getStats, type HostStat
} from './rateLimit';
import { clsSign, parseFlashes } from './cls';
import { emSecidOf } from './sources/eastmoney';
import { marketOfCode, parseTencentQuotes } from './monitor';
import type { Quote } from '../math/monitor';
import type { NewsLike } from '../math/news';

/* ============ 通用类型 ============ */

export type FlashSourceId = 'cls' | 'sina' | 'em';
export type QuoteSourceId = 'tencent' | 'eastmoney' | 'sina' | 'naver' | 'yahoo-jp';

export interface MonitorFlash extends NewsLike {
  source: FlashSourceId;
  /** HH:mm（供展示） */
  /** 用于合并去重的正文指纹 */
  fingerprint?: string;
}

export interface SourceResult {
  id: string;
  label: string;
  ok: boolean;
  count: number;
  error?: string;
  /** 是否被限流保护跳过（不是真的失败） */
  skipped?: boolean;
}

export interface FlashBundle {
  flashes: MonitorFlash[];
  results: SourceResult[];
  used: FlashSourceId[];
}

export interface QuoteBundle {
  quotes: Quote[];
  results: SourceResult[];
  /** 主源是否可用 */
  primaryOk: boolean;
}

type RawRoll = Parameters<typeof parseFlashes>[0][number];

export const FLASH_SOURCE_LABEL: Record<FlashSourceId, string> = {
  cls: '财联社电报',
  sina: '新浪 7×24',
  em: '东财快讯'
};

export const QUOTE_SOURCE_LABEL: Record<QuoteSourceId, string> = {
  tencent: '腾讯行情',
  eastmoney: '东方财富',
  sina: '新浪行情',
  naver: 'Naver',
  'yahoo-jp': 'Yahoo JP'
};

const CURRENCY: Record<string, string> = { CN: '元', HK: '港元', US: '美元', JP: '日元', KR: '韩元' };
const MARKET_LABEL: Record<string, string> = { CN: 'A股', HK: '港股', US: '美股', JP: '日股', KR: '韩股' };

const str = (v: unknown): string => String(v ?? '');
const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
};
const hhmm = (s: string): string => {
  const m = /(\d{1,2}):(\d{2})/.exec(str(s));
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : '';
};
const cleanText = (s: string): string =>
  str(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

/** 正文指纹：同一条消息常被多个源转载，用前 24 个汉字去重 */
export function flashFingerprint(text: string): string {
  return cleanText(text).replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '').slice(0, 24);
}

function result(id: string, label: string, ok: boolean, count: number, error?: unknown, skipped = false): SourceResult {
  return {
    id,
    label,
    ok,
    count,
    skipped,
    error: error == null ? undefined : error instanceof Error ? error.message : String(error).slice(0, 90)
  };
}

/* ============ 快讯：三个源 ============ */

/** 财联社（复用签名与解析，但走限流守护的请求） */
async function fetchCls(): Promise<MonitorFlash[]> {
  const params: Record<string, string> = {
    app: 'CailianpressWeb', category: '', last_time: '', os: 'web',
    refresh_type: '1', rn: '50', sv: '8.4.6'
  };
  const qs = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const sign = await clsSign(params);
  const json = await guardedJson<{ errno?: string | number; msg?: string; data?: { roll_data?: RawRoll[] } }>(
    'www.cls.cn', `/v1/roll/get_roll_list?${qs}&sign=${sign}`
  );
  if (String(json.errno) !== '0') throw new Error(json.msg || '财联社返回错误');
  const list = parseFlashes(json.data?.roll_data ?? []);
  if (!list.length) throw new Error('财联社快讯为空');
  return list.map((n) => ({ ...n, source: 'cls' as const, fingerprint: flashFingerprint(n.text) }));
}

/** 新浪财经 7×24 直播 */
async function fetchSina(): Promise<MonitorFlash[]> {
  const path = '/api/zhibo/feed?page=1&page_size=30&zhibo_id=152&tag_id=0&dire=f&dpc=1';
  const json = await guardedJson<{
    result?: { data?: { feed?: { list?: { id: number; rich_text?: string; text?: string; create_time?: string }[] } } };
  }>('zhibo.sina.com.cn', path, { Referer: 'https://finance.sina.com.cn/7x24/' });
  const rows = json.result?.data?.feed?.list ?? [];
  if (!rows.length) throw new Error('新浪 7×24 为空');
  return rows.map((r) => {
    const text = cleanText(r.rich_text ?? r.text ?? '');
    return {
      id: `sina:${r.id}`,
      text,
      level: 'B',
      read: 0,
      time: hhmm(str(r.create_time)),
      subjects: [],
      source: 'sina' as const,
      fingerprint: flashFingerprint(text)
    } satisfies MonitorFlash;
  }).filter((f) => f.text.length > 4);
}

/** 东财 7×24 快讯（必须带 req_trace，否则返回参数缺失） */
async function fetchEm(): Promise<MonitorFlash[]> {
  const path =
    `/comm/web/getNewsByColumns?client=web&biz=web_news_col&column=347&order=1` +
    `&needjump=false&pageindex=1&pagesize=30&req_trace=${Date.now()}`;
  const json = await guardedJson<{
    code?: string; message?: string;
    data?: { list?: { code?: string; title?: string; summary?: string; showTime?: string }[] };
  }>('np-listapi.eastmoney.com', path, { Referer: 'https://kuaixun.eastmoney.com/' });
  const rows = json.data?.list ?? [];
  if (!rows.length) throw new Error(json.message || '东财快讯为空');
  return rows.map((r) => {
    const text = cleanText(r.title ?? r.summary ?? '');
    return {
      id: `em:${r.code ?? text.slice(0, 12)}`,
      text,
      level: 'B',
      read: 0,
      time: hhmm(str(r.showTime)),
      subjects: [],
      source: 'em' as const,
      fingerprint: flashFingerprint(text)
    } satisfies MonitorFlash;
  }).filter((f) => f.text.length > 4);
}

const FLASH_FETCHERS: Record<FlashSourceId, () => Promise<MonitorFlash[]>> = {
  cls: fetchCls,
  sina: fetchSina,
  em: fetchEm
};

/** 合并去重：同一指纹只留一条，优先财联社（它有官方 A/B/C 重要度） */
export function mergeFlashes(lists: MonitorFlash[][]): MonitorFlash[] {
  const rank: Record<FlashSourceId, number> = { cls: 3, em: 2, sina: 1 };
  const map = new Map<string, MonitorFlash>();
  for (const list of lists) {
    for (const f of list) {
      const key = f.fingerprint || flashFingerprint(f.text);
      const old = map.get(key);
      if (!old || rank[f.source] > rank[old.source]) map.set(key, f);
    }
  }
  return [...map.values()].slice(0, 60);
}

export type FlashStrategy = 'primary' | 'rotate' | 'all';

/**
 * 拉取快讯。
 *  - primary（默认）：主源财联社，失败才切备源；每 crossEvery 轮额外拉一个备源做补充
 *  - rotate：每轮只拉一个源并按轮次轮换，总请求数仍是 1
 *  - all：三源齐发（请求 ×3，仅当用户明确要求；页面会提示风险）
 */
export async function fetchFlashesMulti(
  strategy: FlashStrategy,
  round: number,
  crossEvery = 6
): Promise<FlashBundle> {
  const results: SourceResult[] = [];
  const lists: MonitorFlash[][] = [];
  const used: FlashSourceId[] = [];
  const order: FlashSourceId[] = ['cls', 'sina', 'em'];

  const pull = async (id: FlashSourceId): Promise<boolean> => {
    used.push(id);
    try {
      const list = await FLASH_FETCHERS[id]();
      lists.push(list);
      results.push(result(id, FLASH_SOURCE_LABEL[id], true, list.length));
      return true;
    } catch (e) {
      results.push(result(id, FLASH_SOURCE_LABEL[id], false, 0, e, e instanceof BudgetSkipped));
      return false;
    }
  };

  if (strategy === 'all') {
    await Promise.all(order.map((id) => pull(id)));
  } else if (strategy === 'rotate') {
    const primary = order[round % order.length];
    if (!(await pull(primary))) {
      for (const alt of order.filter((x) => x !== primary)) if (await pull(alt)) break;
    }
  } else {
    const ok = await pull('cls');
    if (!ok) {
      for (const alt of ['sina', 'em'] as FlashSourceId[]) if (await pull(alt)) break;
    } else if (crossEvery > 0 && round > 0 && round % crossEvery === 0) {
      // 低频交叉：约每 6 轮补一次另一个源，覆盖财联社没收录的盘面播报
      const alt = (['sina', 'em'] as FlashSourceId[])[Math.floor(round / crossEvery) % 2];
      await pull(alt);
    }
  }

  return { flashes: mergeFlashes(lists), results, used };
}

/* ============ 行情：按市场多源 ============ */

/** 腾讯：五市场一次拿全（主源） */
async function quotesTencent(codes: string[]): Promise<Quote[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < codes.length; i += 40) chunks.push(codes.slice(i, i + 40));
  const lists = await Promise.all(
    chunks.map(async (part) => {
      const txt = await guardedGbk('qt.gtimg.cn', `/q=${part.join(',')}`);
      return parseTencentQuotes(txt, part).map((q) => ({ ...q, source: 'tencent' }));
    })
  );
  return lists.flat();
}

/** 东财：A 股 / 港股 / 美股批量 */
async function quotesEastmoney(codes: string[]): Promise<Quote[]> {
  const pairs = codes
    .map((c) => ({ code: c, secid: emSecidOf(c, marketOfCode(c) ?? '') }))
    .filter((x): x is { code: string; secid: string } => !!x.secid);
  if (!pairs.length) return [];
  const fields = 'f2,f3,f5,f12,f13,f14,f124';
  const json = await guardedJson<{ data?: { diff?: Record<string, unknown>[] } }>(
    'push2.eastmoney.com',
    `/api/qt/ulist.np/get?fltt=2&secids=${pairs.map((p) => p.secid).join(',')}&fields=${fields}`
  );
  const rows = json.data?.diff ?? [];
  if (!rows.length) throw new Error('东财行情为空');
  return rows.map((r, i) => {
    const p = pairs[i] ?? pairs[0];
    const market = marketOfCode(p.code) ?? 'CN';
    return {
      code: p.code,
      name: str(r.f14) || p.code,
      price: num(r.f2),
      prevClose: 0,
      chgPct: Math.round(num(r.f3) * 100) / 100,
      high: 0,
      low: 0,
      volume: num(r.f5),
      time: new Date(num(r.f124) * 1000).toISOString().slice(0, 19).replace('T', ' '),
      currency: CURRENCY[market],
      market,
      source: 'eastmoney'
    } satisfies Quote;
  }).filter((q) => q.price > 0);
}

/** 新浪：A 股 / 港股 / 美股（GBK，三个市场的字段布局不同） */
export function parseSinaQuotes(text: string, codes: string[]): Quote[] {
  const byVar = new Map<string, string[]>();
  for (const line of str(text).split(/[\r\n;]+/)) {
    const m = /hq_str_([A-Za-z0-9._]+)\s*=\s*"([^"]*)"/.exec(line);
    if (m) byVar.set(m[1], m[2].split(','));
  }
  const out: Quote[] = [];
  for (const code of codes) {
    const market = marketOfCode(code);
    if (!market || !['CN', 'HK', 'US'].includes(market)) continue;
    const varName = market === 'CN' ? code : market === 'HK' ? `rt_hk${code.slice(2)}` : `gb_${code.slice(2).toLowerCase()}`;
    const a = byVar.get(varName);
    if (!a) continue;
    let price = 0, prevClose = 0, chgPct = 0, high = 0, low = 0, volume = 0, name = '';
    let time = '';
    if (market === 'CN' && a.length >= 32) {
      name = a[0]; prevClose = num(a[2]); price = num(a[3]); high = num(a[4]); low = num(a[5]);
      volume = num(a[8]); time = `${a[30]} ${a[31]}`;
      chgPct = prevClose > 0 ? Math.round(((price - prevClose) / prevClose) * 10000) / 100 : 0;
    } else if (market === 'HK' && a.length >= 9) {
      name = a[1]; prevClose = num(a[3]); high = num(a[4]); low = num(a[5]);
      price = num(a[6]); chgPct = Math.round(num(a[8]) * 100) / 100; volume = num(a[12]); time = `${a[17]} ${a[18]}`;
    } else if (market === 'US' && a.length >= 8) {
      name = a[0]; price = num(a[1]); chgPct = Math.round(num(a[2]) * 100) / 100; time = a[3];
      prevClose = num(a[26]) || price - num(a[4]); high = num(a[6]); low = num(a[7]);
    }
    if (!(price > 0)) continue;
    out.push({ code, name, price, prevClose, chgPct, high, low, volume, time, currency: CURRENCY[market], market, source: 'sina' });
  }
  return out;
}

async function quotesSina(codes: string[]): Promise<Quote[]> {
  const vars = codes.map((c) => {
    const m = marketOfCode(c);
    if (m === 'CN') return c;
    if (m === 'HK') return `rt_hk${c.slice(2)}`;
    if (m === 'US') return `gb_${c.slice(2).toLowerCase()}`;
    return '';
  }).filter(Boolean);
  if (!vars.length) return [];
  const txt = await guardedGbk('hq.sinajs.cn', `/list=${vars.join(',')}`, { Referer: 'https://finance.sina.com.cn/' });
  return parseSinaQuotes(txt, codes);
}

/** Naver：韩股单只（腾讯失效时兜底） */
async function quoteNaver(code: string): Promise<Quote | null> {
  const ticker = code.replace(/^kr/i, '');
  const json = await guardedJson<{
    closePrice?: string; fluctuationsRatio?: string; stockName?: string; localTradedAt?: string;
  }>('m.stock.naver.com', `/api/stock/${ticker}/basic`, { Referer: 'https://m.stock.naver.com/' });
  const price = num(json.closePrice);
  if (!(price > 0)) return null;
  return {
    code,
    name: str(json.stockName) || code,
    price,
    prevClose: 0,
    chgPct: Math.round(num(json.fluctuationsRatio) * 100) / 100,
    high: 0,
    low: 0,
    volume: 0,
    time: str(json.localTradedAt).slice(0, 19).replace('T', ' '),
    currency: CURRENCY.KR,
    market: 'KR',
    source: 'naver'
  };
}

/** Yahoo JP 报价页（HTML，只在腾讯失效时用；类名 hash 化，用结构特征取值） */
export function parseYahooJpPrice(html: string, code: string): Quote | null {
  const i = html.indexOf('_BasePriceBoard__main');
  if (i < 0) return null;
  const seg = html.slice(i, i + 12_000);
  // 股票代码 span 是纯 4 位数字，价格带千分位逗号，只取带逗号的第一个数
  const m = />\s*([\d]{1,3}(?:,\d{3})+(?:\.\d+)?)\s*</.exec(seg);
  if (!m) return null;
  const price = num(m[1]);
  if (!(price > 0)) return null;
  // 涨跌幅形如 -6.06％ / +1.23%
  const p = /([+-]?\d+(?:\.\d+)?)\s*[%％]/.exec(seg);
  return {
    code,
    name: code,
    price,
    prevClose: 0,
    chgPct: p ? Math.round(num(p[1]) * 100) / 100 : 0,
    high: 0,
    low: 0,
    volume: 0,
    time: '',
    currency: CURRENCY.JP,
    market: 'JP',
    source: 'yahoo-jp'
  };
}

async function quoteYahooJp(code: string): Promise<Quote | null> {
  const ticker = code.replace(/^jp/i, '').replace(/0$/, '');
  const res = await guardedFetchHtml('finance.yahoo.co.jp', `/quote/${ticker}.T`);
  return parseYahooJpPrice(res, code);
}

async function guardedFetchHtml(host: string, path: string): Promise<string> {
  const res = await guardedFetch(host, path, { headers: { Accept: 'text/html' } });
  return res.text();
}

/** 按 code 合并：主源优先；备源只补主源没有的，或补主源缺失的字段 */
export function mergeQuotes(primary: Quote[], fallbacks: Quote[]): Quote[] {
  const map = new Map(primary.map((q) => [q.code, q]));
  for (const q of fallbacks) {
    const old = map.get(q.code);
    if (!old) {
      map.set(q.code, q);
      continue;
    }
    // 主源缺高低/昨收时用备源补，价格本身不动（避免多源微小价差造成假跳变）
    map.set(q.code, {
      ...old,
      prevClose: old.prevClose || q.prevClose,
      high: old.high || q.high,
      low: old.low || q.low,
      volume: old.volume || q.volume
    });
  }
  return [...map.values()];
}

/**
 * 多源行情入口。
 *  - 腾讯失败/被限流 → 东财 + 新浪补齐 A/港/美，Naver 补韩，Yahoo JP 补日
 *  - 腾讯成功且到达 verifyEvery 轮 → 低频用东财交叉验证（只发 1 个请求）
 */
export async function fetchQuotesMulti(
  codes: string[],
  round: number,
  verifyEvery = 10
): Promise<QuoteBundle> {
  const results: SourceResult[] = [];
  let primary: Quote[] = [];
  let primaryOk = false;

  try {
    primary = await quotesTencent(codes);
    if (!primary.length) throw new Error('腾讯行情为空');
    primaryOk = true;
    results.push(result('tencent', QUOTE_SOURCE_LABEL.tencent, true, primary.length));
  } catch (e) {
    results.push(result('tencent', QUOTE_SOURCE_LABEL.tencent, false, 0, e, e instanceof BudgetSkipped));
  }

  const fallbacks: Quote[] = [];
  const needFallback = !primaryOk;
  const verify = primaryOk && verifyEvery > 0 && round > 0 && round % verifyEvery === 0;

  if (needFallback || verify) {
    for (const [id, label, fn] of [
      ['eastmoney', QUOTE_SOURCE_LABEL.eastmoney, quotesEastmoney],
      ['sina', QUOTE_SOURCE_LABEL.sina, quotesSina]
    ] as const) {
      try {
        const list = await fn(codes);
        fallbacks.push(...(needFallback ? list : []));
        results.push(result(id, label, true, list.length));
      } catch (e) {
        results.push(result(id, label, false, 0, e, e instanceof BudgetSkipped));
      }
      if (verify) break; // 交叉验证只用一个备源，控制请求量
    }

    // 日韩只有腾讯覆盖；主源失效时按市场单独兜底
    if (needFallback) {
      for (const code of codes.filter((c) => marketOfCode(c) === 'KR')) {
        try {
          const q = await quoteNaver(code);
          if (q) fallbacks.push(q);
          results.push(result('naver', QUOTE_SOURCE_LABEL.naver, !!q, q ? 1 : 0));
        } catch (e) {
          results.push(result('naver', QUOTE_SOURCE_LABEL.naver, false, 0, e, e instanceof BudgetSkipped));
        }
      }
      for (const code of codes.filter((c) => marketOfCode(c) === 'JP')) {
        try {
          const q = await quoteYahooJp(code);
          if (q) fallbacks.push(q);
          results.push(result('yahoo-jp', QUOTE_SOURCE_LABEL['yahoo-jp'], !!q, q ? 1 : 0));
        } catch (e) {
          results.push(result('yahoo-jp', QUOTE_SOURCE_LABEL['yahoo-jp'], false, 0, e, e instanceof BudgetSkipped));
        }
      }
    }
  }

  return { quotes: mergeQuotes(primary, fallbacks), results, primaryOk };
}

/* ============ 公告：前置熔断（适配器内部用自己的 fetch） ============ */

/** 公告 host（按市场） */
export function announcementHost(code: string): string {
  const m = marketOfCode(code);
  if (m === 'CN' || m === 'HK') return 'np-anotice-stock.eastmoney.com';
  if (m === 'US') return 'data.sec.gov';
  if (m === 'JP') return 'finance.yahoo.co.jp';
  if (m === 'KR') return 'api.stock.naver.com';
  return 'stockanalysis.com';
}

export function canFetchAnnouncement(code: string): boolean {
  return canRequest(announcementHost(code));
}

export function noteAnnouncement(code: string, ok: boolean, error?: unknown, latencyMs = 0): void {
  const host = announcementHost(code);
  if (ok) noteSuccess(host, latencyMs);
  else noteFailure(host, error ?? '公告请求失败');
}

/** 供页面展示的健康快照 */
export function sourceHealth(): { stats: HostStat[]; labels: Record<string, string> } {
  return {
    stats: getStats(),
    labels: {
      'qt.gtimg.cn': '腾讯行情',
      'push2.eastmoney.com': '东财行情',
      'hq.sinajs.cn': '新浪行情',
      'www.cls.cn': '财联社快讯',
      'zhibo.sina.com.cn': '新浪 7×24',
      'np-listapi.eastmoney.com': '东财快讯',
      'm.stock.naver.com': 'Naver 韩股',
      'api.stock.naver.com': 'Naver 新闻',
      'finance.yahoo.co.jp': 'Yahoo JP',
      'np-anotice-stock.eastmoney.com': '东财公告',
      'data.sec.gov': 'SEC EDGAR',
      'stockanalysis.com': 'StockAnalysis'
    }
  };
}

export { MARKET_LABEL };
