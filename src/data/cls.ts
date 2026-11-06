/**
 * 财联社电报（消息面）
 *
 * 财联社的接口需要 `sign` 参数，算法是：
 *   sign = MD5( SHA1( 按 key 升序拼接的 query string ) )
 *
 * SHA-1 可以用 Web Crypto（crypto.subtle），但 **Web Crypto 不提供 MD5**，
 * 所以这里自带一份紧凑的 MD5 实现（纯函数，可用已知向量校验）。
 *
 * 消息面与论坛讨论的区别：
 *  - 论坛帖是「散户怎么想」，噪声大、滞后于价格；
 *  - 快讯是「发生了什么」，措辞更规范（获批/中标/减持/立案），更适合词典打分。
 * 两者分开呈现，不混在同一个多空比里。
 */
import { px } from './sources/proxy';
import { scoreTitle } from '../math/buzz';

const HOST = 'www.cls.cn';
const CACHE_KEY = 'mq:cls:v1';
const CACHE_TTL_MS = 10 * 60 * 1000;

/* ============ MD5（Web Crypto 不提供） ============ */

const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

/** 标准 MD5，输入按 UTF-8 处理，输出 32 位小写十六进制 */
export function md5Hex(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  const len = utf8.length;
  const bitLen = len * 8;
  const buf = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  buf.set(utf8);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, bitLen >>> 0, true);
  dv.setUint32(buf.length - 4, Math.floor(bitLen / 4294967296), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const K = new Int32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  const M = new Int32Array(16);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
    let A = a0;
    let B = b0;
    let C = c0;
    let D = d0;

    for (let i = 0; i < 64; i++) {
      let F: number;
      let g: number;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      const tmp = D;
      D = C;
      C = B;
      const sum = (A + F + K[i] + M[g]) | 0;
      const sh = S[(i >> 4) * 4 + (i % 4)];
      B = (B + ((sum << sh) | (sum >>> (32 - sh)))) | 0;
      A = tmp;
    }

    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new DataView(new ArrayBuffer(16));
  out.setInt32(0, a0, true);
  out.setInt32(4, b0, true);
  out.setInt32(8, c0, true);
  out.setInt32(12, d0, true);
  let hex = '';
  for (let i = 0; i < 16; i++) hex += out.getUint8(i).toString(16).padStart(2, '0');
  return hex;
}

async function sha1Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 财联社签名：MD5(SHA1(排序后的 query)) */
export async function clsSign(params: Record<string, string>): Promise<string> {
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  return md5Hex(await sha1Hex(qs));
}

/* ============ 类型 ============ */

export interface NewsFlash {
  id: string;
  /** 去掉「财联社11月2日电，」前缀后的正文 */
  text: string;
  /** 重要度 A/B/C（A 最重要） */
  level: string;
  read: number;
  /** HH:mm */
  time: string;
  subjects: string[];
  /** 词典判定的多空 */
  tone: 1 | 0 | -1;
}

/* ============ 抓取 ============ */

interface RawRoll {
  id?: number;
  title?: string;
  brief?: string;
  content?: string;
  level?: string;
  reading_num?: number;
  ctime?: number;
  subjects?: { subject_name?: string }[];
}

/** 去掉快讯模板前缀：「财联社11月2日电，」「财联社11月2日讯，」 */
function stripLead(s: string): string {
  return s.replace(/^财联社\s*\d{1,2}月\d{1,2}日(电|讯)[，,]?\s*/, '').trim();
}

function hhmm(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function parseFlashes(rows: RawRoll[]): NewsFlash[] {
  return rows
    .map((r) => {
      const raw = String(r.content || r.brief || r.title || '');
      const text = stripLead(raw);
      if (!text) return null;
      const s = scoreTitle(text);
      return {
        id: String(r.id ?? ''),
        text,
        level: String(r.level ?? 'C'),
        read: Number(r.reading_num ?? 0),
        time: r.ctime ? hhmm(r.ctime) : '',
        subjects: (r.subjects ?? []).map((x) => String(x.subject_name ?? '')).filter(Boolean),
        tone: s.tone
      } as NewsFlash;
    })
    .filter((x): x is NewsFlash => !!x);
}

interface ClsResp {
  errno?: number | string;
  msg?: string;
  data?: { roll_data?: RawRoll[] };
}

export async function fetchClsNews(rn = 40): Promise<NewsFlash[]> {
  const params: Record<string, string> = {
    app: 'CailianpressWeb',
    category: '',
    last_time: '',
    os: 'web',
    refresh_type: '1',
    rn: String(rn),
    sv: '8.4.6'
  };
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const sign = await clsSign(params);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let json: ClsResp;
  try {
    const res = await fetch(px(HOST, `/v1/roll/get_roll_list?${qs}&sign=${sign}`), {
      signal: ctrl.signal,
      headers: { Accept: '*/*' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = (await res.json()) as ClsResp;
  } finally {
    clearTimeout(timer);
  }

  if (String(json.errno) !== '0') throw new Error(json.msg || '财联社返回错误');
  const rows = json.data?.roll_data ?? [];
  const list = parseFlashes(rows);
  if (!list.length) throw new Error('财联社快讯为空');
  return list;
}

/* ============ 缓存 ============ */

interface Cached {
  ts: number;
  list: NewsFlash[];
}

export function loadNewsCache(): NewsFlash[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!Array.isArray(c?.list) || Date.now() - c.ts > CACHE_TTL_MS) return null;
    return c.list;
  } catch {
    return null;
  }
}

export function saveNewsCache(list: NewsFlash[]): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), list } satisfies Cached));
  } catch {
    /* 忽略配额 */
  }
}

export function clearNewsCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}
