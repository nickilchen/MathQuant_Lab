import type { Bar, SymbolDef } from './types';

export type Market = 'CN' | 'HK' | 'US' | 'JP' | 'KR' | 'TW';

/** 市场元信息 */
export const MARKETS: { market: Market; label: string; flag: string; currency: string }[] = [
  { market: 'CN', label: 'A股', flag: '🇨🇳', currency: 'CNY' },
  { market: 'HK', label: '港股', flag: '🇭🇰', currency: 'HKD' },
  { market: 'US', label: '美股', flag: '🇺🇸', currency: 'USD' },
  { market: 'JP', label: '日股', flag: '🇯🇵', currency: 'JPY' },
  { market: 'KR', label: '韩股', flag: '🇰🇷', currency: 'KRW' }
];

export const MARKET_LABEL: Record<Market, string> = { CN: 'A股', HK: '港股', US: '美股', JP: '日股', KR: '韩股', TW: '台股' };

/**
 * 标的库。
 * code   = 腾讯代码（跨境中日股无腾讯源时留空，取数自动跳过主源）
 * secid  = 东财 secid（无东财源时留空）
 * 韩国（KOSPI）暂无可用的免费 CORS 数据源，未纳入。
 */
export const SYMBOLS: SymbolDef[] = [
  // ---- A股宽基指数（择时模型基准） ----
  { code: 'sh000300', name: '沪深300', secid: '1.000300', kind: 'index', market: 'CN', base: 4000 },
  { code: 'sh000001', name: '上证指数', secid: '1.000001', kind: 'index', market: 'CN', base: 3200 },
  { code: 'sh000905', name: '中证500', secid: '1.000905', kind: 'index', market: 'CN', base: 6000 },
  { code: 'sh000852', name: '中证1000', secid: '1.000852', kind: 'index', market: 'CN', base: 6300 },
  { code: 'sh000016', name: '上证50', secid: '1.000016', kind: 'index', market: 'CN', base: 2700 },
  { code: 'sz399006', name: '创业板指', secid: '0.399006', kind: 'index', market: 'CN', base: 2200 },
  { code: 'sh000688', name: '科创50', secid: '1.000688', kind: 'index', market: 'CN', base: 1400 },
  { code: 'sz399673', name: '创业板50', secid: '0.399673', kind: 'index', market: 'CN', base: 2200 },

  // ---- 港股指数 ----
  { code: 'hkHSI', name: '恒生指数', secid: '100.HSI', yahoo: '^HSI', kind: 'index', market: 'HK', base: 25000 },
  { code: 'hkHSTECH', name: '恒生科技', secid: '', yahoo: '^HSTECH', kind: 'index', market: 'HK', base: 4500 },
  { code: 'hkHSCEI', name: '恒生国企', secid: '', yahoo: '^HSCEI', kind: 'index', market: 'HK', base: 9000 },

  // ---- 港股龙头个股（板块篮子：港股市场几乎没有行业 ETF，行业暴露通过龙头股实现） ----
  // 科技互联网
  { code: 'hk00700', name: '腾讯控股', secid: '', kind: 'stock', market: 'HK', sector: '科技互联网', base: 430 },
  { code: 'hk09988', name: '阿里巴巴', secid: '', kind: 'stock', market: 'HK', sector: '科技互联网', base: 110 },
  { code: 'hk03690', name: '美团', secid: '', kind: 'stock', market: 'HK', sector: '科技互联网', base: 72 },
  { code: 'hk01810', name: '小米集团', secid: '', kind: 'stock', market: 'HK', sector: '科技互联网', base: 25 },
  { code: 'hk09618', name: '京东集团', secid: '', kind: 'stock', market: 'HK', sector: '科技互联网', base: 106 },
  { code: 'hk01024', name: '快手', secid: '', kind: 'stock', market: 'HK', sector: '科技互联网', base: 60 },
  // 金融
  { code: 'hk00005', name: '汇丰控股', secid: '', kind: 'stock', market: 'HK', sector: '金融', base: 146 },
  { code: 'hk00939', name: '建设银行', secid: '', kind: 'stock', market: 'HK', sector: '金融', base: 9.9 },
  { code: 'hk01299', name: '友邦保险', secid: '', kind: 'stock', market: 'HK', sector: '金融', base: 72 },
  { code: 'hk00388', name: '香港交易所', secid: '', kind: 'stock', market: 'HK', sector: '金融', base: 380 },
  { code: 'hk02318', name: '中国平安', secid: '', kind: 'stock', market: 'HK', sector: '金融', base: 55 },
  // 能源通信
  { code: 'hk00941', name: '中国移动', secid: '', kind: 'stock', market: 'HK', sector: '能源通信', base: 80 },
  { code: 'hk00883', name: '中国海洋石油', secid: '', kind: 'stock', market: 'HK', sector: '能源通信', base: 20 },
  { code: 'hk00386', name: '中国石油化工', secid: '', kind: 'stock', market: 'HK', sector: '能源通信', base: 5 },
  { code: 'hk00857', name: '中国石油股份', secid: '', kind: 'stock', market: 'HK', sector: '能源通信', base: 6 },
  // 医药生物
  { code: 'hk02269', name: '药明生物', secid: '', kind: 'stock', market: 'HK', sector: '医药生物', base: 54 },
  { code: 'hk01177', name: '中国生物制药', secid: '', kind: 'stock', market: 'HK', sector: '医药生物', base: 5 },
  { code: 'hk01801', name: '信达生物', secid: '', kind: 'stock', market: 'HK', sector: '医药生物', base: 80 },
  // 消费
  { code: 'hk06862', name: '海底捞', secid: '', kind: 'stock', market: 'HK', sector: '消费', base: 15 },
  { code: 'hk02020', name: '安踏体育', secid: '', kind: 'stock', market: 'HK', sector: '消费', base: 60 },
  // 汽车
  { code: 'hk01211', name: '比亚迪股份', secid: '', kind: 'stock', market: 'HK', sector: '汽车', base: 74 },
  { code: 'hk02015', name: '理想汽车', secid: '', kind: 'stock', market: 'HK', sector: '汽车', base: 80 },
  { code: 'hk09868', name: '小鹏汽车', secid: '', kind: 'stock', market: 'HK', sector: '汽车', base: 40 },
  // 地产建筑
  { code: 'hk01109', name: '华润置地', secid: '', kind: 'stock', market: 'HK', sector: '地产建筑', base: 25 },
  { code: 'hk00016', name: '新鸿基地产', secid: '', kind: 'stock', market: 'HK', sector: '地产建筑', base: 80 },
  { code: 'hk00688', name: '中国海外发展', secid: '', kind: 'stock', market: 'HK', sector: '地产建筑', base: 13 },

  // ---- 美股指数（腾讯美股 K 线仅返回最新 1 根，主源直接走东财；新浪为备份） ----
  { code: 'usDJI', name: '道琼斯', secid: '100.DJIA', sina: '.DJI', yahoo: '^DJI', kind: 'index', market: 'US', preferSource: 'eastmoney', base: 43000 },
  { code: 'usINX', name: '标普500', secid: '100.SPX', sina: '.INX', yahoo: '^GSPC', kind: 'index', market: 'US', preferSource: 'eastmoney', base: 6800 },
  { code: 'usIXIC', name: '纳斯达克', secid: '100.NDX', sina: '.IXIC', yahoo: '^IXIC', kind: 'index', market: 'US', preferSource: 'eastmoney', base: 24000 },

  // ---- 美股行业 ETF（SPDR 11 大行业，新浪源可取，腾讯/东财个股 ETF 不可得） ----
  { code: 'usXLF', name: '美股金融ETF', secid: '', sina: 'XLF', yahoo: 'XLF', kind: 'etf', market: 'US', sector: '金融', base: 55 },
  { code: 'usXLK', name: '美股科技ETF', secid: '', sina: 'XLK', yahoo: 'XLK', kind: 'etf', market: 'US', sector: '科技', base: 220 },
  { code: 'usXLE', name: '美股能源ETF', secid: '', sina: 'XLE', yahoo: 'XLE', kind: 'etf', market: 'US', sector: '能源', base: 90 },
  { code: 'usXLV', name: '美股医疗ETF', secid: '', sina: 'XLV', yahoo: 'XLV', kind: 'etf', market: 'US', sector: '医疗', base: 140 },
  { code: 'usXLI', name: '美股工业ETF', secid: '', sina: 'XLI', yahoo: 'XLI', kind: 'etf', market: 'US', sector: '工业', base: 150 },
  { code: 'usXLP', name: '美股必需消费ETF', secid: '', sina: 'XLP', yahoo: 'XLP', kind: 'etf', market: 'US', sector: '必需消费', base: 80 },
  { code: 'usXLU', name: '美股公用事业ETF', secid: '', sina: 'XLU', yahoo: 'XLU', kind: 'etf', market: 'US', sector: '公用事业', base: 80 },
  { code: 'usXLB', name: '美股原材料ETF', secid: '', sina: 'XLB', yahoo: 'XLB', kind: 'etf', market: 'US', sector: '原材料', base: 100 },
  { code: 'usXLC', name: '美股通信服务ETF', secid: '', sina: 'XLC', yahoo: 'XLC', kind: 'etf', market: 'US', sector: '通信服务', base: 100 },
  { code: 'usXLRE', name: '美股房地产ETF', secid: '', sina: 'XLRE', yahoo: 'XLRE', kind: 'etf', market: 'US', sector: '房地产', base: 40 },

  // ---- 日股指数（无腾讯源，主源直接走东财；Yahoo 兜底） ----
  { code: 'jpN225', name: '日经225', secid: '100.N225', yahoo: '^N225', kind: 'index', market: 'JP', preferSource: 'eastmoney', base: 68000 },

  // ---- 韩股（Naver 源：指数 + 龙头个股） ----
  { code: 'krKOSPI', name: '韩国综合指数', secid: '', naver: 'KOSPI', kind: 'index', market: 'KR', preferSource: 'naver', base: 7000 },
  { code: 'krKOSDAQ', name: '韩国高斯达克', secid: '', naver: 'KOSDAQ', kind: 'index', market: 'KR', preferSource: 'naver', base: 900 },
  // 半导体
  { code: 'kr005930', name: '三星电子', secid: '', naver: '005930', kind: 'stock', market: 'KR', sector: '半导体', base: 263000 },
  { code: 'kr000660', name: 'SK海力士', secid: '', naver: '000660', kind: 'stock', market: 'KR', sector: '半导体', base: 1690000 },
  // 汽车
  { code: 'kr005380', name: '现代汽车', secid: '', naver: '005380', kind: 'stock', market: 'KR', sector: '汽车', base: 250000 },
  { code: 'kr012330', name: '现代摩比斯', secid: '', naver: '012330', kind: 'stock', market: 'KR', sector: '汽车', base: 250000 },
  // 电池新能源
  { code: 'kr373220', name: 'LG新能源', secid: '', naver: '373220', kind: 'stock', market: 'KR', sector: '电池', base: 400000 },
  { code: 'kr006400', name: '三星SDI', secid: '', naver: '006400', kind: 'stock', market: 'KR', sector: '电池', base: 300000 },
  // 金融
  { code: 'kr105560', name: 'KB金融', secid: '', naver: '105560', kind: 'stock', market: 'KR', sector: '金融', base: 163000 },
  { code: 'kr055550', name: '新韩金融', secid: '', naver: '055550', kind: 'stock', market: 'KR', sector: '金融', base: 60000 },
  // 医药生物
  { code: 'kr207940', name: '三星生物制剂', secid: '', naver: '207940', kind: 'stock', market: 'KR', sector: '医药生物', base: 1000000 },
  { code: 'kr068270', name: 'Celltrion', secid: '', naver: '068270', kind: 'stock', market: 'KR', sector: '医药生物', base: 180000 },
  // 互联网
  { code: 'kr035420', name: 'NAVER', secid: '', naver: '035420', kind: 'stock', market: 'KR', sector: '互联网', base: 183000 },
  { code: 'kr035720', name: 'Kakao', secid: '', naver: '035720', kind: 'stock', market: 'KR', sector: '互联网', base: 60000 },
  // 钢铁化工
  { code: 'kr005490', name: 'POSCO控股', secid: '', naver: '005490', kind: 'stock', market: 'KR', sector: '钢铁化工', base: 350000 },
  { code: 'kr051910', name: 'LG化学', secid: '', naver: '051910', kind: 'stock', market: 'KR', sector: '钢铁化工', base: 300000 },

  // ---- 资产配置 ETF（风险平价组合，含跨境 QDII） ----
  { code: 'sh510300', name: '沪深300ETF', secid: '1.510300', kind: 'etf', market: 'CN', base: 4.0 },
  { code: 'sh510880', name: '红利ETF', secid: '1.510880', kind: 'etf', market: 'CN', base: 3.0 },
  { code: 'sh588000', name: '科创50ETF', secid: '1.588000', kind: 'etf', market: 'CN', base: 1.1 },
  { code: 'sz159915', name: '创业板ETF', secid: '0.159915', kind: 'etf', market: 'CN', base: 2.0 },
  { code: 'sz159920', name: '恒生ETF', secid: '0.159920', kind: 'etf', market: 'CN', base: 1.4 },
  { code: 'sz159941', name: '纳指ETF', secid: '0.159941', kind: 'etf', market: 'CN', base: 1.7 },
  { code: 'sh513500', name: '标普500ETF', secid: '1.513500', kind: 'etf', market: 'CN', base: 2.7 },
  { code: 'sh513520', name: '日经ETF', secid: '1.513520', kind: 'etf', market: 'CN', base: 2.3 },
  { code: 'sh511010', name: '国债ETF', secid: '1.511010', kind: 'bond', market: 'CN', base: 110 },
  { code: 'sh518880', name: '黄金ETF', secid: '1.518880', kind: 'gold', market: 'CN', base: 5.5 },
  { code: 'sh513100', name: '纳指ETF', secid: '1.513100', kind: 'overseas', market: 'CN', base: 1.8 },
  { code: 'sz159985', name: '豆粕ETF', secid: '0.159985', kind: 'commodity', market: 'CN', base: 2.1 },

  // ---- 行业 ETF（PCA 统计套利篮子） ----
  { code: 'sh512880', name: '证券ETF', secid: '1.512880', kind: 'industry', market: 'CN', base: 1.1 },
  { code: 'sh512690', name: '酒ETF', secid: '1.512690', kind: 'industry', market: 'CN', base: 0.8 },
  { code: 'sh512170', name: '医疗ETF', secid: '1.512170', kind: 'industry', market: 'CN', base: 0.5 },
  { code: 'sh515790', name: '光伏ETF', secid: '1.515790', kind: 'industry', market: 'CN', base: 0.8 },
  { code: 'sh512660', name: '军工ETF', secid: '1.512660', kind: 'industry', market: 'CN', base: 1.2 },
  { code: 'sz159928', name: '消费ETF', secid: '0.159928', kind: 'industry', market: 'CN', base: 1.0 },
  { code: 'sh512480', name: '半导体ETF', secid: '1.512480', kind: 'industry', market: 'CN', base: 1.0 },
  { code: 'sh512800', name: '银行ETF', secid: '1.512800', kind: 'industry', market: 'CN', base: 1.5 },
  { code: 'sh515030', name: '新能源车ETF', secid: '1.515030', kind: 'industry', market: 'CN', base: 1.3 },
  { code: 'sh515050', name: '5G通信ETF', secid: '1.515050', kind: 'industry', market: 'CN', base: 1.1 }
];

/** 应用内唯一键索引（code 均非空） */
export const SYMBOL_MAP: Record<string, SymbolDef> = Object.fromEntries(SYMBOLS.map((s) => [s.code, s]));

export function getSymbol(code: string): SymbolDef | undefined {
  return SYMBOL_MAP[code];
}

/** 按市场分组的指数列表（基准下拉用） */
export function indicesByMarket(): { market: Market; label: string; items: SymbolDef[] }[] {
  return MARKETS.map((m) => ({
    market: m.market,
    label: m.label,
    items: SYMBOLS.filter((s) => s.kind === 'index' && s.market === m.market)
  })).filter((g) => g.items.length > 0);
}

/** 风险平价默认资产池 */
export const RP_DEFAULT = ['sh510300', 'sh511010', 'sh518880', 'sh513100', 'sz159985', 'sh510880'];
/** 风险平价可选池（含跨境 QDII 与港股龙头） */
export const RP_POOL = SYMBOLS.filter((s) => ['etf', 'bond', 'gold', 'overseas', 'commodity', 'stock'].includes(s.kind));
/** PCA 可选池：A 股行业 ETF + 跨境 QDII + 港股龙头 + 美股宽基与行业 ETF */
export const PCA_POOL = SYMBOLS.filter(
  (s) =>
    s.kind === 'industry' ||
    ['sz159920', 'sz159941', 'sh513500', 'sh513520'].includes(s.code) ||
    s.kind === 'stock' ||
    ['usDJI', 'usINX', 'usIXIC'].includes(s.code) ||
    (s.market === 'US' && s.kind === 'etf')
);
/** PCA 默认行业篮子 */
export const PCA_DEFAULT = ['sh512880', 'sh512690', 'sh512170', 'sh515790', 'sh512660', 'sz159928', 'sh512480', 'sh512800', 'sh515030', 'sh515050'];

/**
 * 各市场板块篮子预设。
 * 说明：港股市场几乎没有行业 ETF，板块暴露通过龙头个股实现；
 * 美股受数据源限制（个股 K 线不可得）只能用宽基指数构建「风格」篮子
 * （纳指=成长、标普=均衡、道指=价值）；日股仅宽基；韩国无历史数据源。
 */
export const BASKET_PRESETS: { key: string; label: string; desc: string; codes: string[] }[] = [
  {
    key: 'cn-industry',
    label: 'A股行业',
    desc: '10 只行业 ETF：证券/酒/医疗/光伏/军工/消费/半导体/银行/新能源车/5G',
    codes: PCA_DEFAULT
  },
  {
    key: 'hk-leaders',
    label: '港股龙头',
    desc: '26 只港股龙头按 7 大板块分组（科技/金融/能源通信/医药/消费/汽车/地产）',
    codes: SYMBOLS.filter((s) => s.market === 'HK' && s.kind === 'stock').map((s) => s.code)
  },
  {
    key: 'us-style',
    label: '美股风格',
    desc: '纳指(成长)/标普500(均衡)/道指(价值)——三大宽基',
    codes: ['usIXIC', 'usINX', 'usDJI']
  },
  {
    key: 'us-sectors',
    label: '美股行业',
    desc: 'SPDR 11 大行业 ETF（金融/科技/能源/医疗/工业/必需消费/公用/原材料/通信/房地产）——新浪源',
    codes: SYMBOLS.filter((s) => s.market === 'US' && s.kind === 'etf').map((s) => s.code)
  },
  {
    key: 'kr-leaders',
    label: '韩国龙头',
    desc: '14 只韩股龙头按 7 大板块（半导体/汽车/电池/金融/医药/互联网/钢铁化工）——Naver 源',
    codes: SYMBOLS.filter((s) => s.market === 'KR' && s.kind === 'stock').map((s) => s.code)
  },
  {
    key: 'cross-market',
    label: '跨市场混合',
    desc: 'A股300/科创50 + 恒指/恒生科技 + 标普/纳指 + 日经 + 韩国综合：宏观因子结构',
    codes: ['sh000300', 'sh000688', 'hkHSI', 'hkHSTECH', 'usINX', 'usIXIC', 'jpN225', 'krKOSPI']
  }
];

/** 港股龙头按板块分组（UI 展示用） */
export function hkSectorGroups(): { sector: string; items: SymbolDef[] }[] {
  const stocks = SYMBOLS.filter((s) => s.market === 'HK' && s.kind === 'stock');
  const sectors = [...new Set(stocks.map((s) => s.sector ?? '其他'))];
  return sectors.map((sector) => ({ sector, items: stocks.filter((s) => (s.sector ?? '其他') === sector) }));
}
/** 股债性价比代理用的债券 ETF */
export const BOND_ETF = 'sh511010';

/**
 * 因子模型的债券参考：仅 A 股基准使用本国国债 ETF，
 * 境外基准没有对应债券源，返回 null 时「股债相对动量」因子自动剔除。
 */
export function bondRefFor(market: 'CN' | 'HK' | 'US' | 'JP' | 'KR' | 'TW', bondBars: Bar[] | null | undefined): Bar[] | null {
  return market === 'CN' ? bondBars ?? null : null;
}

/** 策略速览默认扫描清单（每市场取代表性指数） */
export const SCAN_DEFAULT = [
  'sh000300',
  'sh000688',
  'hkHSI',
  'hkHSTECH',
  'usINX',
  'usIXIC',
  'usDJI',
  'jpN225',
  'krKOSPI'
];
