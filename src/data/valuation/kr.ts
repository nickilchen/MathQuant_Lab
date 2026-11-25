/**
 * 韩股财报：Naver Finance annual 接口。
 *
 * 替代 StockAnalysis（2026-11 起整站 Cloudflare 403）。
 * Naver 的 m.stock.naver.com/api/stock/{code}/finance/annual 返回年度财务摘要，
 * 字段用韩文标题：매출액(营收) / 영업이익(营业利润) / 당기순이익(净利润) /
 *   EPS / BPS / PER(市盈率=PE) / PBR(市净率=PB) / ROE / 부채비율(负债率)。
 *
 * 限制：只有年度数据（约 4 期），样本少于季报，历史分位较粗；
 *   但这比 StockAnalysis 403 后完全不可用要好，且数据真实、不臆造。
 *   Naver 无公告日字段 → 按年报披露期限估算（+100 天），标记 noticeEstimated。
 */
import { px } from '../sources/proxy';
import type { QuarterReport } from './types';

const HOST = 'm.stock.naver.com';

interface NaverColumn {
  value?: string | null;
}
interface NaverRow {
  title?: string;
  columns?: Record<string, NaverColumn>;
}
interface NaverResp {
  financeInfo?: {
    trTitleList?: { key?: string; title?: string }[];
    rowList?: NaverRow[];
  };
}

const parseNum = (v: unknown): number | null => {
  const s = String(v ?? '').replace(/,/g, '').replace(/\s/g, '');
  if (!s || /^(-|—|n\/a)$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** kr005930 → 005930 */
function stockCode(code: string): string | null {
  const m = /^kr(\d{6})$/i.exec(String(code ?? '').trim());
  return m ? m[1] : null;
}

export async function fetchKrReports(code: string): Promise<QuarterReport[]> {
  const sc = stockCode(code);
  if (!sc) throw new Error('韩股代码格式不匹配');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let resp: NaverResp;
  try {
    const res = await fetch(px(HOST, `/api/stock/${sc}/finance/annual`), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`Naver 韩股财报 HTTP ${res.status}`);
    resp = (await res.json()) as NaverResp;
  } finally {
    clearTimeout(timer);
  }

  const list = mapNaverFinance(resp);
  if (list.length < 3) throw new Error('该韩股财报样本不足（年度数据需 ≥3 期）');
  return list;
}

/** 供单测使用的纯映射函数 */
export function mapNaverFinance(resp: NaverResp): QuarterReport[] {
  const titles = resp?.financeInfo?.trTitleList ?? [];
  const rows = resp?.financeInfo?.rowList ?? [];
  const pick = (title: string): Record<string, number | null> => {
    const row = rows.find((r) => r.title === title);
    const out: Record<string, number | null> = {};
    if (!row?.columns) return out;
    for (const t of titles) {
      const key = String(t.key ?? '');
      out[key] = parseNum(row.columns[key]?.value);
    }
    return out;
  };

  const eps = pick('EPS');
  const bps = pick('BPS');
  const per = pick('PER');
  const pbr = pick('PBR');
  const roe = pick('ROE');
  const profitYoY = pick('당기순이익'); // 净利润（用于展示，非同比）

  const list: QuarterReport[] = [];
  for (const t of titles) {
    const key = String(t.key ?? '');
    // key 形如 202512 → 2025-12-31
    if (!/^\d{6}$/.test(key)) continue;
    const year = key.slice(0, 4);
    const month = key.slice(4, 6);
    const period = `${year}-${month}-${Number(month) === 12 ? '31' : '01'}`;
    const e = eps[key];
    if (e == null) continue;
    // 年报公告日估算：次年 3 月末（+约 100 天）
    const noticeDate = new Date(new Date(`${period}T00:00:00Z`).getTime() + 100 * 86400000)
      .toISOString()
      .slice(0, 10);
    list.push({
      period,
      noticeDate,
      epsCum: e,
      epsQuarter: e,
      netProfitCum: profitYoY[key] ?? 0,
      revenueCum: 0,
      bps: bps[key] ?? 0,
      roe: roe[key] ?? null,
      profitYoY: null,
      revenueYoY: null,
      grossMargin: null,
      ocfPerShare: null,
      noticeEstimated: true,
      // 年度口径：TTM EPS 就是当期年度 EPS
      ttmEps: e > 0 ? e : null,
      peHint: per[key] ?? null,
      pbHint: pbr[key] ?? null
    });
  }
  // 最新在前
  return list.sort((a, b) => b.period.localeCompare(a.period));
}
