/**
 * 数据源限流防护层
 *
 * 纯前端轮询最容易踩的坑不是「请求慢」，而是**被数据源判成机器人**：
 * 固定周期的并发请求、失败后的立即重试、非交易时段还在高频空转，都会触发
 * 429 / 403 / 连接重置，而一旦被封，整个页面的数据全断。
 *
 * 这里做五件事：
 *  1. 每个 host 独立的最小请求间隔 + 并发上限（令牌桶式排队）
 *  2. 每分钟请求预算，超了直接跳过本轮而不是硬发
 *  3. 429 / 5xx / 超时 → 指数退避 + 抖动 + 冷却熔断，冷却期内直接走缓存
 *  4. 非交易时段 / 后台标签页自动降频（纯函数，可测）
 *  5. 全局健康统计，供 UI 显示「哪个源在冷却、成功率多少」
 *
 * 设计原则：**宁可少拿一轮数据，也不要把源打挂**。所有失败都是可降级的，
 * 由调用方用上一轮快照兜底，不抛到界面上吓用户。
 */
import { px } from './sources/proxy';

/* ============ 策略 ============ */

export interface HostPolicy {
  /** 两次请求之间的最小间隔（毫秒） */
  minIntervalMs: number;
  /** 该 host 最大并发 */
  maxConcurrent: number;
  /** 每分钟最多请求次数 */
  perMinute: number;
}

/**
 * 间隔按「源的脆弱程度」分级：
 *  - 财联社签名接口最敏感，30s 起步
 *  - 腾讯 / 新浪 / 东财行情相对宽松，但仍留 8~15s
 *  - 公告类页面（StockAnalysis、SEC、Yahoo JP、Naver）最慢，60s 起步
 */
export const HOST_POLICY: Record<string, HostPolicy> = {
  'qt.gtimg.cn': { minIntervalMs: 10_000, maxConcurrent: 1, perMinute: 5 },
  'push2.eastmoney.com': { minIntervalMs: 15_000, maxConcurrent: 1, perMinute: 4 },
  'hq.sinajs.cn': { minIntervalMs: 12_000, maxConcurrent: 1, perMinute: 5 },
  'www.cls.cn': { minIntervalMs: 30_000, maxConcurrent: 1, perMinute: 2 },
  'zhibo.sina.com.cn': { minIntervalMs: 25_000, maxConcurrent: 1, perMinute: 3 },
  'np-listapi.eastmoney.com': { minIntervalMs: 25_000, maxConcurrent: 1, perMinute: 3 },
  'm.stock.naver.com': { minIntervalMs: 20_000, maxConcurrent: 1, perMinute: 3 },
  'api.stock.naver.com': { minIntervalMs: 20_000, maxConcurrent: 1, perMinute: 3 },
  'finance.yahoo.co.jp': { minIntervalMs: 30_000, maxConcurrent: 1, perMinute: 2 },
  'np-anotice-stock.eastmoney.com': { minIntervalMs: 60_000, maxConcurrent: 1, perMinute: 2 },
  'data.sec.gov': { minIntervalMs: 60_000, maxConcurrent: 1, perMinute: 2 },
  'www.sec.gov': { minIntervalMs: 60_000, maxConcurrent: 1, perMinute: 2 },
  'stockanalysis.com': { minIntervalMs: 60_000, maxConcurrent: 1, perMinute: 2 }
};

export const DEFAULT_POLICY: HostPolicy = { minIntervalMs: 20_000, maxConcurrent: 1, perMinute: 3 };
export const policyOf = (host: string): HostPolicy => HOST_POLICY[host] ?? DEFAULT_POLICY;

/* ============ 纯函数：退避 / 降频 / 交易时段 ============ */

/** 失败退避：2^n 指数 + 最多 25% 抖动，封顶 5 分钟 */
export function backoffMs(failures: number, baseMs = 15_000, capMs = 300_000, jitter = 0): number {
  const n = Math.max(0, Math.min(8, failures));
  const raw = Math.min(capMs, baseMs * 2 ** n);
  return Math.round(raw * (1 + jitter * 0.25));
}

/** 每分钟预算是否还有余额 */
export function withinBudget(timestamps: number[], policy: HostPolicy, now = Date.now()): boolean {
  const recent = timestamps.filter((t) => now - t < 60_000);
  return recent.length < policy.perMinute;
}

/** 距下次可用还需等多少毫秒（考虑最小间隔 + 预算 + 冷却） */
export function waitMs(
  lastAt: number,
  cooldownUntil: number,
  policy: HostPolicy,
  now = Date.now()
): number {
  const gap = Math.max(0, lastAt + policy.minIntervalMs - now);
  const cool = Math.max(0, cooldownUntil - now);
  return Math.max(gap, cool);
}

/** 北京时间的星期与分钟（不依赖本机时区） */
function bjParts(now: number): { day: number; minute: number; month: number; date: number } {
  const d = new Date(now + 8 * 3600_000);
  return {
    day: d.getUTCDay(),
    minute: d.getUTCHours() * 60 + d.getUTCMinutes(),
    month: d.getUTCMonth() + 1,
    date: d.getUTCDate()
  };
}

/** 美股夏令时：3 月第二个周日 ~ 11 月第一个周日（北京时间判断足够近似） */
function isUsDst(now: number): boolean {
  const { month, date, day } = bjParts(now);
  if (month > 3 && month < 11) return true;
  if (month < 3 || month > 11) return false;
  // 当月 1 号的星期（0=周日）→ 第一个周日 → 第二个周日
  const weekdayOfFirst = (((day - (date - 1)) % 7) + 7) % 7;
  const firstSunday = 1 + ((7 - weekdayOfFirst) % 7);
  if (month === 3) return date >= firstSunday + 7;
  return date < firstSunday; // 11 月第一个周日结束
}

/** 各市场常规交易时段（北京时间，分钟） */
const SESSIONS: Record<string, [number, number][]> = {
  CN: [[555, 690], [780, 905]],
  HK: [[555, 725], [780, 975]],
  JP: [[480, 630], [690, 840]],
  KR: [[480, 870]],
  US: [[1290, 1440], [0, 300]] // 夏令时；冬令时整体后移 60 分钟
};

export function isTradingNow(market: string, now = Date.now()): boolean {
  const { day, minute } = bjParts(now);
  if (day === 0 || day === 6) return day === 6 && minute < 300 && market === 'US'; // 周六凌晨延续周五美股
  const sessions = SESSIONS[market] ?? SESSIONS.CN;
  if (market === 'US' && !isUsDst(now)) {
    // 冬令时：22:30~24:00、00:00~05:00
    return minute >= 1350 || minute < 300;
  }
  return sessions.some(([a, b]) => minute >= a && minute <= b);
}

/**
 * 间隔倍率：休市 / 后台标签页都会拉长轮询。
 * 返回 1 = 正常；3 = 休市；4 = 后台；同时命中取较大值。
 */
export function intervalFactor(markets: string[], hidden: boolean, now = Date.now()): number {
  const trading = markets.some((m) => isTradingNow(m, now));
  const session = trading ? 1 : 3;
  return Math.max(session, hidden ? 4 : 1);
}

export function effectiveInterval(baseSec: number, factor: number, capSec = 3600): number {
  return Math.min(capSec, Math.max(10, Math.round(baseSec * factor)));
}

/* ============ 运行时状态 ============ */

export interface HostStat {
  host: string;
  requests: number;
  failures: number;
  throttled: number;
  lastAt: number;
  cooldownUntil: number;
  consecutiveFailures: number;
  lastLatency: number;
  lastError: string;
}

interface HostRuntime extends HostStat {
  inflight: number;
  recent: number[];
  queue: (() => void)[];
}

const runtime = new Map<string, HostRuntime>();

function stateOf(host: string): HostRuntime {
  let s = runtime.get(host);
  if (!s) {
    s = {
      host,
      requests: 0,
      failures: 0,
      throttled: 0,
      lastAt: 0,
      cooldownUntil: 0,
      consecutiveFailures: 0,
      lastLatency: 0,
      lastError: '',
      inflight: 0,
      recent: [],
      queue: []
    };
    runtime.set(host, s);
  }
  return s;
}

export function getStats(): HostStat[] {
  return [...runtime.values()]
    .map(({ queue: _q, inflight: _i, recent: _r, ...stat }) => ({ ...stat }))
    .sort((a, b) => a.host.localeCompare(b.host));
}

export function resetStats(): void {
  runtime.clear();
}

/**
 * 供「暂时无法改造底层 fetch」的数据源（个股公告适配器）做前置熔断判断。
 * 这些适配器内部仍用自己的 fetch，但监控层在调用前先问一句「现在能不能发」，
 * 冷却中或预算耗尽就直接复用上一轮结果，从源头减少请求。
 */
export function canRequest(host: string, now = Date.now()): boolean {
  const s = stateOf(host);
  if (s.cooldownUntil > now) return false;
  s.recent = s.recent.filter((t) => now - t < 60_000);
  return withinBudget(s.recent, policyOf(host), now);
}

/** 公告类适配器走自己的 fetch，由监控层代为记账：成功 */
export function noteSuccess(host: string, latencyMs = 0): void {
  const s = stateOf(host);
  s.requests += 1;
  s.lastAt = Date.now();
  s.recent.push(s.lastAt);
  s.lastLatency = latencyMs;
  s.consecutiveFailures = 0;
  s.cooldownUntil = 0;
  s.lastError = '';
}

/** 失败：累加连续失败并进入指数退避冷却 */
export function noteFailure(host: string, error: unknown): void {
  const s = stateOf(host);
  s.failures += 1;
  s.consecutiveFailures += 1;
  s.lastAt = Date.now();
  s.recent.push(s.lastAt);
  s.lastError = error instanceof Error ? error.message : String(error);
  s.cooldownUntil = Date.now() + backoffMs(s.consecutiveFailures - 1, 15_000, 300_000, Math.random());
}

export class BudgetSkipped extends Error {
  constructor(public host: string, public retryAfterMs: number) {
    super(`数据源 ${host} 处于限流保护，${Math.ceil(retryAfterMs / 1000)}s 后再试`);
    this.name = 'BudgetSkipped';
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 占一个并发槽，用完释放并唤醒队列 */
async function acquire(s: HostRuntime, policy: HostPolicy): Promise<void> {
  while (s.inflight >= policy.maxConcurrent) {
    await new Promise<void>((resolve) => s.queue.push(resolve));
  }
  s.inflight += 1;
}

function release(s: HostRuntime): void {
  s.inflight = Math.max(0, s.inflight - 1);
  const next = s.queue.shift();
  if (next) next();
}

/**
 * 带防护的请求。返回 Response；被预算/冷却拦下时抛 BudgetSkipped（调用方应走缓存）。
 *
 * 判定「限流」的依据：HTTP 429 / 403 / 5xx、超时（AbortError）、或返回体里
 * 出现常见的反爬文案。命中后连续失败次数累加，冷却按指数退避拉长。
 */
export async function guardedFetch(
  host: string,
  path: string,
  init: RequestInit = {},
  timeoutMs = 12_000
): Promise<Response> {
  const policy = policyOf(host);
  const s = stateOf(host);
  const now = Date.now();

  // 冷却 / 每分钟预算：直接跳过，不发请求
  if (s.cooldownUntil > now) {
    s.throttled += 1;
    throw new BudgetSkipped(host, s.cooldownUntil - now);
  }
  s.recent = s.recent.filter((t) => now - t < 60_000);
  if (!withinBudget(s.recent, policy, now)) {
    s.throttled += 1;
    throw new BudgetSkipped(host, 60_000 - (now - s.recent[0]));
  }

  await acquire(s, policy);
  try {
    // 排队期间可能已被别的请求推进了时间，重新等最小间隔
    const wait = waitMs(s.lastAt, s.cooldownUntil, policy, Date.now());
    if (wait > 0) await sleep(wait);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(px(host, path), {
        ...init,
        signal: ctrl.signal,
        headers: { Accept: '*/*', ...(init.headers ?? {}) }
      });
      s.requests += 1;
      s.lastAt = Date.now();
      s.recent.push(s.lastAt);
      s.lastLatency = s.lastAt - started;
      if (res.status === 429 || res.status === 403 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      s.consecutiveFailures = 0;
      s.cooldownUntil = 0;
      s.lastError = '';
      return res;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    s.failures += 1;
    s.consecutiveFailures += 1;
    s.lastAt = Date.now();
    s.recent.push(s.lastAt);
    s.lastError = e instanceof Error ? e.message : String(e);
    // 指数退避 + 抖动；Math.random 只用于抖动，不影响正确性
    s.cooldownUntil = Date.now() + backoffMs(s.consecutiveFailures - 1, 15_000, 300_000, Math.random());
    throw e;
  } finally {
    release(s);
  }
}

/** 便捷：GBK 文本（腾讯 / 新浪报价用） */
export async function guardedGbk(host: string, path: string, headers?: Record<string, string>): Promise<string> {
  const res = await guardedFetch(host, path, { headers });
  const buf = await res.arrayBuffer();
  return new TextDecoder('gbk').decode(buf);
}

/** 便捷：JSON */
export async function guardedJson<T>(host: string, path: string, headers?: Record<string, string>): Promise<T> {
  const res = await guardedFetch(host, path, { headers });
  return (await res.json()) as T;
}
