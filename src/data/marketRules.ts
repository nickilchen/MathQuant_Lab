/**
 * 各市场的交易制度。
 *
 * 波段跨日，T+1 影响不大；抄底短线影响很大：
 *  - A 股 T+1，当天买的当天不能卖，跌停时还可能买不到/卖不掉；
 *  - 港股 / 美股 T+0，无涨跌停；
 *  - 日股有値幅制限，韩股 ±30%。
 * 这些规则直接决定「计划能不能执行」，页面必须按市场显示，不能一套文案打天下。
 */

export type TradingMarket = 'CN' | 'HK' | 'US' | 'JP' | 'KR';

export interface MarketRule {
  label: string;
  currency: string;
  /** 交收制度 */
  settlement: 'T+1' | 'T+0';
  /** 涨跌停描述 */
  priceLimit: string;
  /** 一手股数（用于仓位取整） */
  lotSize: number;
  /** 执行层面的提醒 */
  note: string;
}

export const MARKET_RULES: Record<TradingMarket, MarketRule> = {
  CN: {
    label: 'A 股',
    currency: '元',
    settlement: 'T+1',
    priceLimit: '主板 ±10%，创业板/科创板 ±20%',
    lotSize: 100,
    note: 'T+1：今天买的明天才能卖。跌停板可能买不到，也可能卖不掉，抄底计划要按「次日才能动」来排。'
  },
  HK: {
    label: '港股',
    currency: '港元',
    settlement: 'T+0',
    priceLimit: '无涨跌停',
    lotSize: 100,
    note: 'T+0 可当日回转，但每手股数因股票而异（这里按 100 股估算仓位）。无涨跌停，单日跌幅可以远超 A 股。'
  },
  US: {
    label: '美股',
    currency: '美元',
    settlement: 'T+0',
    priceLimit: '无涨跌停（个股有波动熔断）',
    lotSize: 1,
    note: 'T+0、可按 1 股买。盘前盘后波动大，抄底要看清楚是盘中价还是盘后价。'
  },
  JP: {
    label: '日股',
    currency: '日元',
    settlement: 'T+0',
    priceLimit: '値幅制限（通常 ±10%~30%）',
    lotSize: 100,
    note: 'T+0，但多数股票 100 股起买；有値幅制限，跌停时同样可能无法成交。'
  },
  KR: {
    label: '韩股',
    currency: '韩元',
    settlement: 'T+0',
    priceLimit: '±30%',
    lotSize: 1,
    note: 'T+0、可按 1 股买；±30% 涨跌停，恐慌日容易出现跌停封死。'
  }
};

const CN_INDEX = /^(sh000|sz399|bj899)/i;
const HK_INDEX = /^hk(HSI|HSTECH|HSCEI)$/i;
const US_INDEX = /^us(DJI|INX|IXIC|SPX|NDX)$/i;
const JP_INDEX = /^jp(N225|TOPIX)$/i;
const KR_INDEX = /^kr(KOSPI|KOSDAQ)$/i;

/** 代码 → 市场；指数与不支持的市场返回 null */
export function tradingMarket(code: string): TradingMarket | null {
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

export function marketRuleOf(code: string): MarketRule | null {
  const m = tradingMarket(code);
  return m ? MARKET_RULES[m] : null;
}
