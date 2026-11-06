/**
 * 新浪财经 F10 · 十大流通股东（备用源）
 *
 * 东财 F10 的 PageAjax 是 JSON，新浪这边只有 HTML（GBK 编码），因此需要：
 *  1. 取 arrayBuffer → TextDecoder('gbk') 解码；
 *  2. 按「截止日期」切块，取最新一期；
 *  3. 逐 <tr> 抽 <td>，得到 序号 / 股东名称 / 持股数 / 占流通股比例 / 股本性质。
 *
 * 该源不提供股东户数，也不提供全量机构持仓，只用于东财 F10 不可用时兜底
 * 「十大流通股东」这一块（结构 + 集中度）。
 */
import { isBrowser, px } from './proxy';

const HOST = 'vip.stock.finance.sina.com.cn';

export interface SinaTopHolder {
  name: string;
  /** 持股数（股） */
  shares: number;
  /** 占流通股比例（%） */
  ratio: number;
  /** 股本性质：国有股 / 境外法人股 / 境内法人股 / 自然人 等 */
  nature: string;
}

export interface SinaHolderBlock {
  /** 报告期 YYYY-MM-DD */
  date: string;
  holders: SinaTopHolder[];
}

/** 去掉标签、压缩空白 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

const num = (s: string): number => {
  const v = Number(String(s).replace(/[,%\s]/g, ''));
  return Number.isFinite(v) ? v : 0;
};

/**
 * 解析新浪「十大流通股东」页面。
 * 纯函数，便于单测：传入已解码的 HTML 文本，返回按日期分块的结果。
 */
export function parseSinaTopHolders(html: string): SinaHolderBlock[] {
  const blocks: SinaHolderBlock[] = [];
  // 每个报告期以 <strong>截止日期</div></td> <td ...>2026-06-30</td> 开头
  const dateRe = /截止日期[\s\S]{0,160}?(\d{4}-\d{2}-\d{2})/g;
  const marks: { date: string; at: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = dateRe.exec(html))) marks.push({ date: m[1], at: m.index });
  if (!marks.length) return blocks;

  for (let i = 0; i < marks.length; i++) {
    const start = marks[i].at;
    const end = i + 1 < marks.length ? marks[i + 1].at : html.length;
    const chunk = html.slice(start, end);
    const headIdx = chunk.indexOf('股东名称');
    if (headIdx < 0) continue;
    const body = chunk.slice(headIdx);

    const holders: SinaTopHolder[] = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(body))) {
      const cells = [...r[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => textOf(c[1]));
      if (cells.length < 4) continue;
      // 序号必须是数字，否则是表头/合计行
      if (!/^\d+$/.test(cells[0])) continue;
      const name = cells[1];
      if (!name) continue;
      holders.push({
        name,
        shares: num(cells[2]),
        ratio: num(cells[3]),
        nature: cells[4] ?? ''
      });
      if (holders.length >= 10) break;
    }
    if (holders.length) blocks.push({ date: marks[i].date, holders });
  }
  return blocks;
}

/** 取新浪十大流通股东（最新一期）；浏览器走本地代理（该站不返回 CORS 头） */
export async function fetchSinaTopHolders(code: string): Promise<SinaHolderBlock | null> {
  const bare = code.replace(/^(sh|sz|bj)/, '');
  const path = `/corp/go.php/vCI_CirculateStockHolder/stockid/${bare}.phtml`;
  const list = isBrowser ? [px(HOST, path), `https://${HOST}${path}`] : [`https://${HOST}${path}`];

  let lastErr: unknown = null;
  for (const url of list) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`sina http ${res.status}`);
      const buf = await res.arrayBuffer();
      const text = new TextDecoder('gbk').decode(buf);
      if (!text.includes('流通股股东')) throw new Error('sina unexpected page');
      const blocks = parseSinaTopHolders(text);
      if (!blocks.length) throw new Error('sina no holders');
      return blocks[0];
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('sina unavailable');
}
