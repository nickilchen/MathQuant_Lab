/**
 * 自选池与最近访问（纯前端 localStorage）
 *
 * 关键约定：自选项必须持久化完整的 StockHit（含各数据源代码映射），
 * 只存 code 会导致注册后无源可处理而静默降级到模拟数据。
 */
import type { StockHit } from './search';

export const WATCH_KEY = 'mql-watchlist-v1';
export const RECENT_KEY = 'mql-recent-v1';
export const MAX_WATCH = 30;
export const MAX_RECENT = 8;

export function isWatched(items: StockHit[], code: string): boolean {
  return items.some((i) => i.code === code);
}

/** 加入自选（按 code 去重，超出上限截断） */
export function addWatchlist(items: StockHit[], hit: StockHit): StockHit[] {
  if (isWatched(items, hit.code)) return items;
  const next = [...items, hit];
  return next.length > MAX_WATCH ? next.slice(0, MAX_WATCH) : next;
}

export function removeWatchlist(items: StockHit[], code: string): StockHit[] {
  return items.filter((i) => i.code !== code);
}

/** 最近访问：置顶去重，最多 MAX_RECENT 条 */
export function pushRecent(items: StockHit[], hit: StockHit): StockHit[] {
  return [hit, ...items.filter((i) => i.code !== hit.code)].slice(0, MAX_RECENT);
}

function validHit(x: unknown): x is StockHit {
  if (!x || typeof x !== 'object') return false;
  const h = x as Partial<StockHit>;
  return (
    typeof h.code === 'string' &&
    h.code.length > 0 &&
    typeof h.name === 'string' &&
    typeof h.market === 'string' &&
    typeof h.marketLabel === 'string'
  );
}

function readList(key: string): StockHit[] {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter(validHit) : [];
  } catch {
    return [];
  }
}

function writeList(key: string, items: StockHit[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(items));
  } catch {
    /* 隐私模式下写入失败可忽略：本会话内状态仍可用 */
  }
}

export const loadWatchlist = (): StockHit[] => readList(WATCH_KEY);
export const saveWatchlist = (items: StockHit[]): void => writeList(WATCH_KEY, items);
export const loadRecent = (): StockHit[] => readList(RECENT_KEY);
export const saveRecent = (items: StockHit[]): void => writeList(RECENT_KEY, items);
