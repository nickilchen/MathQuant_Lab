/**
 * 全网讨论数据层（股吧 + 千股千评）
 *
 *   ┌ 股吧人气榜 ────── emappdata.eastmoney.com（POST，实时）
 *   ├ 股吧热帖 ─────── guba.eastmoney.com/list,{code}.html（HTML，需按行解析）
 *   └ 市场关注度 ───── 东财数据中心 RPT_DMSK_TS_STOCKNEW（千股千评，T-1）
 *
 * 全部为「讨论类」数据，取不到只影响讨论维度与对应面板，不影响行情与打分主体。
 * 雪球、微博需要登录态（实测雪球被 WAF 拦），同花顺无公开接口，因此只用股吧——
 * 股吧是 A 股散户讨论密度最高的公开社区，样本足够代表「全网讨论」的温度。
 */
import { px } from './sources/proxy';
import type { BuzzPostLike } from '../math/buzz';
import { fetchClsNews, loadNewsCache, saveNewsCache, type NewsFlash } from './cls';

const HOST_GUBA = 'guba.eastmoney.com';
const HOST_MGUBA = 'mguba.eastmoney.com';
const HOST_TGB = 'www.tgb.cn';
const HOST_RANK = 'emappdata.eastmoney.com';
const HOST_DC = 'datacenter-web.eastmoney.com';

const CACHE_KEY = 'mq:buzz:v3';
const CACHE_TTL_MS = 10 * 60 * 1000;

/** 抓几只最热股票的股吧：4 只 × 每页 20 条 ≈ 80 条标题，够做多空比又不至于拖慢首屏 */
const POST_STOCKS = 4;

/* ============ 类型 ============ */

export interface RawPopular {
  code: string;
  rank: number;
  rankChange: number;
}

export interface FocusRow {
  code: string;
  name: string;
  /** 市场关注度 0~100 */
  focus: number;
  /** 千股千评综合得分 0~100 */
  score: number;
  /** 全市场关注度排名 */
  rank: number;
  /** 排名变化（正=名次上升） */
  rankUp: number;
  /** 当日涨跌幅（%） */
  pct: number;
}

export interface BuzzData {
  updatedAt: number;
  popular: RawPopular[];
  posts: BuzzPostLike[];
  /** 股吧热帖来自哪个入口：pc（带阅读/评论）或 mobile（仅标题） */
  postsSource: 'pc' | 'mobile' | null;
  /** 淘股吧（全市场讨论）条数 */
  taoguCount: number;
  focus: FocusRow[];
  /** 千股千评数据日期（T-1） */
  focusDate: string;
  /** 财联社电报（消息面） */
  news: NewsFlash[];
  warnings: string[];
}

/* ============ 请求 ============ */

async function request(host: string, path: string, init?: RequestInit, timeoutMs = 12000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(px(host, path), {
      ...init,
      signal: ctrl.signal,
      headers: { Accept: '*/*', ...(init?.headers ?? {}) }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ============ 人气榜 ============ */

interface RankResp {
  status?: number;
  data?: { sc?: string; rk?: number; rc?: number; hisRc?: number }[] | null;
}

/**
 * 股吧人气榜（实时）。
 * POST 体是东财前端写死的固定结构，pageSize 上限实测 100。
 */
export async function fetchPopularity(limit = 50): Promise<RawPopular[]> {
  const res = await request(HOST_RANK, '/stockrank/getAllCurrentList', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      appId: 'appId01',
      globalId: '786e4c21-70dc-435a-93bb-38',
      marketType: '',
      pageNo: 1,
      pageSize: Math.min(100, limit)
    })
  });
  const j = (await res.json()) as RankResp;
  const rows = j.data ?? [];
  if (!rows.length) throw new Error('人气榜为空');
  return rows
    .map((r) => ({
      // "SZ002086" → "002086"
      code: String(r.sc ?? '').slice(2),
      rank: Number(r.rk ?? 0),
      rankChange: Number(r.rc ?? 0)
    }))
    .filter((r) => r.code);
}

/* ============ 股吧热帖 ============ */

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m);
}

/**
 * 解析股吧列表页。
 * 结构：<tr class="listitem"><td><div class="read">304</div></td><td><div class="reply">2</div></td>
 *       <td><div class="title"><a ...>标题</a></div></td>…<td><div class="update">11-02 10:00</div></td></tr>
 */
export function parseGubaList(html: string, code: string, name: string): BuzzPostLike[] {
  const out: BuzzPostLike[] = [];
  const rows = html.match(/<tr class="listitem">([\s\S]*?)<\/tr>/g) ?? [];
  for (const row of rows) {
    const title = /<div class="title">\s*<a[^>]*>([\s\S]*?)<\/a>/.exec(row)?.[1];
    if (!title) continue;
    const clean = decodeEntities(title.replace(/<[^>]+>/g, '').trim());
    if (!clean) continue;
    const read = Number((/class="read">([\d,]+)</.exec(row)?.[1] ?? '0').replace(/,/g, ''));
    const reply = Number((/class="reply">([\d,]+)</.exec(row)?.[1] ?? '0').replace(/,/g, ''));
    const time = /class="update">([^<]+)</.exec(row)?.[1] ?? '';
    out.push({ code, name, title: clean, read, reply, time: time.trim() });
  }
  return out;
}

/**
 * 股吧移动端列表（SSR 渲染，不带阅读/评论数）。
 * 结构：<a href=".../article/..."><p class="title">标题</p><p class="abstract">摘要</p>
 * PC 页被「身份核实」验证码拦截时（高频抓取后常见），这是唯一还能拿到帖子的入口。
 */
export function parseGubaMobile(html: string, code: string, name: string): BuzzPostLike[] {
  const out: BuzzPostLike[] = [];
  const re = /<p class="title">([\s\S]*?)<\/p>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const title = decodeEntities(m[1].replace(/<[^>]+>/g, '').trim());
    if (title && title.length >= 4) {
      out.push({ code, name, title, read: 0, reply: 0, time: '' });
    }
  }
  return out;
}

/** 判断 PC 页是否被反爬拦截（返回「身份核实」验证页） */
function isBlockedPage(html: string): boolean {
  return html.length < 20000 && /身份核实|fd_guba_validate/.test(html);
}

/**
 * 抓股吧热帖：PC 页优先（带阅读/评论数），被拦截则降级移动端。
 * 一次会话内只要 PC 被拦过就记下来，后续直接走移动端，避免每次多打 4 个必失败的请求。
 */
let pcBlocked = false;

async function fetchGubaPosts(
  stocks: { code: string; name: string }[]
): Promise<{ posts: BuzzPostLike[]; source: 'pc' | 'mobile' | null }> {
  const results = await Promise.allSettled(
    stocks.map(async (s) => {
      if (!pcBlocked) {
        try {
          const res = await request(HOST_GUBA, `/list,${s.code}.html`, undefined, 15000);
          const html = await res.text();
          if (!isBlockedPage(html)) {
            const rows = parseGubaList(html, s.code, s.name);
            if (rows.length) return { rows, from: 'pc' as const };
          } else {
            pcBlocked = true;
          }
        } catch {
          /* 落到移动端 */
        }
      }
      const res = await request(HOST_MGUBA, `/mguba/list/${s.code}`, undefined, 15000);
      const html = await res.text();
      return { rows: parseGubaMobile(html, s.code, s.name), from: 'mobile' as const };
    })
  );

  const posts: BuzzPostLike[] = [];
  let source: 'pc' | 'mobile' | null = null;
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    posts.push(...r.value.rows);
    if (r.value.rows.length) source = r.value.from;
  }
  return { posts, source };
}

/* ============ 淘股吧（全市场讨论） ============ */

/**
 * 解析淘股吧「社区总版」列表。
 *
 * 每个帖子是一个 `<div class="Nbbs-tiezi-lists">` 块，块内依次是：
 *   <a href="/a/{id}" title="标题">
 *   <span>(N)</span>
 *   <div class="middle-list-talk">回复数 / 阅读数</div>
 *   <div class="middle-list-reply">最后回复时间</div>
 *   <div class="middle-list-post">发帖时间</div>
 *
 * 与股吧不同，这里是**全市场讨论**（不绑定个股），一页约 70 条，没有可用的分页参数
 * （?pageNo=2 返回同一页），但 70 条对情绪统计已经足够。
 */
export function parseTaoguList(html: string): BuzzPostLike[] {
  const out: BuzzPostLike[] = [];
  const blocks = html.split('Nbbs-tiezi-lists').slice(1);
  for (const b of blocks) {
    const link = /href="\/a\/([^"]+)"[^>]*title="([^"]+)"/.exec(b);
    if (!link) continue;
    const title = decodeEntities(link[2].replace(/<[^>]+>/g, '').trim());
    if (!title || title.length < 4) continue;
    const talk = /middle-list-talk[^>]*>([^<]*)</.exec(b)?.[1] ?? '';
    const [replyRaw, readRaw] = talk.split('/');
    const reply = Number(String(replyRaw ?? '').trim()) || 0;
    const read = Number(String(readRaw ?? '').trim()) || 0;
    const time = (/middle-list-post[^>]*>([^<]*)</.exec(b)?.[1] ?? '').trim();
    out.push({ code: 'tgb', name: '淘股吧', title, read, reply, time });
  }
  return out;
}

async function fetchTaogu(): Promise<BuzzPostLike[]> {
  const res = await request(HOST_TGB, '/zongban/', undefined, 15000);
  const html = await res.text();
  return parseTaoguList(html);
}

/* ============ 千股千评 ============ */

interface DcResp<T> {
  result?: { data?: T[] } | null;
  success?: boolean;
}

async function fetchFocusTop(n = 20): Promise<{ rows: FocusRow[]; date: string }> {
  const path =
    `/api/data/v1/get?reportName=RPT_DMSK_TS_STOCKNEW` +
    `&columns=SECURITY_CODE,SECURITY_NAME_ABBR,FOCUS,TOTALSCORE,RANK,RANK_UP,CHANGE_RATE,TRADE_DATE` +
    `&pageNumber=1&pageSize=${n}&sortColumns=FOCUS&sortTypes=-1`;
  const res = await request(HOST_DC, path);
  const j = (await res.json()) as DcResp<Record<string, number | string>>;
  const raw = j.result?.data ?? [];
  const rows = raw.map((r) => ({
    code: String(r.SECURITY_CODE ?? ''),
    name: String(r.SECURITY_NAME_ABBR ?? ''),
    focus: Number(r.FOCUS ?? 0),
    score: Number(r.TOTALSCORE ?? 0),
    rank: Number(r.RANK ?? 0),
    rankUp: Number(r.RANK_UP ?? 0),
    pct: Number(r.CHANGE_RATE ?? 0)
  }));
  const date = String(raw[0]?.TRADE_DATE ?? '').slice(0, 10);
  if (!rows.length) throw new Error('千股千评为空');
  return { rows, date };
}

/* ============ 缓存 ============ */

interface Cached {
  ts: number;
  data: BuzzData;
}

function loadCache(): BuzzData | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!c?.data || Date.now() - c.ts > CACHE_TTL_MS) return null;
    if (!Array.isArray(c.data.popular) || !Array.isArray(c.data.posts)) return null;
    return c.data;
  } catch {
    return null;
  }
}

function saveCache(data: BuzzData): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), data } satisfies Cached));
  } catch {
    /* 忽略配额 */
  }
}

export function clearBuzzCache(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* 忽略 */
  }
}

/* ============ 主入口 ============ */

export interface BuzzOptions {
  force?: boolean;
  quotes: { code: string; name: string; pct: number }[];
}

export async function fetchBuzz(opts: BuzzOptions): Promise<BuzzData> {
  if (!opts.force) {
    const hit = loadCache();
    if (hit) return hit;
  }

  const warnings: string[] = [];
  const safe = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      warnings.push(`${name}：${e instanceof Error ? e.message : '不可用'}`);
      return null;
    }
  };

  const cachedNews = loadNewsCache();
  const [popular, focus, taogu, news] = await Promise.all([
    safe('股吧人气榜', () => fetchPopularity(50)),
    safe('千股千评', () => fetchFocusTop(20)),
    safe('淘股吧', fetchTaogu),
    cachedNews ? Promise.resolve(cachedNews) : safe('财联社电报', () => fetchClsNews(40))
  ]);
  if (news?.length && !cachedNews) saveNewsCache(news);

  // 人气榜只给代码，名称与涨跌幅用已经拉到的全 A 行情补上
  const quoteMap = new Map(opts.quotes.map((q) => [q.code, q]));
  const top = (popular ?? []).filter((p) => quoteMap.has(p.code)).slice(0, POST_STOCKS);
  const guba = top.length
    ? await fetchGubaPosts(top.map((p) => ({ code: p.code, name: quoteMap.get(p.code)?.name ?? p.code })))
    : { posts: [], source: null as 'pc' | 'mobile' | null };
  // 淘股吧是全市场讨论，股吧是「最热几只股票」的讨论，两者互补
  const posts = [...(taogu ?? []), ...guba.posts];
  if (!posts.length) warnings.push('讨论帖：淘股吧与股吧均未取到');
  else if (guba.source === 'mobile') warnings.push('股吧 PC 页被验证码拦截，热帖已降级移动端（无阅读/评论数）');

  const data: BuzzData = {
    updatedAt: Date.now(),
    popular: popular ?? [],
    posts,
    postsSource: guba.source,
    taoguCount: taogu?.length ?? 0,
    focus: focus?.rows ?? [],
    focusDate: focus?.date ?? '',
    news: news ?? [],
    warnings
  };
  saveCache(data);
  return data;
}
