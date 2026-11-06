/**
 * 个股消息面：按市场路由到对应适配器
 *
 *   A 股 / 港股 → 东财公告库（同一个接口，ann_type 不同）
 *   美股        → SEC EDGAR
 *   日股 / 韩股 → 暂不支持（方案见 docs/个股消息面-多市场方案.md）
 *
 * 对外只暴露 ensureAnnouncements，页面层不关心底层是哪个源；
 * 任何源失败都抛错，由页面显式降级——绝不拿别的市场数据凑数。
 */
import type { AnnInput, AnnMarket } from '../../math/stockNews';
import { fetchEmAnnouncements } from './em';
import { fetchSecFilings } from './sec';
import { fetchJpDisclosure } from './jp';
import { fetchNaverNews } from './kr';

export type { AnnMarket };

export interface FetchAnnResult {
  list: AnnInput[];
  total: number;
  /** 数据源自带的股票简称（深链进来时 picked.name 可能只是代码） */
  name?: string;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_KEY = (code: string) => `mq:ann:v3:${code}`;

/* ============ 代码工具 ============ */

/** 指数没有公告：sh000xxx（上证系列）、sz399xxx（深证系列）、bj899xxx（北证指数） */
export function isIndexCode(code: string): boolean {
  return /^(sh000|sz399|bj899)/i.test(String(code ?? '').trim());
}

/** 从代码判断市场；不支持的市场返回 null */
export function marketOf(code: string): AnnMarket | null {
  const c = String(code ?? '').trim();
  if (/^(sh|sz|bj)\d{6}$/i.test(c)) return isIndexCode(c) ? null : 'CN';
  if (/^hk\d{5}$/i.test(c)) return 'HK';
  if (/^us[A-Za-z][A-Za-z.-]*$/.test(c)) return 'US';
  if (/^jp\d{4,5}$/i.test(c)) return 'JP';
  if (/^kr\d{6}$/i.test(c)) return 'KR';
  return null;
}

/** 是否支持查消息面 */
export function canFetchAnn(code: string): boolean {
  return marketOf(code) !== null;
}

/** A 股 6 位代码（保留给旧调用）；非 A 股返回 null */
export function toAnnCode(code: string): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/i.exec(String(code ?? '').trim());
  return m ? m[2] : null;
}

/* ============ 缓存 ============ */

interface Cached {
  ts: number;
  data: FetchAnnResult;
}

function loadCache(code: string): FetchAnnResult | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY(code));
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!c?.data || !Array.isArray(c.data.list) || !c.data.list.length) return null;
    if (Date.now() - c.ts > CACHE_TTL_MS) return null;
    return c.data;
  } catch {
    return null;
  }
}

function saveCache(code: string, data: FetchAnnResult): void {
  try {
    localStorage.setItem(CACHE_KEY(code), JSON.stringify({ ts: Date.now(), data } satisfies Cached));
  } catch {
    /* 忽略配额 */
  }
}

/* ============ 路由 ============ */

const inflight = new Map<string, Promise<FetchAnnResult>>();

export function ensureAnnouncements(code: string, force = false): Promise<FetchAnnResult> {
  const key = String(code ?? '');
  const running = inflight.get(key);
  if (running && !force) return running;

  const p = (async () => {
    const market = marketOf(key);
    if (!market) throw new Error('该市场暂无消息面数据源（当前支持 A 股 / 港股 / 美股 / 日股 / 韩股）');

    if (!force) {
      const cached = loadCache(key);
      if (cached) return cached;
    }

    const data =
      market === 'US'
        ? await fetchSecFilings(key)
        : market === 'JP'
          ? await fetchJpDisclosure(key)
          : market === 'KR'
            ? await fetchNaverNews(key)
            : await fetchEmAnnouncements(key, market as 'CN' | 'HK');

    saveCache(key, data);
    return data;
  })().finally(() => inflight.delete(key));

  inflight.set(key, p);
  return p;
}
