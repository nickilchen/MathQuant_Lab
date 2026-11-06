/**
 * 东财公告适配器（A 股 + 港股）
 *
 * 两个市场用同一个接口，只有两个参数不同：
 *   ann_type: A → H
 *   stock_list: 600519 → 00700
 *
 * 港股公告的 column_name 是繁体（「債務證券發行通函」），标签层会先做繁简归一。
 */
import { px } from '../sources/proxy';
import type { AnnInput } from '../../math/stockNews';

const HOST = 'np-anotice-stock.eastmoney.com';

interface RawAnn {
  art_code?: string;
  title?: string;
  title_ch?: string;
  notice_date?: string;
  columns?: { column_name?: string }[];
  codes?: { short_name?: string; stock_code?: string }[];
}

interface AnnResp {
  success?: number;
  data?: { list?: RawAnn[]; total_hits?: number };
}

export interface EmFetch {
  list: AnnInput[];
  total: number;
  name?: string;
}

/** sh600519 → 600519；hk00700 → 00700 */
export function emStockId(code: string): string {
  return String(code ?? '').trim().replace(/^(sh|sz|bj|hk)/i, '');
}

export async function fetchEmAnnouncements(code: string, market: 'CN' | 'HK', size = 40): Promise<EmFetch> {
  const c = emStockId(code);
  if (!c) throw new Error('代码为空');

  const annType = market === 'HK' ? 'H' : 'A';
  const path = `/api/security/ann?sr=-1&page_size=${size}&page_index=1&ann_type=${annType}&client_source=web&stock_list=${c}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let json: AnnResp;
  try {
    const res = await fetch(px(HOST, path), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = (await res.json()) as AnnResp;
  } finally {
    clearTimeout(timer);
  }

  const rows = json?.data?.list ?? [];
  const stockName = rows.map((r) => String(r.codes?.[0]?.short_name ?? '').trim()).find(Boolean);

  const list: AnnInput[] = rows
    .map((r) => {
      const title = String(r.title_ch || r.title || '').trim();
      if (!title) return null;
      const art = String(r.art_code ?? '');
      return {
        id: `${market}:${art || title}`,
        title,
        date: String(r.notice_date ?? '').slice(0, 10),
        column: (r.columns ?? [])
          .map((x) => String(x.column_name ?? ''))
          .filter(Boolean)
          .join(' / '),
        url: art ? `https://data.eastmoney.com/notices/detail/${c}/${art}.html` : undefined,
        market,
        kind: market === 'HK' ? 'HKEX' : 'CNINFO'
      } as AnnInput;
    })
    .filter((x): x is AnnInput => !!x);

  if (!list.length) throw new Error('该标的近期无公告');
  return { list, total: Number(json?.data?.total_hits ?? list.length), name: stockName };
}
