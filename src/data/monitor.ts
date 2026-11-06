/**
 * 实时监控的数据层
 *
 *   ┌ 实时报价 ── 腾讯 qt.gtimg.cn/q=...（一条请求批量拿 A/港/美/日/韩，GBK 编码）
 *   ├ 快讯增量 ── 财联社电报（复用 data/cls.ts 的签名实现）
 *   └ 公告增量 ── data/stockNews（按市场路由到东财 / SEC / Yahoo JP / Naver）
 *
 * 为什么用腾讯批量报价：东财 push2 批量接口拼不出日韩 secid，而腾讯的
 * `q=sh600519,hk00700,usAAPL,jp7203,kr005930` 五个市场一次返回、字段位置统一，
 * 是这里唯一能「全球市场 + 单请求」的方案。
 *
 * 快照（上一轮看到的快讯 ID / 公告 ID / 报价）会写入 localStorage：
 * 刷新页面后仍能对比出「关页面期间新增的消息」，而不是重新当基线吞掉。
 * 但报价快照超过 10 分钟就作废——隔夜价差不是「瞬时跳变」。
 */
import type { StockHit } from './search';
import type { NewsLike } from '../math/news';
import {
  DEFAULT_CONFIG,
  normalizeConfig,
  type MonitorConfig,
  type MonitorEvent,
  type Quote
} from '../math/monitor';

const K_CONFIG = 'mq:monitor:config:v1';
const K_TARGETS = 'mq:monitor:targets:v1';
const K_EVENTS = 'mq:monitor:events:v1';
const K_SEEN = 'mq:monitor:seen:v1';
const K_SNAPSHOT = 'mq:monitor:snapshot:v1';

export const MAX_EVENTS_STORED = 200;
/** 报价快照有效期：超过就重新建基线，避免隔夜价差被当成瞬时跳变 */
export const QUOTE_SNAPSHOT_TTL_MS = 10 * 60 * 1000;

export const DEFAULT_TARGETS: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股' },
  { code: 'hk00700', name: '腾讯控股', market: 'HK', marketLabel: '港股' },
  { code: 'usAAPL', name: '苹果', market: 'US', marketLabel: '美股' },
  { code: 'jp7203', name: '丰田汽车', market: 'JP', marketLabel: '日股' },
  { code: 'kr005930', name: '三星电子', market: 'KR', marketLabel: '韩股' }
];

/* ============ localStorage 小工具 ============ */

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* 隐私模式 / 配额不足：内存态仍可用 */
  }
}

export const loadConfig = (): MonitorConfig => normalizeConfig(readJson<Partial<MonitorConfig>>(K_CONFIG, {}));
export const saveConfig = (c: MonitorConfig): void => writeJson(K_CONFIG, c);

export const loadTargets = (): StockHit[] => {
  const arr = readJson<StockHit[]>(K_TARGETS, DEFAULT_TARGETS);
  return Array.isArray(arr) && arr.length ? arr.filter((x) => x && typeof x.code === 'string') : DEFAULT_TARGETS;
};
export const saveTargets = (t: StockHit[]): void => writeJson(K_TARGETS, t);

export const loadEvents = (): MonitorEvent[] => {
  const arr = readJson<MonitorEvent[]>(K_EVENTS, []);
  return Array.isArray(arr) ? arr.slice(0, MAX_EVENTS_STORED) : [];
};
export const saveEvents = (e: MonitorEvent[]): void => writeJson(K_EVENTS, e.slice(0, MAX_EVENTS_STORED));

export const loadSeen = (): Set<string> => new Set(readJson<string[]>(K_SEEN, []));
export const saveSeen = (s: Set<string>): void => writeJson(K_SEEN, [...s].slice(-2000));

export interface MonitorSnapshot {
  ts: number;
  /** 上一轮的完整快讯（diffNews 需要对象，不能只存 ID）；多源归一化后的结构兼容 NewsLike */
  news: NewsLike[];
  /** 跨源累积见过的快讯 ID（上限 500，防止主备源切换时刷屏） */
  newsIds: string[];
  /** 每个标的上一轮看到的公告 ID */
  annIds: Record<string, string[]>;
  quotes: Quote[];
}

export const loadSnapshot = (): MonitorSnapshot | null => {
  const s = readJson<MonitorSnapshot | null>(K_SNAPSHOT, null);
  if (!s || typeof s.ts !== 'number') return null;
  return {
    ts: s.ts,
    news: Array.isArray(s.news) ? s.news : [],
    newsIds: Array.isArray(s.newsIds) ? s.newsIds : [],
    annIds: s.annIds && typeof s.annIds === 'object' ? s.annIds : {},
    quotes: Array.isArray(s.quotes) && Date.now() - s.ts <= QUOTE_SNAPSHOT_TTL_MS ? s.quotes : []
  };
};
export const saveSnapshot = (s: MonitorSnapshot): void => writeJson(K_SNAPSHOT, s);

export function clearMonitorStorage(): void {
  try {
    [K_EVENTS, K_SEEN, K_SNAPSHOT].forEach((k) => window.localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/* ============ 市场与币种 ============ */

export function marketOfCode(code: string): Quote['market'] | null {
  const c = String(code ?? '').trim();
  if (/^(sh|sz|bj)\d{6}$/i.test(c)) return 'CN';
  if (/^hk\d{5}$/i.test(c)) return 'HK';
  if (/^us[A-Za-z][A-Za-z.-]*$/i.test(c)) return 'US';
  if (/^jp\d{4,5}$/i.test(c)) return 'JP';
  if (/^kr\d{6}$/i.test(c)) return 'KR';
  return null;
}

const CURRENCY: Record<Quote['market'], string> = {
  CN: '元',
  HK: '港元',
  US: '美元',
  JP: '日元',
  KR: '韩元'
};

/* ============ 腾讯批量报价解析（纯函数，便于测试） ============ */

const num = (v: string | undefined): number => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) ? n : 0;
};

/**
 * 解析 `v_sh600519="1~名称~代码~现价~昨收~今开~成交量~…~时间~涨跌额~涨跌幅~最高~最低~…"`。
 * 五个市场的字段位置一致（实测 2026-11）：30=时间、31=涨跌额、32=涨跌幅、33=最高、34=最低。
 * 日韩返回的涨跌幅带 6 位小数，统一保留 2 位。
 */
export function parseTencentQuotes(text: string, codes: string[]): Quote[] {
  const byVar = new Map<string, string[]>();
  for (const line of String(text ?? '').split(/[\r\n;]+/)) {
    const m = /v_([A-Za-z0-9._-]+)\s*=\s*"([^"]*)"/.exec(line);
    if (!m) continue;
    byVar.set(m[1], m[2].split('~'));
  }

  const out: Quote[] = [];
  for (const code of codes) {
    const a = byVar.get(code);
    if (!a || a.length < 35) continue;
    const market = marketOfCode(code);
    if (!market) continue;
    const price = num(a[3]);
    if (!(price > 0)) continue;
    out.push({
      code,
      name: a[1] || code,
      price,
      prevClose: num(a[4]),
      chgPct: Math.round(num(a[32]) * 100) / 100,
      high: num(a[33]),
      low: num(a[34]),
      volume: num(a[6]),
      time: a[30] || '',
      currency: CURRENCY[market],
      market
    });
  }
  return out;
}

/* ============ 多源请求 ============ */

/**
 * 单源请求已统一迁到 `data/monitorSources.ts`：
 * 所有外部请求都经过 `rateLimit.guardedFetch`，按 host 做最小间隔、每分钟预算、
 * 失败指数退避与冷却熔断；这里只保留解析、配置与快照持久化。
 */

/** 默认配置（导出给页面重置用） */
export const freshConfig = (): MonitorConfig => ({ ...DEFAULT_CONFIG, rules: { ...DEFAULT_CONFIG.rules } });
