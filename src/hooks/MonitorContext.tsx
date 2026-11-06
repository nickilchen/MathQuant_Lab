/**
 * 全局实时监控引擎（多源 + 限流防护版）
 *
 * 挂在 App 外层，切页面不中断。所有外部请求统一走 `data/monitorSources.ts`
 * → `rateLimit.guardedFetch`，按 host 做最小间隔、每分钟预算、失败指数退避。
 *
 * 三条数据流分频：行情 / 快讯 / 公告各自计时，互不拖累；
 * 任一路失败或被限流保护跳过，都沿用上一轮快照，不影响其他路。
 *
 * 自适应降频：非交易时段 ×3、后台标签页 ×4，避免休市时空转把数据源打挂。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from 'react';
import {
  capEvents,
  diffAnnouncements,
  diffNews,
  evalQuotes,
  filterNew,
  normalizeConfig,
  type MonitorConfig,
  type MonitorEvent,
  type Quote
} from '../math/monitor';
import {
  freshConfig,
  loadConfig,
  loadEvents,
  loadSeen,
  loadSnapshot,
  loadTargets,
  marketOfCode,
  saveConfig,
  saveEvents,
  saveSeen,
  saveSnapshot,
  saveTargets,
  type MonitorSnapshot
} from '../data/monitor';
import {
  fetchFlashesMulti,
  fetchQuotesMulti,
  canFetchAnnouncement,
  noteAnnouncement,
  type SourceResult
} from '../data/monitorSources';
import {
  effectiveInterval,
  getStats,
  intervalFactor,
  BudgetSkipped,
  type HostStat
} from '../data/rateLimit';
import { ensureAnnouncements } from '../data/stockNews';
import type { StockHit } from '../data/search';

export interface PollTimes {
  quote: number;
  news: number;
  ann: number;
}

export interface MonitorState {
  config: MonitorConfig;
  targets: StockHit[];
  events: MonitorEvent[];
  quotes: Quote[];
  lastPoll: PollTimes;
  nextIn: number;
  pollCount: number;
  errorCount: number;
  lastError: string | null;
  busy: boolean;
  unread: number;
  notifyPermission: NotificationPermission | 'unsupported';
  /** 最近一轮各数据源的结果 */
  sources: SourceResult[];
  /** 各 host 的请求预算与健康统计 */
  health: HostStat[];
  /** 当前轮询间隔倍率（1 正常 / 3 休市 / 4 后台） */
  factor: number;
  round: number;
  /** 被限流保护主动跳过的次数（不是失败） */
  skipped: number;
}

export interface MonitorApi extends MonitorState {
  setConfig: (patch: Partial<MonitorConfig>) => void;
  setTargets: (t: StockHit[]) => void;
  addTarget: (hit: StockHit) => void;
  removeTarget: (code: string) => void;
  toggle: () => void;
  pollNow: () => void;
  markAllRead: () => void;
  clearEvents: () => void;
  resetConfig: () => void;
  requestNotify: () => Promise<void>;
  refreshHealth: () => void;
}

const Ctx = createContext<MonitorApi | null>(null);
const hasNotification = () => typeof window !== 'undefined' && 'Notification' in window;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function beep(): void {
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    const ac = new AudioCtx();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = 'sine';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, ac.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + 0.22);
    osc.connect(gain).connect(ac.destination);
    osc.start();
    osc.stop(ac.currentTime + 0.24);
    osc.onended = () => void ac.close();
  } catch {
    /* 未授权音频时静默忽略 */
  }
}

/** 按交易时段与页面可见性算出本轮实际间隔 */
function intervalsOf(cfg: MonitorConfig, targets: StockHit[], hidden: boolean) {
  const markets = targets.map((t) => marketOfCode(t.code)).filter((x): x is NonNullable<typeof x> => !!x);
  const factor = cfg.adaptive ? intervalFactor(markets, hidden) : 1;
  return {
    factor,
    quote: effectiveInterval(cfg.quoteInterval, factor),
    news: effectiveInterval(cfg.newsInterval, factor),
    ann: effectiveInterval(cfg.annInterval, factor)
  };
}

export function MonitorProvider({ children }: { children: ReactNode }) {
  const [config, setConfigState] = useState<MonitorConfig>(() => loadConfig());
  const [targets, setTargetsState] = useState<StockHit[]>(() => loadTargets());
  const [events, setEventsState] = useState<MonitorEvent[]>(() => loadEvents());
  const [quotes, setQuotes] = useState<Quote[]>(() => loadSnapshot()?.quotes ?? []);
  const [lastPoll, setLastPoll] = useState<PollTimes>({ quote: 0, news: 0, ann: 0 });
  const [nextIn, setNextIn] = useState(0);
  const [pollCount, setPollCount] = useState(0);
  const [errorCount, setErrorCount] = useState(0);
  const [lastError, setLastError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notifyPermission, setNotifyPermission] = useState<MonitorState['notifyPermission']>(() =>
    hasNotification() ? Notification.permission : 'unsupported'
  );
  const [sources, setSources] = useState<SourceResult[]>([]);
  const [health, setHealth] = useState<HostStat[]>([]);
  const [factor, setFactor] = useState(1);
  const [round, setRound] = useState(0);
  const [skipped, setSkipped] = useState(0);

  const configRef = useRef(config);
  const targetsRef = useRef(targets);
  const eventsRef = useRef(events);
  const seenRef = useRef<Set<string>>(loadSeen());
  const snapRef = useRef<MonitorSnapshot>(loadSnapshot() ?? { ts: 0, news: [], newsIds: [], annIds: {}, quotes: [] });
  const lastRef = useRef<PollTimes>({ quote: 0, news: 0, ann: 0 });
  const roundRef = useRef(0);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  /** 各标的上次真正发起公告请求的时间（缓存命中不算） */
  const annFetchRef = useRef<Record<string, number>>({});
  /** 每个源最近一次结果：分频轮询时表格不该只剩本轮那一两行 */
  const sourceMapRef = useRef<Map<string, SourceResult>>(new Map());

  configRef.current = config;
  targetsRef.current = targets;
  eventsRef.current = events;

  const persistSnapshot = useCallback(() => {
    snapRef.current.ts = Date.now();
    saveSnapshot(snapRef.current);
  }, []);

  const pushEvents = useCallback((incoming: MonitorEvent[]) => {
    if (!incoming.length) return;
    const { fresh, seen } = filterNew(capEvents(incoming), seenRef.current);
    seenRef.current = seen;
    saveSeen(seen);
    if (!fresh.length || !mountedRef.current) return;
    const onMonitorPage = typeof window !== 'undefined' && /^#\/monitor/.test(window.location.hash);
    const next = [...fresh.map((e) => ({ ...e, read: onMonitorPage })), ...eventsRef.current].slice(0, 200);
    eventsRef.current = next;
    setEventsState(next);
    saveEvents(next);

    const cfg = configRef.current;
    if (cfg.notify && hasNotification() && Notification.permission === 'granted') {
      for (const e of fresh.slice(0, 3)) {
        try {
          new Notification(e.title, { body: e.detail, tag: e.id, silent: !cfg.sound });
        } catch {
          /* 某些平台要求 ServiceWorker，忽略 */
        }
      }
    }
    if (cfg.sound && fresh.some((e) => e.level === 'critical')) beep();
  }, []);

  const poll = useCallback(
    async (due: { quote: boolean; news: boolean; ann: boolean }, force = false) => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const now = Date.now();
      const cfg = configRef.current;
      const tg = targetsRef.current;
      const rules = cfg.rules;
      roundRef.current += 1;
      const r = roundRef.current;
      const codes = tg.map((t) => t.code);
      const tasks: Promise<void>[] = [];
      const results: SourceResult[] = [];
      let failed = 0;
      let protectedSkips = 0;
      let err = '';

      const noteError = (label: string, e: unknown) => {
        if (e instanceof BudgetSkipped) {
          protectedSkips += 1;
          return;
        }
        failed += 1;
        err = `${label}：${e instanceof Error ? e.message : String(e)}`.slice(0, 120);
      };

      // ---- 行情：腾讯主 + 东财/新浪/Naver/Yahoo JP 备 ----
      if ((due.quote || force) && rules.enableQuotes && codes.length) {
        lastRef.current.quote = now;
        tasks.push(
          fetchQuotesMulti(codes, r, cfg.verifyEvery)
            .then((bundle) => {
              results.push(...bundle.results);
              for (const x of bundle.results) if (!x.ok && x.skipped) protectedSkips += 1;
              if (!bundle.quotes.length) return;
              const byCode = new Map(tg.map((t) => [t.code, t.name]));
              const named = bundle.quotes.map((q) => ({ ...q, name: byCode.get(q.code) || q.name }));
              const prev = snapRef.current.quotes.length ? snapRef.current.quotes : null;
              pushEvents(evalQuotes(prev, named, rules, now));
              snapRef.current.quotes = named;
              persistSnapshot();
              if (mountedRef.current) setQuotes(named);
            })
            .catch((e) => noteError('行情', e))
        );
      }

      // ---- 快讯：财联社主 + 新浪 7×24 / 东财快讯备 ----
      if ((due.news || force) && rules.enableNews) {
        lastRef.current.news = now;
        tasks.push(
          fetchFlashesMulti(cfg.flashStrategy, r, cfg.crossEvery)
            .then((bundle) => {
              results.push(...bundle.results);
              for (const x of bundle.results) if (!x.ok && x.skipped) protectedSkips += 1;
              // 空结果不能覆盖快照：否则下轮会把全部历史消息当成新增
              if (!bundle.flashes.length) return;
              const prev = snapRef.current.news.length ? snapRef.current.news : null;
              pushEvents(diffNews(prev, bundle.flashes, rules, now, new Set(snapRef.current.newsIds)));
              snapRef.current.news = bundle.flashes;
              snapRef.current.newsIds = [
                ...new Set([...snapRef.current.newsIds, ...bundle.flashes.map((f) => f.id)])
              ].slice(-500);
              persistSnapshot();
            })
            .catch((e) => noteError('快讯', e))
        );
      }

      // ---- 公告：非 force（缓存命中零请求）+ 前置熔断 + 串行错峰 ----
      if ((due.ann || force) && rules.enableAnn && tg.length) {
        lastRef.current.ann = now;
        const usable = tg.filter((t) => marketOfCode(t.code));
        const annTask = async () => {
          for (const t of usable) {
            if (!canFetchAnnouncement(t.code)) {
              protectedSkips += 1;
              results.push({
                id: `ann:${t.code}`,
                label: `${t.name}公告`,
                ok: false,
                count: 0,
                skipped: true,
                error: '限流保护：冷却中或本分钟预算已用完'
              });
              continue;
            }
            const started = Date.now();
            try {
              // 关键：不再 force 强刷。东财/SEC/Yahoo JP/Naver 适配器自带 10 分钟缓存，
              // 命中时根本不发请求，从源头把请求量降下来。
              const res = await ensureAnnouncements(t.code);
              const list = res.list;
              const market = marketOfCode(t.code)!;
              const known = snapRef.current.annIds[t.code];
              const prevIds = known ? new Set(known) : null;
              pushEvents(diffAnnouncements(prevIds, list, { code: t.code, name: t.name, market }, rules, now));
              snapRef.current.annIds[t.code] = list.map((x) => x.id);
              // 缓存命中不记预算，避免「零请求却消耗配额」
              const gap = started - (annFetchRef.current[t.code] ?? 0);
              if (gap > 10 * 60 * 1000) {
                noteAnnouncement(t.code, true, undefined, Date.now() - started);
                annFetchRef.current[t.code] = started;
              }
              results.push({ id: `ann:${t.code}`, label: `${t.name}公告`, ok: true, count: list.length });
            } catch (e) {
              noteAnnouncement(t.code, false, e);
              noteError(`${t.name}公告`, e);
              results.push({
                id: `ann:${t.code}`,
                label: `${t.name}公告`,
                ok: false,
                count: 0,
                error: e instanceof Error ? e.message : String(e)
              });
            }
            await sleep(400); // 错峰：不让 5 个标的的请求同时打到一个 host
          }
          persistSnapshot();
        };
        tasks.push(annTask());
      }

      await Promise.all(tasks);
      if (mountedRef.current) {
        setLastPoll({ ...lastRef.current });
        setPollCount((v) => v + 1);
        setRound(r);
        for (const x of results) sourceMapRef.current.set(x.id, x);
        setSources([...sourceMapRef.current.values()]);
        setHealth(getStats());
        setSkipped((v) => v + protectedSkips);
        if (failed) {
          setErrorCount((v) => v + failed);
          setLastError(err);
        } else if (!err) {
          setLastError(null);
        }
        setBusy(false);
      }
      busyRef.current = false;
    },
    [persistSnapshot, pushEvents]
  );

  useEffect(() => {
    mountedRef.current = true;
    void poll({ quote: true, news: true, ann: true });
    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now();
      const c = configRef.current;
      const hidden = typeof document !== 'undefined' && document.hidden;
      const iv = intervalsOf(c, targetsRef.current, hidden);
      const gap = (last: number, sec: number) => Math.max(0, Math.ceil((last + sec * 1000 - now) / 1000));
      setFactor(iv.factor);
      setNextIn(Math.min(gap(lastRef.current.quote, iv.quote), gap(lastRef.current.news, iv.news), gap(lastRef.current.ann, iv.ann)));
      if (!c.running || busyRef.current) return;
      const due = {
        quote: c.rules.enableQuotes && targetsRef.current.length > 0 && now - lastRef.current.quote >= iv.quote * 1000,
        news: c.rules.enableNews && now - lastRef.current.news >= iv.news * 1000,
        ann: c.rules.enableAnn && targetsRef.current.length > 0 && now - lastRef.current.ann >= iv.ann * 1000
      };
      if (due.quote || due.news || due.ann) void poll(due);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [poll]);

  const setConfig = useCallback((patch: Partial<MonitorConfig>) => {
    const next = normalizeConfig({ ...configRef.current, ...patch });
    configRef.current = next;
    setConfigState(next);
    saveConfig(next);
  }, []);

  const setTargets = useCallback((t: StockHit[]) => {
    const uniq = t.filter((x, i, arr) => arr.findIndex((y) => y.code === x.code) === i).slice(0, 30);
    targetsRef.current = uniq;
    setTargetsState(uniq);
    saveTargets(uniq);
  }, []);

  const addTarget = useCallback((hit: StockHit) => {
    if (targetsRef.current.some((x) => x.code === hit.code)) return;
    setTargets([...targetsRef.current, hit]);
  }, [setTargets]);

  const removeTarget = useCallback((code: string) => {
    setTargets(targetsRef.current.filter((x) => x.code !== code));
    delete snapRef.current.annIds[code];
    persistSnapshot();
  }, [setTargets, persistSnapshot]);

  const toggle = useCallback(() => setConfig({ running: !configRef.current.running }), [setConfig]);
  const pollNow = useCallback(() => void poll({ quote: true, news: true, ann: true }, true), [poll]);

  const markAllRead = useCallback(() => {
    const next = eventsRef.current.map((e) => ({ ...e, read: true }));
    eventsRef.current = next;
    setEventsState(next);
    saveEvents(next);
  }, []);

  const clearEvents = useCallback(() => {
    eventsRef.current = [];
    setEventsState([]);
    saveEvents([]);
  }, []);

  const resetConfig = useCallback(() => {
    const next = freshConfig();
    configRef.current = next;
    setConfigState(next);
    saveConfig(next);
  }, []);

  const requestNotify = useCallback(async () => {
    if (!hasNotification()) {
      setNotifyPermission('unsupported');
      return;
    }
    const p = await Notification.requestPermission();
    setNotifyPermission(p);
    if (p === 'granted') setConfig({ notify: true });
  }, [setConfig]);

  const refreshHealth = useCallback(() => {
    setHealth(getStats());
    setFactor(intervalsOf(configRef.current, targetsRef.current, typeof document !== 'undefined' && document.hidden).factor);
  }, []);

  const unread = useMemo(() => events.filter((e) => !e.read).length, [events]);

  const value: MonitorApi = {
    config, targets, events, quotes, lastPoll, nextIn, pollCount, errorCount, lastError,
    busy, unread, notifyPermission, sources, health, factor, round, skipped,
    setConfig, setTargets, addTarget, removeTarget, toggle, pollNow,
    markAllRead, clearEvents, resetConfig, requestNotify, refreshHealth
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useMonitor(): MonitorApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useMonitor 必须在 MonitorProvider 内使用');
  return v;
}
