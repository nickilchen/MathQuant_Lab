/**
 * 新浪源（东财/腾讯的备份）：
 *  - A 股 / ETF：`quotes.sina.cn/cn/api/openapi.php/CN_MarketDataService.getKLineData`
 *  - 美股 / 美股 ETF / 个股：`stock.finance.sina.com.cn/usstock/api/jsonp.php/...US_MinKService.getDailyK`
 * 两个端点都不返回 CORS 头，浏览器环境统一走本地代理（server.mjs / vite dev 提供）。
 */
import type { Bar, SymbolDef } from '../types';
import type { KlineSource } from './types';
import { isBrowser, px } from './proxy';

const CN_HOST = 'quotes.sina.cn';
const US_HOST = 'stock.finance.sina.com.cn';

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** A 股 / ETF：新浪代码与腾讯代码一致（sh000300 / sz159920） */
function cnSymbol(sym: SymbolDef): string {
  return sym.sina ?? sym.code;
}

/** 美股：sym.sina 形如 .INX / .DJI / .IXIC / XLF / AAPL */
function usSymbol(sym: SymbolDef): string | null {
  return sym.sina ?? null;
}

function parseCnJson(text: string, days: number): Bar[] {
  const j = JSON.parse(text) as { result?: { data?: { day: string; open: string; high: string; low: string; close: string; volume: string }[] } };
  const rows = j?.result?.data;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('sina cn empty');
  const bars: Bar[] = rows.map((r) => {
    const close = num(r.close);
    const volume = num(r.volume);
    return {
      date: r.day.slice(0, 10),
      open: num(r.open, close),
      high: num(r.high, close),
      low: num(r.low, close),
      close,
      volume,
      amount: volume * close
    };
  });
  return bars.filter((b) => b.close > 0).slice(-days);
}

/** 解析 jsonp：var _US=([{d,o,h,l,c,v,a},...]) */
function parseUsJsonp(text: string, days: number): Bar[] {
  const start = text.indexOf('([');
  if (start < 0) throw new Error('sina us format');
  const end = text.lastIndexOf(')');
  if (end <= start) throw new Error('sina us format');
  const rows = JSON.parse(text.slice(start + 1, end)) as {
    d: string;
    o: string;
    h: string;
    l: string;
    c: string;
    v: string;
    a: string;
  }[];
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('sina us empty');
  const bars: Bar[] = rows.map((r) => {
    const close = num(r.c);
    const volume = num(r.v);
    const amount = num(r.a);
    return {
      date: r.d.slice(0, 10),
      open: num(r.o, close),
      high: num(r.h, close),
      low: num(r.l, close),
      close,
      volume,
      amount: amount > 0 ? amount : volume * close
    };
  });
  return bars.filter((b) => b.close > 0).slice(-days);
}

async function getJson(urls: string[], days: number, parse: (t: string, d: number) => Bar[]): Promise<Bar[]> {
  let lastErr: unknown = null;
  for (const url of urls) {
    try {
      const res = await fetch(url, { cache: 'no-store', headers: { Accept: '*/*' } });
      if (!res.ok) throw new Error(`sina http ${res.status}`);
      const text = await res.text();
      if (text.trimStart().startsWith('<')) throw new Error('sina got html');
      return parse(text, days);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('sina unavailable');
}

export const sinaSource: KlineSource = {
  id: 'sina',
  label: '新浪财经',
  canHandle: (sym) => /^(sh|sz|bj)/.test(sym.code) || !!sym.sina,
  async fetch(sym: SymbolDef, days: number): Promise<Bar[]> {
    const us = usSymbol(sym);
    // 优先按 sina 字段判断海外标的（.INX / XLF 等），否则按 A 股代码
    if (us && !/^(sh|sz|bj)/.test(sym.code)) {
      const path = `/usstock/api/jsonp.php/var%20_US=/US_MinKService.getDailyK?symbol=${encodeURIComponent(us)}&___qn=3`;
      const urls = isBrowser ? [px(US_HOST, path), `https://${US_HOST}${path}`] : [`https://${US_HOST}${path}`];
      return getJson(urls, days, parseUsJsonp);
    }
    const symbol = cnSymbol(sym);
    const path = `/cn/api/openapi.php/CN_MarketDataService.getKLineData?symbol=${symbol}&scale=240&ma=no&datalen=${days}`;
    const urls = isBrowser ? [px(CN_HOST, path), `https://${CN_HOST}${path}`] : [`https://${CN_HOST}${path}`];
    return getJson(urls, days, parseCnJson);
  }
};
