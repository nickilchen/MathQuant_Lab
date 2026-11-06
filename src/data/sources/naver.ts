/**
 * Naver 源（韩国）：KOSPI / KOSDAQ / 韩国个股。
 *
 * Naver 官方接口有数据但不返回 CORS 头，浏览器不能直连，
 * 因此按三级链取数：
 *   1. 直连（Node 环境 / 未来 Naver 开放 CORS 时自动生效）
 *   2. /naver-api/...  —— Vite dev 代理（npm run dev 时最可靠）
 *   3. allorigins 公共 CORS 代理（生产静态部署时的兜底）
 *
 * 公共代理有速率限制，源内做并发控制（最多 2 个在飞）+ 429 退避重试。
 * 架构上预留了同接口的其他源（如 FMP）：实现 KlineSource 并注册即可。
 */
import type { Bar, SymbolDef } from '../types';
import type { KlineSource } from './types';

const DIRECT = 'https://api.finance.naver.com/siseJson.naver';
const DEV_PROXY = '/naver-api/siseJson.naver';
const CORS_PROXY = 'https://api.allorigins.win/get?url=';

/* ---------- 并发控制（公共代理限速） ---------- */
let inFlight = 0;
const MAX_IN_FLIGHT = 2;
const waiters: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (inFlight < MAX_IN_FLIGHT) {
    inFlight++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  inFlight++;
}

function release(): void {
  inFlight--;
  waiters.shift()?.();
}

/* ---------- 日期工具 ---------- */
function fmtNaverDate(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function rangeFor(days: number): { start: string; end: string } {
  const end = new Date();
  const start = new Date(end.getTime() - (days * 1.7 + 25) * 864e5);
  const f = (d: Date) =>
    `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return { start: f(start), end: f(end) };
}

/* ---------- 解析：数组字面量（表头为单引号，数据行为 JSON 行） ---------- */
export function parseNaver(text: string): Bar[] {
  const cleaned = text.trim().replace(/'/g, '"');
  const arr = JSON.parse(cleaned) as (string | number)[][];
  if (!Array.isArray(arr) || arr.length < 2) return [];
  const bars: Bar[] = [];
  for (let i = 1; i < arr.length; i++) {
    const row = arr[i];
    if (!Array.isArray(row) || row.length < 5) continue;
    const close = Number(row[4]);
    const volume = Number(row[5]) || 0;
    if (!(close > 0)) continue;
    bars.push({
      date: fmtNaverDate(String(row[0])),
      open: Number(row[1]) || close,
      high: Number(row[2]) || close,
      low: Number(row[3]) || close,
      close,
      volume,
      amount: volume * close
    });
  }
  return bars;
}

/* ---------- 单次尝试 ---------- */
async function tryUrl(url: string, days: number): Promise<Bar[]> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`naver http ${res.status}`);
  const ct = res.headers.get('content-type') ?? '';
  let text = await res.text();
  if (ct.includes('application/json')) {
    // allorigins /get 包装：{"contents": "..."}
    try {
      const wrapped = JSON.parse(text) as { contents?: string };
      if (typeof wrapped.contents === 'string') text = wrapped.contents;
    } catch {
      /* 非包装 JSON 则按原文解析 */
    }
  }
  // SPA 回退会把未知路径返回 index.html（如 vite preview 无代理时），按失败处理
  if (text.trimStart().startsWith('<')) throw new Error('naver got html');
  const bars = parseNaver(text);
  if (bars.length < 10) throw new Error('naver too few bars');
  return bars.slice(-days);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 浏览器环境跳过直连（Naver 无 CORS 头，必然失败且刷控制台错误） */
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

export const naverSource: KlineSource = {
  id: 'naver',
  label: 'Naver（韩国）',
  canHandle: (sym) => !!sym.naver,
  async fetch(sym: SymbolDef, days: number): Promise<Bar[]> {
    if (!sym.naver) throw new Error('no naver symbol');
    const { start, end } = rangeFor(days);
    const q = `symbol=${sym.naver}&requestType=1&startTime=${start}&endTime=${end}&timeframe=day`;
    const urls = isBrowser
      ? [`${DEV_PROXY}?${q}`, `${CORS_PROXY}${encodeURIComponent(`${DIRECT}?${q}`)}`]
      : [`${DIRECT}?${q}`, `${DEV_PROXY}?${q}`, `${CORS_PROXY}${encodeURIComponent(`${DIRECT}?${q}`)}`];

    await acquire();
    try {
      let lastErr: unknown = null;
      for (const url of urls) {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            return await tryUrl(url, days);
          } catch (e) {
            lastErr = e;
            // 限流退避后重试同一通道一次
            await sleep(700);
          }
        }
      }
      throw lastErr instanceof Error ? lastErr : new Error('naver unavailable');
    } finally {
      release();
    }
  }
};
