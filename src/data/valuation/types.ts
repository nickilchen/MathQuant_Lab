/**
 * 季度财报的统一数据结构。
 *
 * 两个口径必须分清，否则 TTM 会算错：
 *  - A 股（东财）：`epsCum` 是**年初至今累计值**，TTM 要做「本期 + 上年全年 − 上年同期」差分；
 *  - 海外（StockAnalysis）：数据源直接给**单季值**，TTM = 最近 4 个季度相加。
 *
 * 为了不改动已经验证过的 A 股逻辑，海外适配器在数据层就把 TTM 算好塞进 `ttmEps`，
 * `math/valuation.ts` 的 `ttmOf()` 优先使用它；A 股不填，继续走累计差分。
 */

export type ValuationMarket = 'CN' | 'HK' | 'US' | 'JP' | 'KR';

export interface QuarterReport {
  /** 报告期 YYYY-MM-DD */
  period: string;
  /** 公告日 YYYY-MM-DD（估值只能用这之后的价格） */
  noticeDate: string;
  /** A 股：年初至今累计 EPS；海外：单季 EPS */
  epsCum: number;
  /** 累计归母净利（元）；海外无此字段填 0 */
  netProfitCum: number;
  /** 累计营业收入（元）；海外无此字段填 0 */
  revenueCum: number;
  /** 每股净资产（元） */
  bps: number;
  /** 加权 ROE（%）；海外无此字段为 null */
  roe: number | null;
  /** 净利同比（%）；海外无此字段为 null */
  profitYoY: number | null;
  /** 营收同比（%）；海外无此字段为 null */
  revenueYoY: number | null;
  /** 销售毛利率（%）；海外无此字段为 null */
  grossMargin: number | null;
  /** 每股经营现金流（元，累计）；海外无此字段为 null */
  ocfPerShare: number | null;

  /** 数据层预计算的 TTM EPS（海外单季口径） */
  ttmEps?: number | null;
  /** 数据层预计算的 TTM 净利（海外通常没有） */
  ttmProfit?: number | null;
  /** 单季 EPS（海外） */
  epsQuarter?: number | null;
  /** 公告日是否为「按披露期限估算」（海外源没有公告日字段） */
  noticeEstimated?: boolean;
  /** 数据源直接给的当期 PE（海外用季度 PE 序列，绕开 K 线覆盖不足） */
  peHint?: number | null;
  /** 数据源直接给的当期 PB */
  pbHint?: number | null;
}

export interface ValuationMarketMeta {
  market: ValuationMarket;
  /** 市场名，如「A 股」「港股」 */
  label: string;
  /** 数据源说明 */
  source: string;
  /** 金额单位名，如「元」「港元」 */
  currency: string;
  /** 货币符号，如「¥」「HK$」 */
  currencySymbol: string;
  /** 公告日是否为估算 */
  noticeEstimated: boolean;
  /** 数据覆盖说明 */
  note: string;
}
