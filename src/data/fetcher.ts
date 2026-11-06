import type { Bar, DataSource, SymbolDef } from './types';
import { sourceChain } from './sources/registry';
import { loadCache, saveCache } from './cache';
import { genSyntheticBars } from './synthetic';

export interface KlineResult {
  bars: Bar[];
  source: DataSource;
  /** 走缓存时的写入时间戳（毫秒），用于保鲜提示 */
  cacheTs?: number;
  /** 全部实时源与缓存均失败、且未回退模拟数据时为 true */
  failed?: boolean;
  /** 本次尝试过的数据源 id（用于失败提示） */
  attempts?: string[];
}

const MIN_BARS = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 后台刷新中的标的（避免重复触发） */
const refreshing = new Set<string>();

/**
 * 熔断器：某源连续失败达到阈值后冷却一段时间，避免每次都等满超时
 * （例如某域名在当前网络被系统性阻断时，能秒切到备用源）
 */
const FAIL_THRESHOLD = 2;
const COOLDOWN_MS = 5 * 60 * 1000;
const breaker = new Map<string, { fails: number; until: number }>();

function isOpen(id: string): boolean {
  return (breaker.get(id)?.until ?? 0) > Date.now();
}
function recordSuccess(id: string): void {
  breaker.delete(id);
}
function recordFailure(id: string): void {
  const cur = breaker.get(id) ?? { fails: 0, until: 0 };
  cur.fails++;
  if (cur.fails >= FAIL_THRESHOLD) cur.until = Date.now() + COOLDOWN_MS;
  breaker.set(id, cur);
}

/**
 * 降级取数链（按标的解析源顺序）：
 *   主源（腾讯/东财/Naver，可多源互为备用，各最多 4 次尝试退避重试）
 *   → localStorage 缓存 → 内置 GBM 模拟（DEMO）
 *
 * onLive：走缓存/DEMO 时回调传入，用于「后台自愈刷新」——
 * 立即返回旧数据保证页面可用，同时后台持续尝试实时源，
 * 网络恢复后自动更新并翻转数据源徽标。
 */
export async function fetchKline(
  sym: SymbolDef,
  days: number,
  onLive?: (bars: Bar[], source: DataSource) => void,
  allowDemo = true
): Promise<KlineResult> {
  const attempts: string[] = [];
  const chain = sourceChain(sym).filter((s) => !isOpen(s.id));
  for (let si = 0; si < chain.length; si++) {
    const src = chain[si];
    // 首选源给 3 次退避重试（抗抖动）；备份源只试 1 次，快速切换
    const tries = si === 0 ? 3 : 1;
    for (let attempt = 0; attempt < tries; attempt++) {
      try {
        const bars = await src.fetch(sym, days);
        if (bars.length >= MIN_BARS) {
          recordSuccess(src.id);
          saveCache(sym.code, bars);
          refreshing.delete(sym.code);
          return { bars, source: src.id };
        }
        break; // 数据量不足是源本身不含该标的，重试无意义
      } catch {
        if (attempt < tries - 1) await sleep(500 * 2 ** attempt);
      }
    }
    recordFailure(src.id); // 走到这里说明该源本次未取到数据
    attempts.push(src.id);
  }
  const cached = loadCache(sym.code);
  if (cached && cached.bars.length >= MIN_BARS) {
    if (onLive) scheduleBackgroundRefresh(sym, days, onLive);
    return { bars: cached.bars, source: 'cache', cacheTs: cached.ts };
  }
  // 个股分析等场景禁止模拟数据：明确失败，由调用方提示用户
  if (!allowDemo) return { bars: [], source: 'demo', failed: true, attempts };
  return { bars: genSyntheticBars(sym, days), source: 'demo', attempts };
}

/** 后台自愈刷新：15s / 60s / 180s 三次尝试，成功即回调 */
function scheduleBackgroundRefresh(
  sym: SymbolDef,
  days: number,
  onLive: (bars: Bar[], source: DataSource) => void
): void {
  if (refreshing.has(sym.code)) return;
  refreshing.add(sym.code);
  const delays = [15000, 60000, 180000];
  const attempt = async (i: number) => {
    if (i >= delays.length) {
      refreshing.delete(sym.code);
      return;
    }
    await sleep(delays[i]);
    for (const src of sourceChain(sym)) {
      try {
        const bars = await src.fetch(sym, days);
        if (bars.length >= MIN_BARS) {
          saveCache(sym.code, bars);
          refreshing.delete(sym.code);
          onLive(bars, src.id);
          return;
        }
        break;
      } catch {
        /* 继续下一源 / 下一轮 */
      }
    }
    void attempt(i + 1);
  };
  void attempt(0);
}
