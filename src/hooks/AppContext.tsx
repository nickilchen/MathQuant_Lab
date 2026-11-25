import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Bar, DataSource, FundFlow } from '../data/types';
import { getSymbol } from '../data/symbols';
import { fetchKline } from '../data/fetcher';
import { emSecidOf, fetchEastmoneyFundFlow, fetchEastmoneyProfile, type EastmoneyProfile } from '../data/sources/eastmoney';
import type { StockHit } from '../data/search';
import type { SymbolDef } from '../data/types';
import { applyTheme, readStoredTheme, type ThemeId } from '../theme';
import { syncPalette } from '../components/chartOptions';

export interface Settings {
  benchmark: string;
  days: number;
  buyBps: number;
  sellBps: number;
  stampBps: number;
}

export const DEFAULT_SETTINGS: Settings = {
  benchmark: 'sh000300',
  days: 500,
  buyBps: 2.5,
  sellBps: 2.5,
  stampBps: 10
};

export interface KlineState {
  bars: Bar[];
  source: DataSource;
  loading: boolean;
  /** 走缓存时的写入时间戳（毫秒） */
  cacheTs?: number;
  /** 实时源全部失败且禁止模拟数据时为 true */
  failed?: boolean;
  /** 失败时尝试过的数据源 id 列表 */
  attempts?: string[];
}

export interface ExtraState {
  fundFlow: FundFlow[] | null;
  pe: number | null;
  pb: number | null;
  /** 基本面快照（估值 + 盈利 + 成长）；拿不到的字段为 null */
  profile: EastmoneyProfile | null;
  loading: boolean;
}

interface AppCtx {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  klines: Record<string, KlineState>;
  ensureKlines: (codes: string[], opts?: { allowDemo?: boolean }) => void;
  /** 注册搜索到的动态个股（不在固定目录中的标的） */
  registerStock: (hit: StockHit) => void;
  /** 使某标的的行情缓存失效（用于失败重试） */
  invalidateKline: (code: string) => void;
  extras: Record<string, ExtraState>;
  ensureExtras: (code: string) => void;
  btCfg: { buyBps: number; sellBps: number; stampBps: number };
  /** 当前主题（A/B/C） */
  theme: ThemeId;
  setTheme: (t: ThemeId) => void;
  /** 回看周期版本号：变化时订阅方需重新取数 */
  daysVersion: number;
}

const Ctx = createContext<AppCtx | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [theme, setThemeState] = useState<ThemeId>(() => readStoredTheme());

  // 首帧前就把主题写进 <html>，避免闪一下默认配色
  useEffect(() => {
    applyTheme(theme);
    syncPalette();
  }, [theme]);

  // 切换时同步生效：先更新 CSS 变量与图表色板，再让 React 重渲染，
  // 这样页面在本次渲染里构造 ECharts option 时读到的已经是新颜色。
  const setTheme = useCallback((t: ThemeId) => {
    applyTheme(t);
    syncPalette();
    setThemeState(t);
  }, []);

  const [klines, setKlinesState] = useState<Record<string, KlineState>>({});
  const [extras, setExtras] = useState<Record<string, ExtraState>>({});
  const inflightK = useRef<Record<string, boolean>>({});
  const inflightE = useRef<Record<string, boolean>>({});
  // 搜索到的动态个股（A/港/美/日/台/韩），与固定目录合并解析
  const [extraSymbols, setExtraSymbols] = useState<Record<string, SymbolDef>>({});
  const resolveSymbol = useCallback(
    (code: string): SymbolDef | undefined => getSymbol(code) ?? extraSymbols[code],
    [extraSymbols]
  );
  const registerStock = useCallback((hit: StockHit) => {
    if (getSymbol(hit.code)) return;
    setExtraSymbols((m) => {
      if (m[hit.code]) return m;
      return {
        ...m,
        [hit.code]: {
          code: hit.code,
          name: hit.name,
          secid: hit.secid ?? '',
          kind: 'stock',
          market: hit.market,
          naver: hit.naver,
          // 深链（?code=jp7203）进来的日股没有 yahoo 字段，按代码补上，
          // 否则日股 K 线无源可用（Yahoo Finance 被墙、东财不服务日股）
          yahoo: hit.yahoo ?? (hit.market === 'JP' ? `${hit.code.replace(/^jp/i, '')}.T` : undefined),
          // 深链/热门（?code=usAAPL）进来的美股没有 sina 字段，按代码补上（usAAPL → AAPL）。
          // 新浪 US_MinKService.getDailyK 靠 sym.sina 取数，缺它则美股 K 线无源、估值不可用。
          sina: hit.sina ?? (hit.market === 'US' ? hit.code.replace(/^us/i, '') : undefined),
          base: 100
        }
      };
    });
  }, []);
  // 取数队列：限制并发（默认 4），避免多页面同时挂载时十几条请求齐发触发上游限流
  const klineQueue = useRef<{ code: string; allowDemo: boolean }[]>([]);
  const klineActive = useRef(0);
  const MAX_CONCURRENT = 4;
  const pumpRef = useRef<() => void>(() => {});
  // klines 的 ref 镜像：队列调度读 ref，避免拿到过期的 state 闭包而漏发/重发
  const klinesRef = useRef<Record<string, KlineState>>({});
  const setKlines = useCallback((updater: (k: Record<string, KlineState>) => Record<string, KlineState>) => {
    setKlinesState((k) => {
      const next = updater(k);
      klinesRef.current = next;
      return next;
    });
  }, []);
  // 回看周期版本号：变化时清空缓存并让所有订阅者重新取数
  const daysVersionRef = useRef(0);
  const [daysVersion, setDaysVersion] = useState(0);

  pumpRef.current = () => {
    while (klineActive.current < MAX_CONCURRENT && klineQueue.current.length > 0) {
      const item = klineQueue.current.shift()!;
      const code = item.code;
      const sym = resolveSymbol(code);
      if (!sym || klinesRef.current[code] || inflightK.current[code]) continue;
      inflightK.current[code] = true;
      klineActive.current++;
      const ver = daysVersionRef.current;
      setKlines((k) => ({ ...k, [code]: { bars: [], source: 'demo', loading: true } }));
      void fetchKline(
        sym,
        settings.days,
        (bars, source) => {
          // 后台自愈刷新成功：静默更新，徽标自动翻转为实时源
          if (ver !== daysVersionRef.current) return;
          setKlines((k) => ({ ...k, [code]: { bars, source, loading: false, failed: false } }));
        },
        item.allowDemo
      ).then((res) => {
        inflightK.current[code] = false;
        klineActive.current--;
        // 回看周期已切换：丢弃旧周期结果，仅归还并发额度
        if (ver === daysVersionRef.current) {
          setKlines((k) => ({
            ...k,
            [code]: { bars: res.bars, source: res.source, loading: false, cacheTs: res.cacheTs, failed: res.failed, attempts: res.attempts }
          }));
        }
        pumpRef.current();
      });
    }
  };

  const ensureKlines = useCallback(
    (codes: string[], opts?: { allowDemo?: boolean }) => {
      const allowDemo = opts?.allowDemo ?? true;
      let queued = false;
      for (const code of codes) {
        if (klinesRef.current[code] || inflightK.current[code] || klineQueue.current.some((q) => q.code === code)) continue;
        if (!resolveSymbol(code)) continue;
        klineQueue.current.push({ code, allowDemo });
        queued = true;
      }
      if (queued) pumpRef.current();
    },
    [resolveSymbol]
  );

  const invalidateKline = useCallback((code: string) => {
    inflightK.current[code] = false;
    setKlines((k) => {
      if (!k[code]) return k;
      const next = { ...k };
      delete next[code];
      return next;
    });
  }, []);

  const ensureExtras = useCallback((code: string) => {
    const sym = resolveSymbol(code);
    if (!sym || extras[code] || inflightE.current[code]) return;

    // 资金流仅 A 股有；基本面快照可以按代码构造 secid，A/港/美都能查（覆盖度不同）
    const canFund = sym.market === 'CN';
    const canProfile = !!sym.secid || !!emSecidOf(sym.code, sym.market);
    if (!canFund && !canProfile) {
      setExtras((e) => ({ ...e, [code]: { fundFlow: null, pe: null, pb: null, profile: null, loading: false } }));
      return;
    }

    inflightE.current[code] = true;
    setExtras((e) => ({ ...e, [code]: { fundFlow: null, pe: null, pb: null, profile: null, loading: true } }));
    void Promise.all([
      canFund ? fetchEastmoneyFundFlow(sym, Math.max(settings.days, 120)).catch(() => null) : Promise.resolve(null),
      canProfile ? fetchEastmoneyProfile(sym).catch(() => null) : Promise.resolve(null)
    ]).then(([ff, prof]) => {
      setExtras((e) => ({
        ...e,
        [code]: {
          fundFlow: ff,
          pe: prof?.pe ?? null,
          pb: prof?.pb ?? null,
          profile: prof,
          loading: false
        }
      }));
      inflightE.current[code] = false;
    });
  }, [extras, settings.days, resolveSymbol]);

  // 回看窗口变化 → 清空重取（队列一并清理，在途请求结果丢弃）
  // 注意：只在「真的换了周期」时执行。挂载时若也清空，会把子组件刚排进队列的标的抹掉，
  // 表现为多标的页面只加载前 4 个（并发上限）就卡住。
  const prevDays = useRef(settings.days);
  useEffect(() => {
    if (prevDays.current === settings.days) return;
    prevDays.current = settings.days;
    daysVersionRef.current += 1;
    klinesRef.current = {};
    setKlinesState({});
    inflightK.current = {};
    klineQueue.current = [];
    setDaysVersion(daysVersionRef.current);
  }, [settings.days]);

  const value = useMemo<AppCtx>(
    () => ({
      settings,
      update: (patch) => setSettings((s) => ({ ...s, ...patch })),
      klines,
      ensureKlines,
      registerStock,
      invalidateKline,
      extras,
      ensureExtras,
      btCfg: { buyBps: settings.buyBps, sellBps: settings.sellBps, stampBps: settings.stampBps },
      theme,
      setTheme,
      daysVersion
    }),
    [settings, klines, ensureKlines, registerStock, invalidateKline, extras, ensureExtras, theme, setTheme, daysVersion]
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useApp(): AppCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp must be used within AppProvider');
  return v;
}

/** 取单个标的的 K 线（自动触发加载） */
export function useKline(code: string): KlineState | undefined {
  const { klines, ensureKlines, daysVersion } = useApp();
  useEffect(() => {
    ensureKlines([code]);
  }, [code, ensureKlines, daysVersion]);
  return klines[code];
}

/** 取多个标的的 K 线 */
export function useKlines(codes: string[]): Record<string, KlineState> {
  const { klines, ensureKlines, daysVersion } = useApp();
  const key = codes.join(',');
  useEffect(() => {
    ensureKlines(codes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, daysVersion]);
  return klines;
}
