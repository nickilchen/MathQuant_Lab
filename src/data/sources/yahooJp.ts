/**
 * 日股 K 线：Yahoo!ファイナンス 的历史股价页（HTML）。
 *
 * 为什么不用 Yahoo Finance 的 chart API：国内网络对它返回 403/429，
 * 而 `finance.yahoo.co.jp` 一直可用（消息面的適時開示也是走它）。
 *
 * 限制：它每页固定 20 行，参数改不了（limit/num 都无效）。这里最多抓 6 页 = 120 个交易日，
 * 只用于「现价 + 最近走势」；估值的历史 PE 分位不依赖这条 K 线，而是用
 * StockAnalysis 的季度 PE 序列（见 data/valuation/sa.ts 的 peHint）。
 */
import type { Bar, SymbolDef } from '../types';
import type { KlineSource } from './types';
import { px } from './proxy';

const HOST = 'finance.yahoo.co.jp';
const MAX_PAGES = 6;

const num = (s: string): number => Number(String(s ?? '').replace(/,/g, '')) || 0;

/** `2026/11/4` → `2026-11-04` */
export function parseJpDate(raw: string): string | null {
  const m = /(\d{4})\/(\d{1,2})\/(\d{1,2})/.exec(String(raw ?? ''));
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}

/**
 * 解析历史股价表：
 *   日付 | 始値 | 高値 | 安値 | 終値 | 出来高 | 調整後 終値 | PER | PBR
 */
export function parseYahooJpHistory(html: string): Bar[] {
  const table = /<table[^>]*>([\s\S]*?)<\/table>/.exec(String(html ?? ''));
  if (!table) return [];
  const rows = [...table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) =>
    [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((x) =>
      x[1]
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    )
  );

  const out: Bar[] = [];
  for (const r of rows) {
    if (r.length < 6) continue;
    const date = parseJpDate(r[0]);
    if (!date) continue;
    const close = num(r[4]);
    if (!(close > 0)) continue;
    out.push({
      date,
      open: num(r[1]) || close,
      high: num(r[2]) || close,
      low: num(r[3]) || close,
      close,
      volume: num(r[5]),
      amount: num(r[5]) * close
    });
  }
  return out;
}

export const yahooJpSource: KlineSource = {
  id: 'yahoo-jp',
  label: 'Yahoo!ファイナンス',
  canHandle: (sym) => sym.market === 'JP' && !!sym.yahoo,
  async fetch(sym: SymbolDef, days: number): Promise<Bar[]> {
    if (!sym.yahoo) throw new Error('no yahoo jp symbol');

    const want = Math.min(MAX_PAGES * 20, Math.max(20, days));
    const pages = Math.ceil(want / 20);
    const urls = Array.from({ length: pages }, (_, i) =>
      px(HOST, `/quote/${encodeURIComponent(sym.yahoo!)}/history?page=${i + 1}`)
    );

    const bars: Bar[] = [];
    // 3 个一批，别把 Yahoo JP 打出限流
    for (let i = 0; i < urls.length; i += 3) {
      const batch = await Promise.all(
        urls.slice(i, i + 3).map(async (u) => {
          try {
            const res = await fetch(u, { headers: { Accept: 'text/html' } });
            return res.ok ? await res.text() : '';
          } catch {
            return '';
          }
        })
      );
      for (const html of batch) bars.push(...parseYahooJpHistory(html));
    }

    if (!bars.length) throw new Error('yahoo-jp empty');

    // 多页可能重叠，按日期去重后升序
    const map = new Map<string, Bar>();
    for (const b of bars) map.set(b.date, b);
    return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-days);
  }
};
