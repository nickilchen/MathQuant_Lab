/**
 * 日股：Yahoo!ファイナンス「適時開示情報」
 *
 * 为什么不用 TDnet 官方列表：
 *   TDnet 的 I_list_001_YYYYMMDD.html 是**按日全量**、且一页只给 100 条（最近两小时），
 *   想按个股查只能把整天的列表翻完，还经常翻不到（丰田这种一天可能只有 1 条，排在很后面）。
 *   Yahoo 的个股適時開示页直接按代码查、覆盖数月、带 PDF 链接，更适合这个场景。
 *
 * 页面结构（Next.js 渲染，class 名是 hash 的，只能靠结构选择器）：
 *   <article><a href="https://.../disclosure/20261005/xxx.pdf">
 *     <h3>自己株式の取得状況に関するお知らせ</h3>
 *   </a></article>
 * 日期从 PDF 路径里取（/disclosure/YYYYMMDD/）。
 */
import { px } from '../sources/proxy';
import type { AnnInput } from '../../math/stockNews';

const HOST = 'finance.yahoo.co.jp';

export interface JpFetch {
  list: AnnInput[];
  total: number;
  name?: string;
}

/** jp7203 → 7203（Yahoo 用 4 位 + .T） */
export function jpCode(code: string): string | null {
  const m = /^jp(\d{4,5})$/i.exec(String(code ?? '').trim());
  if (!m) return null;
  // 5 位是 TDnet 口径（末位 0），Yahoo 要 4 位
  return m[1].length === 5 ? m[1].slice(0, 4) : m[1];
}

/** 20261005 → 2026-10-05 */
const ymdToIso = (ymd: string) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

export async function fetchJpDisclosure(code: string, size = 40): Promise<JpFetch> {
  const c = jpCode(code);
  if (!c) throw new Error('日股代码格式不支持');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 18000);
  let html: string;
  try {
    const res = await fetch(px(HOST, `/quote/${c}.T/disclosure`), {
      signal: ctrl.signal,
      headers: { Accept: 'text/html' }
    });
    if (!res.ok) throw new Error(`Yahoo 適時開示 HTTP ${res.status}`);
    html = await res.text();
  } finally {
    clearTimeout(timer);
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');

  // 公司名从 <title>「トヨタ自動車(株)【7203】：適時開示情報」里取
  const pageTitle = doc.querySelector('title')?.textContent ?? '';
  const nameMatch = /^(.+?)【\d+】/.exec(pageTitle);
  const name = nameMatch?.[1]?.trim();

  const links = Array.from(doc.querySelectorAll('a[href*="/disclosure/"]'));
  const list: AnnInput[] = [];
  const seen = new Set<string>();

  for (const a of links) {
    const title = a.querySelector('h3')?.textContent?.trim() ?? '';
    const href = a.getAttribute('href') ?? '';
    const dm = /\/disclosure\/(\d{8})\//.exec(href);
    if (!title || !dm) continue;

    const key = `${dm[1]}:${title}`;
    if (seen.has(key)) continue;
    seen.add(key);

    list.push({
      id: `JP:${key}`,
      title,
      date: ymdToIso(dm[1]),
      column: 'TDnet',
      url: href.startsWith('http') ? href : undefined,
      market: 'JP',
      kind: 'TDnet'
    });
    if (list.length >= size) break;
  }

  if (!list.length) throw new Error('该标的近期无適時開示');
  return { list, total: list.length, name };
}
