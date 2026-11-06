/**
 * 韩股：Naver 证券新闻（没有免费公告源）
 *
 * 现实：DART（전자공시）是官方公告库，但要申请 API key；
 * 交易所 KIND 有验证码。所以一期只能拿新闻：
 *   https://api.stock.naver.com/news/stock/005930?pageSize=40&page=1
 *   返回结构是「每条新闻一个 bucket」的数组：[{ total: 1, items: [ {...} ] }, ...]
 *
 * 必须说清楚的性质差异：
 *  - 这是**媒体新闻**，不是公司披露，标题里出现「자사주 매입（回购）」
 *    多半是记者解读，不是公司公告；
 *  - 所以面板叫「新闻」而不是「公告」，方向只做提示，不并入多空比。
 */
import { px } from '../sources/proxy';
import type { AnnInput } from '../../math/stockNews';

const HOST = 'api.stock.naver.com';

export interface KrFetch {
  list: AnnInput[];
  total: number;
  name?: string;
}

/** kr005930 → 005930 */
export function naverCode(code: string): string | null {
  const m = /^kr(\d{6})$/i.exec(String(code ?? '').trim());
  return m ? m[1] : null;
}

interface NaverNews {
  id?: string;
  officeId?: string;
  articleId?: string;
  officeName?: string;
  datetime?: string;
  title?: string;
  body?: string;
}

/** "202611031121" → "2026-11-03" */
function parseDate(dt: string): string {
  const s = String(dt ?? '');
  if (s.length < 8) return '';
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 去掉标题里的 HTML 实体与标签（Naver 偶尔带 <b>） */
function cleanTitle(raw: string): string {
  return String(raw ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function fetchNaverNews(code: string, size = 40): Promise<KrFetch> {
  const c = naverCode(code);
  if (!c) throw new Error('韩股代码格式不支持');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  let json: { total?: number; items?: NaverNews[] }[] | { total?: number; items?: NaverNews[] };
  try {
    const res = await fetch(px(HOST, `/news/stock/${c}?pageSize=${size}&page=1`), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Naver 新闻 HTTP ${res.status}`);
    json = (await res.json()) as { total?: number; items?: NaverNews[] }[] | { total?: number; items?: NaverNews[] };
  } finally {
    clearTimeout(timer);
  }

  // 接口返回「每条新闻一个 bucket」的数组，要展平；只取第一个 bucket 会只剩 1 条
  const buckets = Array.isArray(json) ? json : [json];
  const items = buckets.flatMap((b) => b?.items ?? []);

  const list: AnnInput[] = items
    .map((it, i) => {
      const title = cleanTitle(it.title ?? '');
      if (!title) return null;
      const office = String(it.officeName ?? '').trim();
      const officeId = String(it.officeId ?? '');
      const articleId = String(it.articleId ?? '');
      return {
        id: `KR:${it.id ?? `${officeId}-${articleId}-${i}`}`,
        title,
        date: parseDate(String(it.datetime ?? '')),
        column: office || undefined,
        url: officeId && articleId ? `https://n.news.naver.com/mnews/article/${officeId}/${articleId}` : undefined,
        market: 'KR',
        kind: 'NaverNews'
      } as AnnInput;
    })
    .filter((x): x is AnnInput => !!x);

  if (!list.length) throw new Error('该标的近期无新闻');
  return { list, total: list.length };
}
