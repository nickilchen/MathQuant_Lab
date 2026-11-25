/**
 * 港股季度财报：东财 datacenter-web RPT_HKF10_FN_MAININDICATOR。
 *
 * 替代 StockAnalysis（2026-11 起整站 Cloudflare 403）。
 * 东财港股主要指标接口字段完整，比第三方抓 HTML 更稳：
 *   BASIC_EPS / EPS_TTM / BPS / PE_TTM / PB_TTM / ROE_AVG / HOLDER_PROFIT_YOY / OPERATE_INCOME_YOY
 * 报告期为累计口径，但接口直接给了 EPS_TTM（滚动 TTM），数据层填入 ttmEps 避免差分误差。
 *
 * 接口：datacenter-web.eastmoney.com/api/data/v1/get
 *   reportName=RPT_HKF10_FN_MAININDICATOR
 *   filter=(SECUCODE="00700.HK")   ← 港股 5 位代码 + .HK
 *   sortColumns=REPORT_DATE&sortTypes=-1&pageSize=N
 */
import { px } from '../sources/proxy';
import type { QuarterReport } from './types';

const HOST = 'datacenter-web.eastmoney.com';

interface HkRow {
  STD_REPORT_DATE?: string;
  REPORT_DATE?: string;
  BASIC_EPS?: number | string | null;
  DILUTED_EPS?: number | string | null;
  EPS_TTM?: number | string | null;
  BPS?: number | string | null;
  PE_TTM?: number | string | null;
  PB_TTM?: number | string | null;
  ROE_AVG?: number | string | null;
  HOLDER_PROFIT_YOY?: number | string | null;
  OPERATE_INCOME_YOY?: number | string | null;
  GROSS_PROFIT_RATIO?: number | string | null;
  PER_NETCASH_OPERATE?: number | string | null;
}

interface HkResp {
  result?: { data?: HkRow[] } | null;
  success?: boolean;
}

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** hk00700 → 00700.HK */
function secucode(code: string): string | null {
  const m = /^hk(\d{5})$/i.exec(String(code ?? '').trim());
  return m ? `${m[1]}.HK` : null;
}

export async function fetchHkReports(code: string, size = 40): Promise<QuarterReport[]> {
  const sec = secucode(code);
  if (!sec) throw new Error('港股代码格式不匹配');
  const path =
    `/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL` +
    `&filter=(SECUCODE%3D%22${sec}%22)&pageSize=${Math.min(Math.max(size, 8), 60)}` +
    `&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let resp: HkResp;
  try {
    const res = await fetch(px(HOST, path), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`东财港股财报 HTTP ${res.status}`);
    resp = (await res.json()) as HkResp;
  } finally {
    clearTimeout(timer);
  }

  const rows = resp?.result?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error('该港股暂无东财财报数据');

  const list: QuarterReport[] = rows.map(mapHkRow).filter((x): x is QuarterReport => !!x);

  if (list.length < 4) throw new Error('该港股财报样本不足');
  // 东财已按日期倒序，确保最新在前
  return list.sort((a, b) => b.period.localeCompare(a.period));
}

/** 供单测使用的纯映射函数 */
export function mapHkRow(r: HkRow): QuarterReport | null {
  const period = String(r.STD_REPORT_DATE || r.REPORT_DATE || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) return null;
  const epsTTM = num(r.EPS_TTM);
  const isAnnual = period.slice(5) === '12-31';
  const notice = new Date(new Date(`${period}T00:00:00Z`).getTime() + (isAnnual ? 100 : 60) * 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    period,
    noticeDate: notice,
    epsCum: num(r.BASIC_EPS) ?? 0,
    epsQuarter: num(r.BASIC_EPS),
    netProfitCum: 0,
    revenueCum: 0,
    bps: num(r.BPS) ?? 0,
    roe: num(r.ROE_AVG),
    profitYoY: num(r.HOLDER_PROFIT_YOY),
    revenueYoY: num(r.OPERATE_INCOME_YOY),
    grossMargin: num(r.GROSS_PROFIT_RATIO),
    ocfPerShare: num(r.PER_NETCASH_OPERATE),
    noticeEstimated: true,
    ttmEps: epsTTM != null && epsTTM > 0 ? epsTTM : null,
    peHint: num(r.PE_TTM),
    pbHint: num(r.PB_TTM)
  };
}
