/**
 * 分时数据（腾讯行情 web.ifzq.gtimg.cn）
 *
 * 接口：/appstock/app/minute/query?code=sh600519
 *   data[code].data.data = ["HHmm 价格 累计成交量 累计成交额", ...]
 *   data[code].qt[code]  = [_, 名称, 代码, 现价, 昨收, 今开, ..., 最高, 最低, ...]
 *
 * 两个必须处理的坑：
 *  1. 累计成交量的单位 A 股是「手」，港股是「股」——均价 = 额/(量×unit)，
 *     unit 靠「额/量 与现价的比值」自动推断（≈100 就是手，≈1 就是股）；
 *  2. 非交易时段接口返回最近一个交易日的数据，所以不要假定「今天」。
 */
import { px } from './sources/proxy';

const HOST = 'web.ifzq.gtimg.cn';
const CACHE_TTL_MS = 2 * 60 * 1000;

export interface MinutePoint {
  /** HH:mm */
  time: string;
  price: number;
  /** 累计成交量（原始单位） */
  volume: number;
  /** 累计成交额（元/本币） */
  amount: number;
  /** 分时均价（VWAP） */
  vwap: number;
}

export interface IntradaySnapshot {
  code: string;
  name: string;
  /** YYYYMMDD */
  date: string;
  points: MinutePoint[];
  prevClose: number;
  open: number;
  high: number;
  low: number;
  last: number;
}

interface TxResp {
  code?: number;
  data?: Record<
    string,
    {
      data?: { data?: string[]; date?: string };
      qt?: Record<string, string[]>;
    }
  >;
}

/** "0930" → "09:30" */
const hhmm = (s: string) => (s.length === 4 ? `${s.slice(0, 2)}:${s.slice(2)}` : s);

/** 判断成交量单位：额/量 ≈ 价格×100 → 手；≈ 价格 → 股 */
function volumeUnit(amount: number, volume: number, price: number): number {
  if (volume <= 0 || price <= 0) return 1;
  const ratio = amount / volume / price;
  return Math.abs(ratio - 100) < Math.abs(ratio - 1) ? 100 : 1;
}

export function parseIntraday(json: TxResp, code: string): IntradaySnapshot {
  const o = json?.data?.[code];
  const rows = o?.data?.data ?? [];
  if (!rows.length) throw new Error('分时数据为空');

  const qt = o?.qt?.[code] ?? [];
  const num = (i: number) => {
    const v = Number(qt[i]);
    return Number.isFinite(v) ? v : NaN;
  };

  // 先用第一个点的数值推断单位
  const first = String(rows[0]).trim().split(/\s+/);
  const unit = volumeUnit(Number(first[3]) || 0, Number(first[2]) || 0, Number(first[1]) || 0);

  const points: MinutePoint[] = [];
  for (const row of rows) {
    const p = String(row).trim().split(/\s+/);
    if (p.length < 4) continue;
    const price = Number(p[1]);
    const volume = Number(p[2]);
    const amount = Number(p[3]);
    if (!Number.isFinite(price) || price <= 0) continue;
    points.push({
      time: hhmm(p[0]),
      price,
      volume,
      amount,
      vwap: volume > 0 && amount > 0 ? amount / (volume * unit) : price
    });
  }
  if (!points.length) throw new Error('分时分时点解析失败');

  const prices = points.map((p) => p.price);
  const last = Number.isFinite(num(3)) && num(3) > 0 ? num(3) : prices[prices.length - 1];
  const prevClose = Number.isFinite(num(4)) && num(4) > 0 ? num(4) : prices[0];
  const open = Number.isFinite(num(5)) && num(5) > 0 ? num(5) : prices[0];
  const high = Number.isFinite(num(33)) && num(33) > 0 ? Math.max(num(33), ...prices) : Math.max(...prices);
  const low = Number.isFinite(num(34)) && num(34) > 0 ? Math.min(num(34), ...prices) : Math.min(...prices);

  return {
    code,
    name: qt[1] || code,
    date: String(o?.data?.date ?? ''),
    points,
    prevClose,
    open,
    high,
    low,
    last
  };
}

interface Cached {
  ts: number;
  data: IntradaySnapshot;
}

export async function fetchIntraday(code: string, force = false): Promise<IntradaySnapshot> {
  const key = `mq:intraday:v1:${code}`;
  if (!force) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const c = JSON.parse(raw) as Cached;
        if (c?.data?.points?.length && Date.now() - c.ts < CACHE_TTL_MS) return c.data;
      }
    } catch {
      /* 忽略 */
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let json: TxResp;
  try {
    const res = await fetch(px(HOST, `/appstock/app/minute/query?code=${encodeURIComponent(code)}`), {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    json = (await res.json()) as TxResp;
  } finally {
    clearTimeout(timer);
  }

  const data = parseIntraday(json, code);
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data } satisfies Cached));
  } catch {
    /* 忽略配额 */
  }
  return data;
}

/** 是否支持分时（腾讯接口覆盖 A 股与港股；美股/日韩返回空） */
export function canFetchIntraday(code: string): boolean {
  return /^(sh|sz|bj)\d{6}$/i.test(code) || /^hk\d{5}$/i.test(code);
}
