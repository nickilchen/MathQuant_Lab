/**
 * 实时监控的规则引擎（纯函数，无 DOM / 网络依赖）
 *
 * 三条数据流各自独立，避免互相拖累：
 *   1. 消息面：财联社快讯**增量**（只报新出现的，按影响力 S/A/B 分级）
 *   2. 个股行情：相对昨收的**阈值穿越** + 相对上次轮询的**瞬时跳变**
 *   3. 个股公告：公告 ID 增量（只报重要公司行为标签）
 *
 * 两个刻意的设计：
 *
 * ① **首次轮询建立基线，不产生告警**。否则启动瞬间会把已有的 40 条快讯、
 *    几十条历史公告全部当成「新事件」刷屏。调用方传 null 表示尚未建立基线。
 *
 * ② **行情用「穿越」而不是「当前状态」**。涨跌幅 ≥3% 是一个持续状态，
 *    每 30 秒报一次会变成刷屏；只有从 <3% 越过到 ≥3% 的那一次才报。
 *    瞬时跳变另用「本次价 / 上次价」判定，并按分钟桶去重。
 */
import { headline, scoreNews, splitFlash, type NewsLike } from './news';
import { ANN_TAG_META, classifyAnn, type AnnInput, type AnnMarket, type AnnTag } from './stockNews';

/* ============ 类型 ============ */

export type EventLevel = 'critical' | 'warning' | 'info';
export type EventKind = 'news' | 'quote' | 'announcement' | 'system';

export interface MonitorEvent {
  /** 稳定 ID，用于跨轮去重 */
  id: string;
  ts: number;
  kind: EventKind;
  level: EventLevel;
  /** 关联标的（消息面事件可为空） */
  code?: string;
  name?: string;
  title: string;
  detail: string;
  /** 站内跳转（hash 路由） */
  link?: string;
  /** 相关数值（涨跌幅 / 影响力），便于排序与展示 */
  value?: number;
  /** 只读标记：用户点过「全部已读」后不再计入未读 */
  read?: boolean;
}

export interface Quote {
  code: string;
  name: string;
  price: number;
  prevClose: number;
  /** 相对昨收涨跌幅（%） */
  chgPct: number;
  high: number;
  low: number;
  volume: number;
  /** 数据源给出的行情时间 */
  time: string;
  currency: string;
  market: AnnMarket;
  /** 本条价格实际来自哪个源（多源合并后用于自证） */
  source?: string;
}

export interface MonitorRules {
  /** 日内涨跌幅绝对值阈值（%） */
  movePct: number;
  /** 相对上次轮询的瞬时跳变阈值（%） */
  jumpPct: number;
  /** 快讯最低告警档位 */
  newsTier: 'S' | 'A' | 'B';
  /** 公告只报重要公司行为（排除说明会、人事、例行） */
  annImportantOnly: boolean;
  enableNews: boolean;
  enableQuotes: boolean;
  enableAnn: boolean;
}

export interface MonitorConfig {
  running: boolean;
  /** 行情轮询间隔（秒） */
  quoteInterval: number;
  /** 快讯轮询间隔（秒） */
  newsInterval: number;
  /** 公告轮询间隔（秒） */
  annInterval: number;
  /** 浏览器桌面通知 */
  notify: boolean;
  /** 提示音 */
  sound: boolean;
  /** 快讯多源策略：主源+故障切换 / 轮流 / 三源齐发 */
  flashStrategy: 'primary' | 'rotate' | 'all';
  /** 每多少轮用备源交叉补一次快讯（0 = 关闭） */
  crossEvery: number;
  /** 每多少轮用备源交叉验证一次行情（0 = 关闭） */
  verifyEvery: number;
  /** 启用交易时段 / 后台标签页自动降频 */
  adaptive: boolean;
  rules: MonitorRules;
}

export const DEFAULT_RULES: MonitorRules = {
  movePct: 3,
  jumpPct: 1.5,
  newsTier: 'A',
  annImportantOnly: true,
  enableNews: true,
  enableQuotes: true,
  enableAnn: true
};

export const DEFAULT_CONFIG: MonitorConfig = {
  running: true,
  quoteInterval: 30,
  newsInterval: 60,
  annInterval: 300,
  notify: false,
  sound: false,
  flashStrategy: 'primary',
  crossEvery: 6,
  verifyEvery: 10,
  adaptive: true,
  rules: DEFAULT_RULES
};

/** 单轮最多产生的事件数：数据源一次返回几十条时，只保留最重要的 */
export const MAX_EVENTS_PER_POLL = 12;

const LEVEL_RANK: Record<EventLevel, number> = { critical: 3, warning: 2, info: 1 };
const TIER_RANK: Record<string, number> = { S: 3, A: 2, B: 1, C: 0 };

/** 只保留「重要公司行为」标签；其余属于程序性披露 */
const IMPORTANT_TAGS = new Set<AnnTag>([
  'buyback', 'increase', 'reduce', 'risk', 'contract', 'approval',
  'ma', 'earnings', 'dividend', 'unlock', 'lawsuit', 'placement',
  'subsidy', 'insider', 'stake', 'material'
]);

/** 配置合法性：避免用户输入 0 秒导致疯狂请求、或负数阈值 */
export function normalizeConfig(raw: Partial<MonitorConfig> | null | undefined): MonitorConfig {
  const c = raw ?? {};
  const clamp = (v: unknown, lo: number, hi: number, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : fallback;
  };
  const r = { ...DEFAULT_RULES, ...(c.rules ?? {}) };
  return {
    running: c.running !== false,
    quoteInterval: clamp(c.quoteInterval, 10, 3600, DEFAULT_CONFIG.quoteInterval),
    newsInterval: clamp(c.newsInterval, 20, 3600, DEFAULT_CONFIG.newsInterval),
    annInterval: clamp(c.annInterval, 60, 7200, DEFAULT_CONFIG.annInterval),
    notify: !!c.notify,
    sound: !!c.sound,
    flashStrategy: (['primary', 'rotate', 'all'] as const).includes(c.flashStrategy as 'primary') ? c.flashStrategy! : 'primary',
    crossEvery: clamp(c.crossEvery, 0, 60, DEFAULT_CONFIG.crossEvery),
    verifyEvery: clamp(c.verifyEvery, 0, 60, DEFAULT_CONFIG.verifyEvery),
    adaptive: c.adaptive !== false,
    rules: {
      ...r,
      movePct: Math.max(0.2, Math.min(30, Number(r.movePct) || DEFAULT_RULES.movePct)),
      jumpPct: Math.max(0.2, Math.min(20, Number(r.jumpPct) || DEFAULT_RULES.jumpPct)),
      newsTier: (['S', 'A', 'B'] as const).includes(r.newsTier) ? r.newsTier : 'A',
      annImportantOnly: r.annImportantOnly !== false,
      enableNews: r.enableNews !== false,
      enableQuotes: r.enableQuotes !== false,
      enableAnn: r.enableAnn !== false
    }
  };
}

/* ============ 去重 ============ */

/**
 * 过滤已见过的事件，并把新 ID 并入 seen。
 * seen 会截断到 2000 条：只保留最近的一部分，防止 localStorage 无限膨胀。
 */
export function filterNew(
  events: MonitorEvent[],
  seen: Set<string>
): { fresh: MonitorEvent[]; seen: Set<string> } {
  const next = new Set(seen);
  const fresh = events.filter((e) => {
    if (next.has(e.id)) return false;
    next.add(e.id);
    return true;
  });
  const trimmed = new Set([...next].slice(-2000));
  return { fresh, seen: trimmed };
}

/** 单轮裁剪：按级别与时间排序，只留最重要的 N 条 */
export function capEvents(events: MonitorEvent[], n = MAX_EVENTS_PER_POLL): MonitorEvent[] {
  if (events.length <= n) return events;
  return [...events]
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.ts - a.ts)
    .slice(0, n)
    .sort((a, b) => b.ts - a.ts);
}

/* ============ 消息面：快讯增量 ============ */

/**
 * 快讯新增事件。
 * prev === null 表示首次基线，只返回空数组（调用方负责把当前 ID 写进 seen）。
 */
export function diffNews(
  prev: NewsLike[] | null,
  next: NewsLike[],
  rules: MonitorRules,
  now = Date.now(),
  /** 跨源累积见过的 ID：主源被限流切到备源、再切回来时，不能把主源旧消息当新增 */
  knownIds?: Set<string>
): MonitorEvent[] {
  if (!prev || !rules.enableNews || !next.length) return [];
  const known = new Set(prev.map((n) => n.id));
  for (const id of knownIds ?? []) known.add(id);
  const minRank = TIER_RANK[rules.newsTier] ?? 2;
  const out: MonitorEvent[] = [];

  for (const n of next) {
    if (known.has(n.id)) continue;
    const scored = scoreNews(n);
    if ((TIER_RANK[scored.tier] ?? 0) < minRank) continue;
    const { title, body } = splitFlash(n.text);
    const dir = scored.tone > 0 ? '利好' : scored.tone < 0 ? '利空' : '中性';
    out.push({
      id: `news:${n.id}`,
      ts: now,
      kind: 'news',
      level: scored.tier === 'S' ? 'critical' : scored.tier === 'A' ? 'warning' : 'info',
      title: `${scored.tier} 级快讯 · ${headline({ title, body }, 34)}`,
      detail: `${n.time || '—'} · ${dir} · 影响力 ${scored.impact} · ${scored.topicLabel}` +
        (scored.reasons.length ? ` · ${scored.reasons.slice(0, 3).join('、')}` : ''),
      link: '/sentiment',
      value: scored.impact
    });
  }
  return capEvents(out);
}

/* ============ 个股行情：穿越 + 跳变 ============ */

const dayKey = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * 行情事件。prev === null 表示首次基线（只记录价格，不告警）。
 *
 *  - 穿越：|上次涨跌幅| < 阈值 且 |本次| ≥ 阈值 → 报一次，ID 带当天日期，跨天才会重置
 *  - 跳变：|本次价 / 上次价 − 1| ≥ 阈值 → 按分钟桶去重，避免剧烈波动时连续刷屏
 */
export function evalQuotes(
  prev: Quote[] | null,
  next: Quote[],
  rules: MonitorRules,
  now = Date.now()
): MonitorEvent[] {
  if (!prev || !rules.enableQuotes || !next.length) return [];
  const before = new Map(prev.map((q) => [q.code, q]));
  const dk = dayKey(now);
  const minute = Math.floor(now / 60000);
  const out: MonitorEvent[] = [];

  for (const q of next) {
    const p = before.get(q.code);
    if (!p || !(p.price > 0) || !(q.price > 0)) continue;
    const dirUp = q.chgPct >= 0;
    const side = dirUp ? 'up' : 'down';
    const arrow = dirUp ? '涨' : '跌';

    // ① 涨跌幅阈值穿越
    if (Math.abs(p.chgPct) < rules.movePct && Math.abs(q.chgPct) >= rules.movePct) {
      const strong = Math.abs(q.chgPct) >= rules.movePct * 2;
      out.push({
        id: `q:${q.code}:${dk}:move:${side}`,
        ts: now,
        kind: 'quote',
        level: strong ? 'critical' : 'warning',
        code: q.code,
        name: q.name,
        title: `${q.name} 日内${arrow}幅越过 ${rules.movePct}%`,
        detail: `现价 ${q.price} ${q.currency}，${dirUp ? '+' : ''}${q.chgPct.toFixed(2)}%（昨收 ${p.prevClose}）· 区间 ${q.low}~${q.high} · ${q.time || '—'}`,
        link: `/stock?code=${encodeURIComponent(q.code)}`,
        value: q.chgPct
      });
    }

    // ② 相对上次轮询的瞬时跳变
    const jump = ((q.price - p.price) / p.price) * 100;
    if (Math.abs(jump) >= rules.jumpPct) {
      const jUp = jump > 0;
      out.push({
        id: `q:${q.code}:${minute}:jump:${jUp ? 'up' : 'down'}`,
        ts: now,
        kind: 'quote',
        level: Math.abs(jump) >= rules.jumpPct * 2 ? 'critical' : 'warning',
        code: q.code,
        name: q.name,
        title: `${q.name} ${jUp ? '急拉' : '急跌'} ${jump >= 0 ? '+' : ''}${jump.toFixed(2)}%`,
        detail: `上次 ${p.price} → 现价 ${q.price} ${q.currency}（间隔内变动 ${jump.toFixed(2)}%，阈值 ${rules.jumpPct}%）· ${q.time || '—'}`,
        link: `/swing?code=${encodeURIComponent(q.code)}`,
        value: jump
      });
    }
  }
  return capEvents(out);
}

/* ============ 个股公告：ID 增量 ============ */

export interface AnnTargetMeta {
  code: string;
  name: string;
  market: AnnMarket;
}

/**
 * 公告新增事件。prevIds === null 表示首次基线，不告警。
 * 标签用同一套 classifyAnn（会按市场走繁简归一 / SEC form / 日韩词表），
 * 与个股分析页的结论保持一致。
 */
export function diffAnnouncements(
  prevIds: Set<string> | null,
  next: AnnInput[],
  meta: AnnTargetMeta,
  rules: MonitorRules,
  now = Date.now()
): MonitorEvent[] {
  if (!prevIds || !rules.enableAnn || !next.length) return [];
  const out: MonitorEvent[] = [];

  for (const raw of next) {
    if (prevIds.has(raw.id)) continue;
    const item: AnnInput = { ...raw, market: raw.market ?? meta.market };
    const c = classifyAnn(item.title, item.column, item.market);
    const isImportant = IMPORTANT_TAGS.has(c.primary);
    if (rules.annImportantOnly && !isImportant) continue;
    if (c.primary === 'other' || c.primary === 'meeting') continue;

    const label = ANN_TAG_META[c.primary]?.label ?? c.primary;
    const critical = c.primary === 'risk' || c.primary === 'lawsuit';
    const toneText = c.tone > 0 ? '偏多' : c.tone < 0 ? '偏空' : '中性';
    out.push({
      id: `ann:${meta.code}:${raw.id}`,
      ts: now,
      kind: 'announcement',
      level: critical ? 'critical' : c.tone < 0 ? 'warning' : 'info',
      code: meta.code,
      name: meta.name,
      title: `${meta.name} 新公告 · ${label}`,
      detail: `${raw.date || '—'} · ${toneText} · ${String(item.title ?? '').slice(0, 60)}` +
        (c.reason ? ` · 命中：${c.reason}` : ''),
      link: `/stock?code=${encodeURIComponent(meta.code)}`,
      value: undefined
    });
  }
  return capEvents(out);
}

/* ============ 展示辅助 ============ */

export const EVENT_KIND_LABEL: Record<EventKind, string> = {
  news: '快讯',
  quote: '行情',
  announcement: '公告',
  system: '系统'
};

export const EVENT_LEVEL_LABEL: Record<EventLevel, string> = {
  critical: '重要',
  warning: '提醒',
  info: '信息'
};

export function formatClock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}
