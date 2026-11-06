/**
 * Yahoo Finance 源（全球指数兜底，覆盖日经/韩国/港股/美股）：
 *   query1.finance.yahoo.com/v8/finance/chart/{symbol}?range=2y&interval=1d
 * 不返回 CORS 头，浏览器环境走本地代理；国内网络可能不可达，作为最后一道兜底。
 */
import type { Bar, SymbolDef } from '../types';
import type { KlineSource } from './types';
import { isBrowser, px } from './proxy';

const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];

/** days → yahoo range 字符串 */
function rangeFor(days: number): string {
  if (days <= 70) return '3mo';
  if (days <= 400) return '2y';
  if (days <= 1200) return '5y';
  return '10y';
}

function parse(text: string, days: number): Bar[] {
  const j = JSON.parse(text) as {
    chart?: {
      result?: {
        timestamp?: number[];
        indicators?: { quote?: { open?: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }[] };
      }[];
    };
  };
  const r = j?.chart?.result?.[0];
  const ts = r?.timestamp;
  const q = r?.indicators?.quote?.[0];
  if (!ts || !q?.close) throw new Error('yahoo empty');
  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    if (close == null) continue;
    const volume = q.volume?.[i] ?? 0;
    bars.push({
      date: new Date(ts[i] * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? close,
      high: q.high?.[i] ?? close,
      low: q.low?.[i] ?? close,
      close,
      volume,
      amount: volume * close
    });
  }
  return bars.filter((b) => b.close > 0).slice(-days);
}

export const yahooSource: KlineSource = {
  id: 'yahoo',
  label: 'Yahoo Finance',
  canHandle: (sym) => !!sym.yahoo,
  async fetch(sym: SymbolDef, days: number): Promise<Bar[]> {
    if (!sym.yahoo) throw new Error('no yahoo symbol');
    const path = `/v8/finance/chart/${encodeURIComponent(sym.yahoo)}?range=${rangeFor(days)}&interval=1d`;
    let lastErr: unknown = null;
    // 主备 host 轮换
    const order = isBrowser ? [px(HOSTS[0], path), px(HOSTS[1], path), `https://${HOSTS[0]}${path}`] : [`https://${HOSTS[0]}${path}`, `https://${HOSTS[1]}${path}`];
    for (const url of order) {
      try {
        const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!res.ok) throw new Error(`yahoo http ${res.status}`);
        const text = await res.text();
        if (text.trimStart().startsWith('<')) throw new Error('yahoo got html');
        return parse(text, days);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('yahoo unavailable');
  }
};
