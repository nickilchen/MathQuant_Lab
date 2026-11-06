/**
 * 个股搜索：东财 suggest（覆盖 A股/港股/美股/日股/台股）+ 本地目录兜底（含韩股）
 *
 * 各市场个股的可用数据源（实测）：
 *   A股  → 腾讯（sh/sz 代码）
 *   港股  → 腾讯（hk 代码）
 *   美股  → 新浪（ticker）
 *   韩股  → Naver（六位代码，东财 suggest 不含韩国，走本地目录）
 *   日股  → Yahoo（code.T，东财 kline 拒绝 176 个股，视网络可达）
 *   台股  → Yahoo（code.TW，同上）
 */
import type { Market } from '../data/symbols';
import { SYMBOLS } from '../data/symbols';
import { isBrowser, px } from '../data/sources/proxy';

const SUGGEST_HOST = 'searchapi.eastmoney.com';

export interface StockHit {
  /** 应用内唯一键 */
  code: string;
  name: string;
  market: Market | 'TW';
  marketLabel: string;
  /** 各源代码（按可用性填写） */
  tencent?: string;
  sina?: string;
  naver?: string;
  yahoo?: string;
  secid?: string;
}

const MARKET_LABELS: Record<string, string> = {
  CN: 'A股',
  HK: '港股',
  US: '美股',
  JP: '日股',
  KR: '韩股',
  TW: '台股'
};

interface EmItem {
  Code: string;
  Name: string;
  MktNum: string;
  QuoteID: string;
  Classify: string;
  SecurityTypeName: string;
}

/** 东财 suggest 条目 → StockHit（按市场映射到可用源） */
function mapEmItem(x: EmItem): StockHit | null {
  const code = (x.Code ?? '').trim();
  const name = (x.Name ?? '').trim();
  if (!code || !name) return null;
  switch (x.Classify) {
    case 'AStock': {
      const tc = (x.MktNum === '1' ? 'sh' : 'sz') + code;
      return { code: tc, name, market: 'CN', marketLabel: MARKET_LABELS.CN, tencent: tc, sina: tc, secid: x.QuoteID };
    }
    case 'HK': {
      const tc = 'hk' + code;
      return { code: tc, name, market: 'HK', marketLabel: MARKET_LABELS.HK, tencent: tc };
    }
    case 'UsStock': {
      return { code: 'us' + code, name, market: 'US', marketLabel: MARKET_LABELS.US, sina: code, yahoo: code };
    }
    case 'JPX': {
      return { code: 'jp' + code, name, market: 'JP', marketLabel: MARKET_LABELS.JP, yahoo: code + '.T' };
    }
    case 'TWSE': {
      return { code: 'tw' + code, name, market: 'TW', marketLabel: MARKET_LABELS.TW, yahoo: code + '.TW' };
    }
    default:
      return null;
  }
}

/** 本地目录（含港股/韩股龙头、美股行业 ETF、各指数）——兜底与韩股来源 */
function localHits(q: string): StockHit[] {
  const kw = q.trim().toLowerCase();
  if (!kw) return [];
  return SYMBOLS.filter((s) => s.name.toLowerCase().includes(kw) || s.code.toLowerCase().includes(kw))
    .slice(0, 12)
    .map((s) => ({
      code: s.code,
      name: s.name,
      market: s.market,
      marketLabel: MARKET_LABELS[s.market] ?? s.market,
      tencent: /^(sh|sz|hk)/.test(s.code) ? s.code : undefined,
      sina: s.sina,
      naver: s.naver,
      yahoo: s.yahoo,
      secid: s.secid || undefined
    }));
}

/** 搜索（去重、限量）；网络失败时回退本地目录 */
export async function searchStocks(q: string, limit = 12): Promise<StockHit[]> {
  const kw = q.trim();
  if (!kw) return [];
  const path = `/api/suggest/get?input=${encodeURIComponent(kw)}&type=14&count=${limit + 4}`;
  const urls = isBrowser ? [px(SUGGEST_HOST, path), `https://${SUGGEST_HOST}${path}`] : [`https://${SUGGEST_HOST}${path}`];
  const hits: StockHit[] = [];
  const seen = new Set<string>();
  const push = (h: StockHit | null) => {
    if (!h || seen.has(h.code) || hits.length >= limit) return;
    seen.add(h.code);
    hits.push(h);
  };
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) continue;
      const j = (await res.json()) as { QuotationCodeTable?: { Data?: EmItem[] } };
      const arr = j?.QuotationCodeTable?.Data;
      if (!Array.isArray(arr) || arr.length === 0) continue;
      for (const item of arr) push(mapEmItem(item));
      if (hits.length > 0) break;
    } catch {
      /* 尝试下一个通道 */
    }
  }
  // 本地目录补充（韩股、以及断网时的兜底）
  for (const h of localHits(kw)) push(h);
  return hits;
}
