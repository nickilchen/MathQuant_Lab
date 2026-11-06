/** 行情数据通用类型 */

export interface Bar {
  date: string;   // YYYY-MM-DD
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number; // 手/股
  amount: number; // 元
}

export type DataSource = 'tencent' | 'eastmoney' | 'naver' | 'sina' | 'yahoo' | 'yahoo-jp' | 'cache' | 'demo';

export type SymbolKind = 'index' | 'etf' | 'bond' | 'gold' | 'overseas' | 'commodity' | 'industry' | 'stock';

export interface SymbolDef {
  /** 应用内唯一键（缓存/状态键）；对多数市场同时也是腾讯代码 */
  code: string;
  name: string;
  /** 东财 secid；留空表示该源不可用 */
  secid: string;
  kind: SymbolKind;
  market: 'CN' | 'HK' | 'US' | 'JP' | 'KR' | 'TW';
  /** Naver 代码（韩国市场）：KOSPI/KOSDAQ/六位个股代码 */
  naver?: string;
  /** 新浪代码：A 股用 sh/sz 前缀代码；美股用 .INX/.DJI/.IXIC 或 ETF 代码 */
  sina?: string;
  /** Yahoo 代码：^GSPC / ^N225 / ^HSI 等 */
  yahoo?: string;
  /** 板块/风格分组（港股龙头、美股风格篮子用） */
  sector?: string;
  /** 主源偏好（部分源明确不可用时跳过） */
  preferSource?: 'tencent' | 'eastmoney' | 'naver';
  /** 模拟数据基准价 */
  base: number;
}

export interface FundFlow {
  date: string;
  main: number;    // 主力净流入（元）
  large: number;   // 大单净流入
  xlarge: number;  // 超大单净流入
}

export interface KlineResult {
  bars: Bar[];
  source: DataSource;
}
