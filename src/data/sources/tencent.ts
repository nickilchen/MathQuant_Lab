/** 腾讯源：A 股指数/ETF/个股、港股个股/ETF/指数（美股 K 线仅返 1 根，不接入） */
import type { Bar, SymbolDef } from '../types';
import type { KlineSource } from './types';
import { isBrowser, px } from './proxy';

const HOST = 'web.ifzq.gtimg.cn';

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parse(rows: unknown[][]): Bar[] {
  return rows
    .map((row): Bar => {
      const [date, open, close, high, low, volume] = row as [string, number, number, number, number, number];
      return {
        date,
        open: num(open, close),
        close: num(close, open),
        high: num(high, Math.max(open, close)),
        low: num(low, Math.min(open, close)),
        volume: num(volume, 0),
        amount: num(volume, 0) * num(close, 0)
      };
    })
    .filter((b) => b.date && b.close > 0);
}

export const tencentSource: KlineSource = {
  id: 'tencent',
  label: '腾讯行情',
  canHandle: (sym) => /^(sh|sz|hk)/.test(sym.code),
  async fetch(sym: SymbolDef, days: number): Promise<Bar[]> {
    const path = `/appstock/app/fqkline/get?param=${sym.code},day,,,${days},qfq`;
    // 浏览器：直连优先，失败走本地代理；Node：仅直连
    const urls = isBrowser ? [`https://${HOST}${path}`, px(HOST, path)] : [`https://${HOST}${path}`];
    let lastErr: unknown = null;
    for (const url of urls) {
      try {
        const res = await fetch(url, { cache: 'no-store' });
        if (!res.ok) throw new Error(`tencent http ${res.status}`);
        const j = await res.json();
        const node = j?.data?.[sym.code];
        const arr = node?.qfqday ?? node?.day;
        if (!Array.isArray(arr) || arr.length === 0) throw new Error('tencent empty');
        return parse(arr);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('tencent unavailable');
  }
};
