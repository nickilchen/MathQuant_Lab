/**
 * 季度财报路由：A 股走东财，美股走 SEC EDGAR，港股走东财港股 F10，韩股走 Naver。
 * 日股原走 StockAnalysis——该站 2026-11 起整站 Cloudflare 403，且无可靠免 key 替代源，
 * 因此明确不可用（给提示，绝不用模拟数据冒充）。
 *
 * 统一入口保持 `fetchQuarterReports(code)` 不变，页面不需要知道数据来自哪。
 * 缓存 6 小时（财报按季更新），按 code 存，避免同一标的重复请求。
 */
import { cnCode, fetchCnReports } from './cn';
import { fetchHkReports } from './hk';
import { fetchSecReports } from './sec';
import { fetchKrReports } from './kr';
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
    source: '东财港股 F10（RPT_HKF10_FN_MAININDICATOR）',
    currency: '港元',
    currencySymbol: 'HK$',
    noticeEstimated: true,
    note: '累计 EPS / BPS / TTM / PE / PB（东财主要指标）；东财无公告日字段，按披露期限保守估算（季报 +60 天、年报 +100 天）。'
  },
  US: {
    label: '美股',
    source: 'SEC EDGAR companyconcept（官方 XBRL）',
    currency: '美元',
    currencySymbol: '$',
    noticeEstimated: false,
    note: '稀释单季 EPS + 归母权益/股本得 BPS，TTM 为最近 4 单季和；公告日为 SEC 真实 filed 日期。少数用自定义 XBRL tag 的标的（如 BRK.B）暂不可得。'
  },
  JP: {
    label: '日股',
    source: '原 StockAnalysis（已失效）',
    currency: '日元',
    currencySymbol: '¥',
    noticeEstimated: true,
    note: '日股财报数据源暂不可用（原站 Cloudflare 403，暂无可靠免 key 替代），估值页会明确提示；本站不用模拟数据冒充。'
  },
  KR: {
    label: '韩股',
    source: 'Naver Finance（年度财务）',
    currency: '韩元',
    currencySymbol: '₩',
    noticeEstimated: true,
    note: '年度 EPS / BPS / PER / PBR / ROE（Naver），仅约 4 期样本、分位较粗；公告日按年报期限估算（+100 天）。'
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

  let list: QuarterReport[];
  switch (market) {
    case 'CN':
      list = await fetchCnReports(code, size);
      break;
    case 'US':
      list = await fetchSecReports(code);
      break;
    case 'HK':
      list = await fetchHkReports(code, size);
      break;
    case 'KR':
      list = await fetchKrReports(code);
      break;
    case 'JP':
      throw new Error('日股财报数据源暂不可用（原 StockAnalysis 已失效），本站不用模拟数据冒充');
  }

  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), list }));
  } catch {
    /* 忽略配额 */
  }
  return list;
}
