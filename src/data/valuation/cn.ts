/**
 * A 股季度财报：东财业绩报表 RPT_LICO_FN_CPD
 *
 * 接口：datacenter-web.eastmoney.com/api/data/v1/get
 *   reportName=RPT_LICO_FN_CPD，filter=(SECURITY_CODE="600519")，pageSize=60 → 约 15 年季度数据
 *
 * 字段是**年初至今累计值**（BASIC_EPS / PARENT_NETPROFIT / TOTAL_OPERATE_INCOME），
 * 不是单季值——算 TTM 必须做差分，这一步在 math/valuation.ts 里完成。
 *
 * 公告日 NOTICE_DATE 很关键：估值只能用「公告之后」的股价，否则是前视偏差。
 */
import { px } from '../sources/proxy';
import type { QuarterReport } from './types';

const HOST = 'datacenter-web.eastmoney.com';

interface RawRow {
  REPORTDATE?: string;
  NOTICE_DATE?: string;
  BASIC_EPS?: number | string;
  PARENT_NETPROFIT?: number | string;
  TOTAL_OPERATE_INCOME?: number | string;
  BPS?: number | string;
  WEIGHTAVG_ROE?: number | string;
  SJLTZ?: number | string;
  YSTZ?: number | string;
  XSMLL?: number | string;
  MGJYXJJE?: number | string;
}

interface DcResp {
  success?: boolean;
  result?: { data?: RawRow[]; pages?: number };
}

const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
const iso = (v: unknown): string => String(v ?? '').slice(0, 10);

/** A 股六位代码 */
export function cnCode(code: string): string | null {
  const m = /^(sh|sz|bj)(\d{6})$/i.exec(String(code ?? '').trim());
  return m ? m[2] : null;
}

export async function fetchCnReports(code: string, size = 60): Promise<QuarterReport[]> {
  const c = cnCode(code);
  if (!c) throw new Error('不是 A 股代码');

  const filter = encodeURIComponent(`(SECURITY_CODE="${c}")`);
  const cols =
    'SECURITY_CODE,REPORTDATE,NOTICE_DATE,BASIC_EPS,PARENT_NETPROFIT,TOTAL_OPERATE_INCOME,BPS,WEIGHTAVG_ROE,SJLTZ,YSTZ,XSMLL,MGJYXJJE';
  const path = `/api/data/v1/get?reportName=RPT_LICO_FN_CPD&columns=${cols}&filter=${filter}&pageNumber=1&pageSize=${size}&sortColumns=REPORTDATE&sortTypes=-1`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  let json: DcResp;
  try {
    const res = await fetch(px(HOST, path), { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = (await res.json()) as DcResp;
  } finally {
    clearTimeout(timer);
  }

  const rows = json?.result?.data ?? [];
  const list: QuarterReport[] = rows
    .map((r) => ({
      period: iso(r.REPORTDATE),
      noticeDate: iso(r.NOTICE_DATE) || iso(r.REPORTDATE),
      epsCum: n(r.BASIC_EPS),
      netProfitCum: n(r.PARENT_NETPROFIT),
      revenueCum: n(r.TOTAL_OPERATE_INCOME),
      bps: n(r.BPS),
      roe: n(r.WEIGHTAVG_ROE),
      profitYoY: n(r.SJLTZ),
      revenueYoY: n(r.YSTZ),
      grossMargin: n(r.XSMLL),
      ocfPerShare: n(r.MGJYXJJE),
      noticeEstimated: false
    }))
    .filter((r) => r.period.length === 10)
    // 接口按 REPORTDATE 倒序，统一再排一次，防止同一报告期有更正记录
    .sort((a, b) => b.period.localeCompare(a.period));

  if (list.length < 8) throw new Error('季度财报样本不足（至少需要 8 个季度）');
  return list;
}
