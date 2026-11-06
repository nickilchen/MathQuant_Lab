import type { Bar } from './types';

const PREFIX = 'mq:kline:';

/** 缓存最多保留最近 1000 根，控制 localStorage 占用（长回看周期下） */
const MAX_CACHED_BARS = 1000;

export function saveCache(code: string, bars: Bar[]): void {
  try {
    const trimmed = bars.length > MAX_CACHED_BARS ? bars.slice(-MAX_CACHED_BARS) : bars;
    localStorage.setItem(PREFIX + code, JSON.stringify({ ts: Date.now(), bars: trimmed }));
  } catch {
    /* 配额超限时静默失败 */
  }
}

/** 返回缓存行情及其写入时间戳（用于保鲜提示） */
export function loadCache(code: string, maxAgeDays = 7): { bars: Bar[]; ts: number } | null {
  try {
    const raw = localStorage.getItem(PREFIX + code);
    if (!raw) return null;
    const { ts, bars } = JSON.parse(raw) as { ts: number; bars: Bar[] };
    if (!Array.isArray(bars) || bars.length < 30) return null;
    if (Date.now() - ts > maxAgeDays * 864e5) return null;
    return { bars, ts };
  } catch {
    return null;
  }
}
