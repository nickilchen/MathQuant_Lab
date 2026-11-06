/**
 * 季度财报路由：A 股走东财，港股 / 美股 / 日股 / 韩股走 StockAnalysis。
 *
 * 统一入口保持 `fetchQuarterReports(code)` 不变，页面不需要知道数据来自哪。
 * 缓存 6 小时（财报按季更新），按 code 存，避免同一标的重复请求。
 */
import { cnCode, fetchCnReports } from './cn';
import { fetchSaReports } from './sa';
import type { QuarterReport, ValuationMarket, ValuationMarketMeta } from './types';

export type { QuarterReport, ValuationMarket, ValuationMarketMeta };

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

/* ---------- 市场识别 ---------- */

const CN_INDEX = /^(sh000|sz399|bj899)/i;
const HK_INDEX = /^hk(HSI|HSTECH|HSCEI)$/i;
const US_INDEX = /^us(DJI|INX|IXIC|SPX|NDX)$/i;
const JP_INDEX = /^jp(N225|TOPIX)$/i;
const KR_INDEX = /^kr(KOSPI|KOSDAQ)$/i;

export function valuationMarket(code: string): ValuationMarket | null {
  const c = String(code ?? '').trim();
  if (!c) return null;
  if (/^(sh|sz|bj)\d{6}$/i.test(c)) return CN_INDEX.test(c) ? null : 'CN';
  if (HK_INDEX.test(c)) return null;
  if (/^hk\d{5}$/i.test(c)) return 'HK';
  if (US_INDEX.test(c)) return null;
  if (/^us[A-Za-z][A-Za-z.-]*$/i.test(c)) return 'US';
  if (JP_INDEX.test(c)) return null;
  if (/^jp\d{4,5}$/i.test(c)) return 'JP';
  if (KR_INDEX.test(c)) return null;
  if (/^kr\d{6}$/i.test(c)) return 'KR';
  return null;
}

/** 指数与不支持的市场返回 false */
export function canFetchValuation(code: string): boolean {
  return valuationMarket(code) != null;
}

/** 兼容旧调用：A 股六位代码 */
export function valuationCode(code: string): string | null {
  return cnCode(code);
}

/* ---------- 市场元数据 ---------- */

const META: Record<ValuationMarket, Omit<ValuationMarketMeta, 'market'>> = {
  CN: {
    label: 'A 股',
    source: '东财业绩报表（RPT_LICO_FN_CPD）',
    currency: '元',
    currencySymbol: '¥',
    noticeEstimated: false,
    note: '财报为年初至今累计值，TTM 用「本期 + 上年全年 − 上年同期」差分；公告日为真实披露日。'
  },
  HK: {
    label: '港股',
    source: 'StockAnalysis 季度财报',
    currency: '港元',
    currencySymbol: 'HK$',
    noticeEstimated: true,
    note: '单季 EPS 与每股净资产；港股无免费公告日字段，按披露期限保守估算（季报 +60 天、年报 +100 天）。'
  },
  US: {
    label: '美股',
    source: 'StockAnalysis 季度财报',
    currency: '美元',
    currencySymbol: '$',
    noticeEstimated: true,
    note: '单季 EPS 与每股净资产；公告日按披露期限保守估算（季报 +60 天、年报 +100 天）。'
  },
  JP: {
    label: '日股',
    source: 'StockAnalysis 季度财报',
    currency: '日元',
    currencySymbol: '¥',
    noticeEstimated: true,
    note: '单季 EPS 与每股净资产（日元）；公告日按披露期限保守估算。日股财年多为 3 月，Q4 即财年末。'
  },
  KR: {
    label: '韩股',
    source: 'StockAnalysis 季度财报',
    currency: '韩元',
    currencySymbol: '₩',
    noticeEstimated: true,
    note: '单季 EPS 与每股净资产（韩元）；公告日按披露期限保守估算。'
  }
};

export function valuationMeta(code: string): ValuationMarketMeta | null {
  const market = valuationMarket(code);
  return market ? { market, ...META[market] } : null;
}

/* ---------- 取数（带缓存） ---------- */

const cacheKey = (code: string) => `mq:valuation:v2:${String(code).trim().toLowerCase()}`;

export async function fetchQuarterReports(code: string, size = 60): Promise<QuarterReport[]> {
  const market = valuationMarket(code);
  if (!market) {
    throw new Error('该标的没有季度财报数据（支持 A 股 / 港股 / 美股 / 日股 / 韩股个股；指数与台股不支持）');
  }

  const key = cacheKey(code);
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const cached = JSON.parse(raw) as { ts: number; list: QuarterReport[] };
      if (cached?.list?.length && Date.now() - cached.ts < CACHE_TTL_MS) return cached.list;
    }
  } catch {
    /* 忽略缓存损坏 */
  }

  const list = market === 'CN' ? await fetchCnReports(code, size) : await fetchSaReports(market, code);

  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), list }));
  } catch {
    /* 忽略配额 */
  }
  return list;
}
