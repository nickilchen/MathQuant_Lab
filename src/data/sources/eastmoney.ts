/** 东财源：A 股 + 全球指数（100.*）+ 美股个股（105 纳斯达克 / 106 纽交所）；日股个股不服务 */
import type { Bar, FundFlow, SymbolDef } from '../types';
import type { KlineSource } from './types';
import { isBrowser, px } from './proxy';

const HIS = 'push2his.eastmoney.com';
const QT = 'push2.eastmoney.com';

/** 浏览器：直连优先，失败走本地代理 */
function urls(host: string, path: string): string[] {
  const direct = `https://${host}${path}`;
  return isBrowser ? [direct, px(host, path)] : [direct];
}

async function fetchFirst(host: string, path: string): Promise<unknown> {
  let lastErr: unknown = null;
  for (const url of urls(host, path)) {
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`http ${res.status}`);
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('unavailable');
}

/**
 * 解析 secid。
 *
 * symbols 表只给 A 股和指数填了 secid；美股个股（usAAPL）是搜索时动态注册的，
 * 没有 secid，但东财其实服务美股，只是要自己拼：105 = 纳斯达克、106 = 纽交所。
 * 先按 105 猜，空了再换 106——拼错的代价只是一次额外请求。
 */
function secidOf(sym: SymbolDef): string | null {
  if (sym.secid) return sym.secid;
  if (sym.market === 'US') {
    const m = /^us([A-Za-z][A-Za-z.-]*)$/i.exec(String(sym.code ?? ''));
    return m ? `105.${m[1].toUpperCase().replace(/\./g, '-')}` : null;
  }
  return null;
}

export const eastmoneySource: KlineSource = {
  id: 'eastmoney',
  label: '东方财富',
  canHandle: (sym) => !!secidOf(sym),
  async fetch(sym: SymbolDef, days: number): Promise<Bar[]> {
    const id = secidOf(sym);
    if (!id) throw new Error('no eastmoney secid');

    const load = async (secid: string) =>
      (await fetchFirst(
        HIS,
        `/api/qt/stock/kline/get?secid=${secid}&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&klt=101&fqt=1&beg=19900101&end=20500101&lmt=${days}`
      )) as { data?: { klines?: string[] } };

    let j = await load(id);
    if (!j?.data?.klines?.length && sym.market === 'US' && id.startsWith('105.')) {
      // 不是纳斯达克就试纽交所
      j = await load(id.replace(/^105\./, '106.'));
    }
    const klines = j?.data?.klines;
    if (!Array.isArray(klines) || klines.length === 0) throw new Error('eastmoney empty');
    const bars: Bar[] = [];
    for (const line of klines) {
      const p = line.split(',');
      if (p.length < 6) continue;
      const close = Number(p[2]);
      if (!(close > 0)) continue;
      bars.push({
        date: p[0],
        open: Number(p[1]),
        close,
        high: Number(p[3]),
        low: Number(p[4]),
        volume: Number(p[5]) || 0,
        amount: Number(p[6]) || Number(p[5]) * close || 0
      });
    }
    // 部分 secid（如 100.* 全球指数）会忽略 lmt 返回全量历史，此处统一截取最近 days 根
    return bars.slice(-days);
  }
};

/** 主力资金流（近 days 日，仅 A 股） */
export async function fetchEastmoneyFundFlow(sym: SymbolDef, days = 120): Promise<FundFlow[]> {
  if (!sym.secid) throw new Error('no eastmoney secid');
  const j = (await fetchFirst(
    HIS,
    `/api/qt/stock/fflow/daykline/get?secid=${sym.secid}&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58&lmt=${days}`
  )) as { data?: { klines?: string[] } };
  const klines = j?.data?.klines;
  if (!Array.isArray(klines) || klines.length === 0) throw new Error('fflow empty');
  const out: FundFlow[] = [];
  for (const line of klines) {
    const p = line.split(',');
    if (p.length < 2 || !p[0]) continue;
    out.push({ date: p[0], main: Number(p[1]) || 0, large: Number(p[4]) || 0, xlarge: Number(p[5]) || 0 });
  }
  return out;
}

/** 估值快照：PE(TTM) 与 PB，失败返回 null */
export async function fetchEastmoneyValuation(sym: SymbolDef): Promise<{ pe: number | null; pb: number | null }> {
  if (!sym.secid) throw new Error('no eastmoney secid');
  const j = (await fetchFirst(
    QT,
    `/api/qt/stock/get?secid=${sym.secid}&fields=f43,f57,f58,f162,f164,f167`
  )) as { data?: Record<string, unknown> };
  const d = j?.data;
  if (!d) throw new Error('val empty');
  const pe = Number(d.f162);
  const pb = Number(d.f167 ?? d.f164);
  return { pe: Number.isFinite(pe) && pe > 0 ? pe : null, pb: Number.isFinite(pb) && pb > 0 ? pb : null };
}

/* ============ 基本面快照 ============ */

export interface EastmoneyProfile {
  price: number | null;
  /** 市盈率（动态） */
  pe: number | null;
  /** 市净率 */
  pb: number | null;
  /** 总市值（元） */
  marketCap: number | null;
  /** 换手率（%） */
  turnover: number | null;
  /** 净资产收益率（%） */
  roe: number | null;
  /** 每股收益（元） */
  eps: number | null;
  /** 每股净资产（元） */
  bps: number | null;
  /** 营业收入（元） */
  revenue: number | null;
  /** 营收同比（%） */
  revenueYoY: number | null;
  /** 净利润（元） */
  netProfit: number | null;
  /** 毛利率（%） */
  grossMargin: number | null;
  /** 净利率（%） */
  netMargin: number | null;
  /** 资产负债率（%） */
  debtRatio: number | null;
}

/**
 * 从代码构造东财 secid（symbols 表里只有 A 股和指数填了 secid）。
 *  A 股：sh600519 → 1.600519，sz000001 → 0.000001
 *  港股：hk00700 → 116.00700
 *  美股：usAAPL → 105.AAPL（纳斯达克），纽交所需 106（调用方兜底）
 */
export function emSecidOf(code: string, market: string): string | null {
  const c = String(code ?? '').trim();
  if (market === 'CN') {
    const m = /^(sh|sz|bj)(\d{6})$/i.exec(c);
    if (!m) return null;
    return `${m[1].toLowerCase() === 'sh' ? '1' : '0'}.${m[2]}`;
  }
  if (market === 'HK') {
    const m = /^hk(\d{5})$/i.exec(c);
    return m ? `116.${m[1]}` : null;
  }
  if (market === 'US') {
    const m = /^us([A-Za-z][A-Za-z.-]*)$/i.exec(c);
    return m ? `105.${m[1].toUpperCase().replace(/\./g, '-')}` : null;
  }
  return null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** 东财的价格/比率类字段是 ×100 的整数 */
const pct = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n / 100 : null;
};
const pos = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * 基本面快照：一次请求拿全估值 + 盈利 + 成长。
 *
 * 覆盖差异（实测 2026-11）：
 *  - A 股：PE / PB / 市值 / ROE / 毛利 / 净利 / 负债率 / 营收增速 全有；
 *  - 港股：PB / 市值 / ROE，PE 与财务明细东财不给（f162=0）；
 *  - 美股：PB / 市值 / 换手，其余为 0。
 * 拿不到的字段一律返回 null，由 UI 显示「—」，不猜。
 */
export async function fetchEastmoneyProfile(sym: SymbolDef): Promise<EastmoneyProfile> {
  const secid = sym.secid || emSecidOf(sym.code, sym.market);
  if (!secid) throw new Error('no eastmoney secid');

  const fields = 'f43,f57,f58,f116,f117,f162,f167,f168,f173,f55,f92,f105,f183,f184,f186,f187,f188';
  const load = async (id: string) => {
    const j = (await fetchFirst(QT, `/api/qt/stock/get?secid=${id}&fields=${fields}`)) as { data?: Record<string, unknown> };
    return j?.data ?? null;
  };

  let d = await load(secid);
  // 美股先试纳斯达克（105），空则试纽交所（106）
  if ((!d || !Number(d.f116)) && sym.market === 'US') {
    const alt = secid.replace(/^105\./, '106.');
    if (alt !== secid) d = await load(alt);
  }
  if (!d) throw new Error('profile empty');

  const isCN = sym.market === 'CN';

  // 口径差异（实测）：A 股的负债率 f188 是百分数（11.9 = 11.9%），
  // 港美股给的是小数（0.43 = 43%），直接用会差 100 倍。
  const debtRaw = pos(d.f188);
  const debtRatio = debtRaw == null ? null : isCN ? Number(debtRaw) : Number(debtRaw) * 100;

  // 港美股的 f184（营收同比）缺失时返回 0，和「真的零增长」无法区分，按缺失处理
  const yoyRaw = num(d.f184);
  const revenueYoY = isCN ? yoyRaw : yoyRaw === 0 ? null : yoyRaw;

  return {
    price: pct(d.f43),
    pe: pos(d.f162) != null ? pct(d.f162) : null,
    pb: pos(d.f167) != null ? pct(d.f167) : null,
    marketCap: pos(d.f116),
    turnover: pct(d.f168),
    roe: pos(d.f173) != null ? Number(d.f173) : null,
    eps: pos(d.f55),
    bps: pos(d.f92),
    revenue: pos(d.f183),
    revenueYoY,
    netProfit: pos(d.f105),
    grossMargin: pos(d.f186) != null ? Number(d.f186) : null,
    netMargin: pos(d.f187) != null ? Number(d.f187) : null,
    debtRatio
  };
}
