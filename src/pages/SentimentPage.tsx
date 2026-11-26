import { useCallback, useEffect, useMemo, useState } from 'react';
import EChart from '../components/EChart';
import { C, barOption, distBarOption, lineOption, pieOption, radarOption, signedBarOption, thermometerOption } from '../components/chartOptions';
import { EmptyTip, Loading, MathPanel, MetricGrid, Panel, SourcePill } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { clearSentimentCache, fetchSentiment, latestOf, type SentimentData } from '../data/sentiment';
import { clearBuzzCache, fetchBuzz, type BuzzData } from '../data/buzz';
import { analyzePosts, buzzScore, popularityScore, type PopularStock } from '../math/buzz';
import { TIER_META, analyzeNews, filterNews, newsTopicLabel, type NewsFilter } from '../math/news';
import {
  LEVEL_META,
  RATIO_BANDS,
  driversOf,
  levelOf,
  ratioBand,
  stockMentions,
  structureMetrics,
  summarizeStructure,
  topicStats,
  type TonePost,
  type Topic
} from '../math/structure';
import {
  DIM_ORDER,
  WEATHER_META,
  WEATHER_THRESHOLDS,
  approxHistory,
  distributionOf,
  evaluateSentiment,
  flowText,
  limitStat,
  type Weather
} from '../math/sentiment';

/* ============ 小工具 ============ */

const yi = (v: number | null | undefined): string => {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)} 万亿`;
  if (abs >= 1e8) return `${(v / 1e8).toFixed(1)} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)} 万`;
  return v.toFixed(0);
};

const pctText = (v: number, d = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(d)}%`;

const medianOf = (arr: number[]): number => {
  const a = arr.filter((v) => Number.isFinite(v)).sort((x, y) => x - y);
  if (!a.length) return 0;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

const stdev = (arr: number[]): number => {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  return Math.sqrt(arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length);
};

const timeText = (hhmmss: number): string => {
  const s = String(hhmmss).padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}`;
};

const WEATHER_ORDER: Weather[] = ['storm', 'rain', 'overcast', 'cloudy', 'sunny'];

/** 消息面筛选（默认只看重点，避免 40 条平铺） */
const NEWS_FILTERS: { k: NewsFilter; label: string }[] = [
  { k: 'focus', label: '只看重点' },
  { k: 'all', label: '全部' },
  { k: 'bull', label: '利好' },
  { k: 'bear', label: '利空' },
  { k: 'routine', label: '例行播报' }
];

/**
 * A 股交易时段进度（0~1）。
 * 盘中直接拿「今日成交额 / 20 日全天均额」会永远得出缩量，必须按已走完的时段折算。
 */
function sessionFractionOf(ts: number): number {
  const d = new Date(ts);
  const mins = d.getHours() * 60 + d.getMinutes();
  const open = 9 * 60 + 30;
  const close = 15 * 60;
  if (mins <= open) return 1; // 盘前：用上一交易日全天
  if (mins >= close) return 1;

  // A 股日内成交额呈 U 型：开盘 30 分钟约 20%，上午余下 90 分钟约 25%，
  // 午后前 30 分钟约 15%，尾盘 30 分钟约 20%，中间 60 分钟约 20%。
  // 用线性内插近似累积曲线，比「按分钟数均分」准确得多。
  const el = mins - open; // 已开盘分钟（含午休）
  const p = (from: number, to: number, f0: number, f1: number) => f0 + ((Math.min(Math.max(el, from), to) - from) / (to - from)) * (f1 - f0);
  if (el <= 30) return Math.max(0.02, p(0, 30, 0, 0.2));
  if (el <= 120) return p(30, 120, 0.2, 0.45);
  if (el <= 150) return 0.45; // 午休
  if (el <= 180) return p(150, 180, 0.45, 0.6);
  if (el <= 210) return p(180, 210, 0.6, 0.8);
  return p(210, 240, 0.8, 1);
}

/* ============ 页面 ============ */

export default function SentimentPage() {
  const [data, setData] = useState<SentimentData | null>(null);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // 全网讨论（股吧人气榜 + 热帖 + 千股千评），独立加载，失败不影响主体
  const [buzz, setBuzz] = useState<BuzzData | null>(null);
  const [buzzLoading, setBuzzLoading] = useState(false);

  const load = useCallback(async (force = false) => {
    if (force) {
      clearSentimentCache();
      clearBuzzCache();
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);
    setProgress('');
    try {
      const d = await fetchSentiment({
        force,
        onProgress: (stage, done, total) => setProgress(`${stage} ${done}/${total}`)
      });
      setData(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : '情绪数据不可用');
      setData(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
      setProgress('');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 讨论数据依赖全 A 行情（人气榜只给代码，要靠行情补名称与涨跌幅）
  useEffect(() => {
    if (!data) return;
    let alive = true;
    setBuzzLoading(true);
    fetchBuzz({ quotes: data.stocks.map((s) => ({ code: s.code, name: s.name, pct: s.pct })) })
      .then((b) => {
        if (alive) setBuzz(b);
      })
      .catch(() => {
        if (alive) setBuzz(null);
      })
      .finally(() => {
        if (alive) setBuzzLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [data]);

  /* ---------- 六维输入 ---------- */

  /** 两市成交额：直接由全 A 行情汇总（含北交所），比指数口径更全 */
  const totalAmount = useMemo(
    () => (data ? data.stocks.reduce((s, x) => s + (Number.isFinite(x.amount) ? x.amount : 0), 0) : 0),
    [data]
  );

  /**
   * 沪市成交额。东财 fflow 只给上证指数口径（沪市大单/超大单），
   * 若拿它去除「两市成交额」，比值会被稀释近一半，所以必须同口径相除。
   */
  const shAmount = useMemo(
    () =>
      data
        ? data.stocks.reduce((s, x) => (x.code.startsWith('6') && Number.isFinite(x.amount) ? s + x.amount : s), 0)
        : 0,
    [data]
  );

  /** 交易时段进度（用于把盘中成交额还原成全天口径） */
  const frac = useMemo(() => (data ? sessionFractionOf(data.updatedAt) : 1), [data]);

  const breadthInput = useMemo(() => {
    if (!data || !data.stocks.length) return null;
    const pcts = data.stocks.map((s) => s.pct);
    const up = pcts.filter((p) => p > 0).length;
    const down = pcts.filter((p) => p < 0).length;
    const flat = pcts.length - up - down;
    const ls = limitStat(
      data.limits.up.map((r) => ({ boardCount: r.boardCount })),
      data.limits.down.length,
      data.limits.broke.length
    );
    return {
      total: pcts.length,
      up,
      down,
      flat,
      limitUp: ls.limitUp,
      limitDown: ls.limitDown,
      broke: ls.broke,
      maxBoard: ls.maxBoard,
      medianPct: medianOf(pcts),
      sealRate: ls.sealRate,
      ladder: ls.ladder
    };
  }, [data]);

  const flowInput = useMemo(() => {
    if (!data) return null;
    const flow = data.flow.history;
    const m = latestOf(data.margin.history);
    const amount = shAmount;
    // 主力资金流与两融互为补充：任一可用就让「资金」维度成立
    if (!flow.length && !m) return null;
    const main5 = flow.slice(-5).reduce((s, f) => s + f.main, 0);
    return {
      main: flow.length ? flow[flow.length - 1].main : null,
      amount,
      main5,
      marginNet: m?.rzjme ?? 0,
      marginBal: m?.rzye ?? 0,
      marginDate: m?.date
    };
  }, [data, shAmount]);

  const volInput = useMemo(() => {
    if (!data || data.kline.length < 25) return null;
    const k = data.kline;
    const rets: number[] = [];
    for (let i = 1; i < k.length; i++) rets.push(k[i].close / k[i - 1].close - 1);
    const vol20 = stdev(rets.slice(-20)) * Math.sqrt(252);
    const vol60 = stdev(rets.slice(-60)) * Math.sqrt(252);
    const prev20 = k.slice(-21, -1);
    const avg = prev20.reduce((s, x) => s + x.volume, 0) / (prev20.length || 1);
    const today = k[k.length - 1];
    // 盘中按已走完的时段折算，否则 10 点看永远只有 0.4 倍「缩量」
    const expected = avg * frac;
    return { vol20, vol60, amountRatio: expected > 0 ? today.volume / expected : 1 };
  }, [data, frac]);

  const structureInput = useMemo(() => {
    if (!data || !data.industries.length) return null;
    const ups = data.industries.filter((i) => i.chgPct > 0).length;
    return {
      upCount: ups,
      total: data.industries.length,
      medianPct: medianOf(data.industries.map((i) => i.chgPct))
    };
  }, [data]);

  /* ---------- 全网讨论 ---------- */

  /** 人气榜补上名称与涨跌幅（人气榜接口只给代码） */
  const popular = useMemo<PopularStock[]>(() => {
    if (!buzz || !data) return [];
    const qm = new Map(data.stocks.map((x) => [x.code, x]));
    return buzz.popular
      .map((p) => {
        const q = qm.get(p.code);
        return {
          code: p.code,
          name: q?.name ?? p.code,
          rank: p.rank,
          rankChange: p.rankChange,
          pct: q?.pct ?? 0,
          turnover: 0
        };
      })
      .filter((p) => Number.isFinite(p.pct));
  }, [buzz, data]);

  const buzzPosts = useMemo(() => (buzz && buzz.posts.length ? analyzePosts(buzz.posts) : null), [buzz]);

  /** 去重后淘股吧 / 股吧各占多少条（用于展示，避免与总数对不上） */
  const postSplit = useMemo(() => {
    const list = buzzPosts?.posts ?? [];
    const taogu = list.filter((p) => p.code === 'tgb').length;
    return { taogu, guba: list.length - taogu, total: list.length };
  }, [buzzPosts]);

  /** 人气榜 TOP30 的赚钱效应 */
  const popStats = useMemo(() => {
    const top = popular.slice(0, 30);
    if (!top.length) return null;
    const up = top.filter((x) => x.pct > 0).length;
    const avg = top.reduce((x, y) => x + y.pct, 0) / top.length;
    return { up, total: top.length, avg, score: popularityScore(popular) };
  }, [popular]);

  const buzzInput = useMemo(() => {
    const sc = buzzScore(popular.length ? popular : null, buzzPosts);
    if (sc == null) return null;
    const parts: string[] = [];
    if (buzzPosts) {
      parts.push(
        `股吧热帖 ${buzzPosts.posts.length} 条（看多 ${buzzPosts.bull} / 看空 ${buzzPosts.bear} / 中性 ${buzzPosts.neutral}）`
      );
    }
    if (popStats) {
      parts.push(`人气榜 TOP${popStats.total} 上涨 ${popStats.up} 家、平均 ${pctText(popStats.avg)}`);
    }
    return { score: sc, detail: parts.join('，') || '讨论数据不足' };
  }, [popular, buzzPosts, popStats]);

  const result = useMemo(() => {
    if (!breadthInput) return null;
    return evaluateSentiment({
      breadth: breadthInput,
      flow: flowInput,
      structure: structureInput,
      vol: volInput,
      buzz: buzzInput
    });
  }, [breadthInput, flowInput, structureInput, volInput, buzzInput]);

  /* ---------- 图表 option ---------- */

  const weather = result ? WEATHER_META[result.weather] : null;

  const thermo = useMemo(() => {
    if (!result || !weather) return null;
    return thermometerOption(result.score, { label: `${weather.icon} ${weather.label}`, color: weather.color });
  }, [result, weather]);

  const radar = useMemo(() => {
    if (!result) return null;
    return radarOption(
      result.dims.map((d) => ({ name: d.label, max: 100 })),
      [
        {
          name: '当前情绪',
          value: result.dims.map((d) => (d.available ? Math.round(d.score) : 0)),
          color: weather?.color ?? C.accent
        },
        { name: '中性基准', value: result.dims.map(() => 50), color: C.gray }
      ]
    );
  }, [result, weather]);

  const dist = useMemo(() => {
    if (!data) return null;
    return distributionOf(data.stocks.map((s) => s.pct));
  }, [data]);

  const distOpt = useMemo(() => {
    if (!dist) return null;
    return distBarOption(
      dist.map((b) => b.label),
      dist.map((b) => b.count),
      dist.map((b) => b.up)
    );
  }, [dist]);

  const ladderOpt = useMemo(() => {
    if (!breadthInput || !breadthInput.ladder.length) return null;
    // 连板越高越「热」，颜色从灰蓝过渡到红，一眼看出梯队厚度与高标位置
    const colorOf = (level: number) =>
      level >= 5 ? C.up : level === 4 ? '#e06a3c' : level === 3 ? C.orange : level === 2 ? C.amber : C.gray;
    return barOption(
      breadthInput.ladder.map((l) => (l.level === 1 ? '首板' : `${l.level} 板`)),
      [
        {
          name: '家数',
          data: breadthInput.ladder.map((l) => l.count),
          colors: breadthInput.ladder.map((l) => colorOf(l.level))
        }
      ],
      { labels: true, unit: ' 家', digits: 0 }
    );
  }, [breadthInput]);

  const moodOpt = useMemo(() => {
    if (!data || !data.industries.length) return null;
    const sorted = [...data.industries].sort((a, b) => b.chgPct - a.chgPct);
    const top = sorted.slice(0, 10);
    const bottom = sorted.slice(-10).filter((x) => !top.includes(x));
    const rows = [...top, ...bottom].sort((a, b) => b.chgPct - a.chgPct);
    return signedBarOption(
      rows.map((r) => r.name),
      rows.map((r) => r.chgPct),
      { unit: '%', name: '板块涨跌幅', inverse: true }
    );
  }, [data]);

  const flowOpt = useMemo(() => {
    if (!data || data.flow.history.length < 2) return null;
    const rows = data.flow.history.slice(-20);
    return signedBarOption(
      rows.map((r) => r.date.slice(5)),
      rows.map((r) => Number((r.main / 1e8).toFixed(2))),
      { unit: ' 亿', name: '主力净流入' }
    );
  }, [data]);

  /** 主力资金流不可达时的替代口径：融资净买入（同样是一条「资金净流入」序列） */
  const marginFlowOpt = useMemo(() => {
    if (!data || data.margin.history.length < 2) return null;
    const rows = data.margin.history.slice(-20);
    return signedBarOption(
      rows.map((r) => r.date.slice(5)),
      rows.map((r) => Number((r.rzjme / 1e8).toFixed(2))),
      { unit: ' 亿', name: '融资净买入', vertical: true }
    );
  }, [data]);

  const marginOpt = useMemo(() => {
    if (!data || data.margin.history.length < 2) return null;
    const rows = data.margin.history.slice(-40);
    return lineOption(
      rows.map((r) => r.date.slice(5)),
      [
        {
          name: '融资余额（万亿）',
          data: rows.map((r) => Number((r.rzye / 1e12).toFixed(3))),
          color: C.accent,
          area: true
        }
      ],
      { yName: '万亿元' }
    );
  }, [data]);

  const historyOpt = useMemo(() => {
    if (!data || data.kline.length < 30) return null;
    const hist = approxHistory(data.kline, 60);
    if (!hist.length) return null;
    const volMap = new Map(data.kline.map((k) => [k.date, k.volume]));
    return lineOption(
      hist.map((h) => h.date.slice(5)),
      [
        { name: '近似情绪温度', data: hist.map((h) => Number(h.score.toFixed(1))), color: C.purple, area: true },
        {
          name: '沪市成交量（亿手）',
          data: hist.map((h) => Number(((volMap.get(h.date) ?? 0) / 1e8).toFixed(2))),
          color: C.orange,
          yAxisIndex: 1,
          dashed: true
        }
      ],
      { yName: '温度分', rightName: '亿手' }
    );
  }, [data]);

  /** 热帖多空比环图 */
  const toneOpt = useMemo(() => {
    if (!buzzPosts || !buzzPosts.posts.length) return null;
    const total = buzzPosts.posts.length;
    return pieOption([
      { name: '看多', value: buzzPosts.bull / total, color: C.up },
      { name: '中性', value: buzzPosts.neutral / total, color: C.gray },
      { name: '看空', value: buzzPosts.bear / total, color: C.down }
    ]);
  }, [buzzPosts]);

  /** 关注度分布（千股千评 TOP20 太少，这里用全市场？—— 只用 TOP20 会失真，故仅展示榜单） */

  /** 消息面（财联社快讯）：分级 + 分主题 + 加权多空比 */
  const newsStats = useMemo(() => analyzeNews(buzz?.news ?? []), [buzz]);

  /** 消息面筛选状态 */
  const [newsFilter, setNewsFilter] = useState<NewsFilter>('focus');
  const [newsTopic, setNewsTopic] = useState<Topic | null>(null);

  /** 当前筛选下的列表；「焦点」与上方焦点卡片保持同一份数据，避免两处条数不一致 */
  const shownNews = useMemo(() => {
    if (newsFilter === 'focus') {
      const rows = newsTopic ? newsStats.focus.filter((n) => n.topic === newsTopic) : newsStats.focus;
      return rows.length ? rows : newsStats.items;
    }
    const rows = filterNews(newsStats.items, newsFilter, newsTopic);
    if (rows.length) return rows;
    return filterNews(newsStats.items, 'all', newsTopic);
  }, [newsStats, newsFilter, newsTopic]);

  /* ---------- 情绪结构（归因 / 阈值 / 分歧） ---------- */

  /** 股票名 → 代码，用于从标题里抽个股 */
  const stockIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of data?.stocks ?? []) {
      if (s.name && s.name.length >= 3) m.set(s.name, s.code);
    }
    return m;
  }, [data]);

  const structure = useMemo(() => {
    const forumPosts: TonePost[] = (buzzPosts?.posts ?? []).map((p) => ({ text: p.title, tone: p.tone, heat: p.heat }));
    const newsPosts: TonePost[] = newsStats.items.map((n) => ({ text: n.text, tone: n.tone, heat: n.read }));
    const all = [...forumPosts, ...newsPosts];
    if (!all.length) return null;

    const topics = topicStats(all);
    const forumRatio = buzzPosts?.bullRatio ?? null;
    // 消息面方向优先用「影响力加权」口径：一条央行降准不该和一条小公告等权
    const newsRatio = newsStats.weightedRatio ?? newsStats.ratio;

    // 合并口径的多空比（论坛 + 快讯）
    const bull = forumPosts.filter((p) => p.tone === 1).length + newsPosts.filter((p) => p.tone === 1).length;
    const bear = forumPosts.filter((p) => p.tone === -1).length + newsPosts.filter((p) => p.tone === -1).length;
    const ratio = bull + bear > 0 ? bull / (bull + bear) : null;

    const metrics = structureMetrics({
      ratio,
      volume: all.length,
      topics,
      newsRatio,
      forumRatio,
      medianPct: breadthInput?.medianPct ?? 0,
      volumeBaseline: 120
    });

    const band = ratioBand((ratio ?? 0.5) * 100);
    const { level, band: tempBand } = levelOf(result?.score ?? 50);
    const bullDrivers = driversOf(topics, 1);
    const bearDrivers = driversOf(topics, -1);
    const stocks = stockMentions(all, stockIndex, 10);

    const lines = summarizeStructure({
      ratio,
      sample: bull + bear,
      band,
      level,
      tempBand,
      metrics,
      bullDrivers,
      bearDrivers,
      topStocks: stocks
    });

    return { topics, ratio, band, level, tempBand, metrics, bullDrivers, bearDrivers, stocks, lines, sample: bull + bear };
  }, [buzzPosts, newsStats, breadthInput, result, stockIndex]);

  /** 看多 / 看空归因条形 */
  const bullDriverOpt = useMemo(() => {
    if (!structure?.bullDrivers.length) return null;
    return barOption(
      structure.bullDrivers.map((d) => d.label),
      [{ name: '看多', data: structure.bullDrivers.map((d) => d.count), color: C.up }],
      { horizontal: true, labels: true, unit: ' 条', digits: 0 }
    );
  }, [structure]);

  const bearDriverOpt = useMemo(() => {
    if (!structure?.bearDrivers.length) return null;
    return barOption(
      structure.bearDrivers.map((d) => d.label),
      [{ name: '看空', data: structure.bearDrivers.map((d) => d.count), color: C.down }],
      { horizontal: true, labels: true, unit: ' 条', digits: 0 }
    );
  }, [structure]);

  /** 人气榜表格（有热帖时放右栏，无热帖时占满整行，避免出现大块空白） */
  const popularTable = (
    <div className="tbl-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 40 }}>#</th>
            <th>名称</th>
            <th className="num">涨跌幅</th>
            <th className="num">排名变化</th>
          </tr>
        </thead>
        <tbody>
          {popular.slice(0, 10).map((p) => (
            <tr key={p.code}>
              <td>{p.rank}</td>
              <td>
                <b>{p.name}</b>
                <span className="mono" style={{ marginLeft: 6 }}>
                  {p.code}
                </span>
              </td>
              <td className="num" style={{ color: p.pct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                {pctText(p.pct)}
              </td>
              <td className="num" style={{ color: p.rankChange > 0 ? 'var(--up)' : p.rankChange < 0 ? 'var(--down)' : 'var(--text-3)' }}>
                {p.rankChange === 0 ? '—' : `${p.rankChange > 0 ? '↑' : '↓'}${Math.abs(p.rankChange)}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );

  /* ---------- 渲染 ---------- */

  return (
    <div>
      <div className="page-title-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2>🌡️ 市场情绪晴雨表</h2>
        <span className="en">Market Sentiment Barometer</span>
        {data && <SourcePill source="sina" cacheTs={data.updatedAt} />}
        {data && <span className="inst-hint">全A行情 新浪 · 涨停池 东财 · 资金流 东财 · 两融 东财数据中心</span>}
        <button
          type="button"
          className="chip-toggle"
          style={{ marginLeft: 'auto' }}
          disabled={refreshing || loading}
          onClick={() => void load(true)}
        >
          {refreshing ? '刷新中…' : '🔄 刷新'}
        </button>
      </div>

      <p className="page-lead">
        情绪不是单一指标：涨跌家数说明「多少人赚钱」，涨停/炸板说明「短线资金敢不敢打」，主力与两融说明「真金白银往哪走」，
        量能与波动说明「市场是热还是慌」，股吧人气与热帖说明「散户在聊什么」。
        这里把七类信号各自打 0~100 分，再加权成一个市场温度，并映射成五档天气。
        行情来自新浪全 A，涨停池/资金流/两融/千股千评来自东财，讨论来自股吧。
      </p>

      {loading && <Loading text={progress || '正在采集全市场行情、涨停池、资金流与两融数据…'} />}

      {!loading && error && (
        <div className="inst-error">
          <span>⚠️ 情绪数据不可用：{error}</span>
          <button type="button" className="gear-btn" onClick={() => void load(true)}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && data && result && breadthInput && (
        <>
          {data.warnings.length > 0 && (
            <div className="inst-notice">
              <span>
                ⚠️ 部分数据源不可用：{data.warnings.join('；')}。缺失维度已从加权中剔除并重新归一，结论仅供参考。
              </span>
            </div>
          )}

          {breadthInput.limitUp + breadthInput.limitDown + breadthInput.broke === 0 && (
            <div className="inst-notice">
              <span>
                🌙 当前非交易时段（或涨停池当日无数据）：涨停/跌停/炸板为空，<b>打板强度维度已剔除</b>，
                温度分只由涨跌广度、资金、量能、结构、波动合成。
              </span>
            </div>
          )}

          {/* ===== 顶部：晴雨表 ===== */}
          <div className="sent-hero">
            <div className="sent-gauge">
              {thermo && <EChart option={thermo} height={248} />}
            </div>
            <div className="sent-hero-main">
              <div className="weather-strip">
                {WEATHER_ORDER.map((w) => {
                  const m = WEATHER_META[w];
                  const on = result.weather === w;
                  return (
                    <div key={w} className={'weather-cell' + (on ? ' on' : '')} style={on ? { borderColor: m.color } : undefined}>
                      <span className="wc-ico" style={{ filter: on ? 'none' : 'grayscale(0.7)' }}>
                        {m.icon}
                      </span>
                      <span className="wc-label" style={on ? { color: m.color } : undefined}>
                        {m.label}
                      </span>
                      <span className="wc-range">{WEATHER_THRESHOLDS.find((t) => t.weather === w)?.min ?? 0}+</span>
                    </div>
                  );
                })}
              </div>

              <p className="sent-summary">{result.summary}</p>

              <div className="sent-alerts">
                {result.alerts.length === 0 && (
                  <div className="sent-alert info">
                    <b>无极端信号</b>
                    <span>七维均未触发亢奋/冰点阈值，属于常规波动区间。</span>
                  </div>
                )}
                {result.alerts.map((a) => (
                  <div key={a.title} className={`sent-alert ${a.tone}`}>
                    <b>{a.title}</b>
                    <span>{a.text}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ===== 指标卡 ===== */}
          <MetricGrid
            items={[
              {
                label: '上涨 / 下跌',
                value: `${breadthInput.up} / ${breadthInput.down}`,
                sub: `平盘 ${breadthInput.flat} · 上涨占比 ${((breadthInput.up / breadthInput.total) * 100).toFixed(1)}%`,
                tone: breadthInput.up > breadthInput.down ? 'up' : breadthInput.up < breadthInput.down ? 'down' : 'flat'
              },
              {
                label: '涨停 / 跌停',
                value: `${breadthInput.limitUp} / ${breadthInput.limitDown}`,
                sub:
                  breadthInput.limitUp + breadthInput.limitDown === 0
                    ? '非交易时段无数据'
                    : `炸板 ${breadthInput.broke} · 封板率 ${(breadthInput.sealRate * 100).toFixed(0)}%`,
                tone: breadthInput.limitUp > breadthInput.limitDown ? 'up' : breadthInput.limitUp < breadthInput.limitDown ? 'down' : 'flat'
              },
              {
                label: '两市成交额',
                value: yi(totalAmount),
                sub: volInput
                  ? `${volInput.amountRatio.toFixed(2)} 倍于 20 日均额${frac < 1 ? `（按 ${(frac * 100).toFixed(0)}% 时段折算）` : ''}`
                  : '量能数据不可用',
                tone: volInput ? (volInput.amountRatio >= 1.15 ? 'up' : volInput.amountRatio < 0.85 ? 'down' : 'flat') : undefined
              },
              {
                label: '主力净流入（沪市）',
                value: flowInput?.main != null ? yi(flowInput.main) : '—',
                sub:
                  flowInput?.main != null && flowInput.amount > 0
                    ? `占沪市成交额 ${((flowInput.main / flowInput.amount) * 100).toFixed(2)}% · 5 日${flowText(flowInput.main5)}`
                    : '东财资金流不可用，资金维度改用两融口径',
                tone: flowInput?.main != null ? (flowInput.main >= 0 ? 'up' : 'down') : undefined
              },
              {
                label: '融资余额',
                value: yi(latestOf(data.margin.history)?.rzye ?? null),
                sub: latestOf(data.margin.history)
                  ? `融资${flowText(latestOf(data.margin.history)?.rzjme ?? 0)} · ${latestOf(data.margin.history)?.date.slice(5)}`
                  : '两融数据不可用'
              },
              {
                label: '最高连板',
                value: breadthInput.maxBoard > 0 ? `${breadthInput.maxBoard} 板` : '—',
                sub: breadthInput.maxBoard >= 5 ? '情绪高标仍在，短线活跃' : '无高标，短线偏谨慎'
              }
            ]}
          />

          {/* ===== 六维 ===== */}
          <div className="grid-2" style={{ marginTop: 16 }}>
            <Panel title="七维情绪雷达" icon="🕸️" desc="灰线为中性基准 50 分，超出部分是该维度对多头的支撑；共七维">
              {radar ? <EChart option={radar} height={300} /> : <EmptyTip text="维度数据不可用" />}
            </Panel>
            <Panel title="维度拆解与贡献" icon="🧩" desc="条形长度 = 得分，右侧数字 = 对综合温度的实际贡献（分）">
              <div className="dim-list">
                {DIM_ORDER.map((k) => {
                  const d = result.dims.find((x) => x.key === k);
                  if (!d) return null;
                  return (
                    <div key={k} className={'dim-row' + (d.available ? '' : ' off')}>
                      <div className="dim-top">
                        <span className="dim-name">
                          {d.icon} {d.label}
                          <em>{d.weight > 0 ? `权重 ${(d.weight * 100).toFixed(0)}%` : '已剔除'}</em>
                        </span>
                        <span className="dim-score" style={{ color: scoreColor(d.score) }}>
                          {d.available ? d.score.toFixed(0) : '—'}
                        </span>
                      </div>
                      <div className="dim-bar">
                        <div style={{ width: `${d.available ? d.score : 0}%`, background: scoreColor(d.score) }} />
                        <i style={{ left: '50%' }} />
                      </div>
                      <div className="dim-foot">
                        <span>{d.detail}</span>
                        <b className={d.contribution > 0.5 ? 'd-up' : d.contribution < -0.5 ? 'd-down' : 'd-flat'}>
                          {d.contribution >= 0 ? '+' : ''}
                          {d.contribution.toFixed(1)}
                        </b>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>
          </div>

          {/* ===== 涨跌结构 ===== */}
          <div className="grid-2" style={{ marginTop: 16 }}>
            <Panel
              title="涨跌分布"
              icon="📊"
              desc={`全市场 ${breadthInput.total.toLocaleString()} 只个股的涨跌幅分布，中位数 ${pctText(breadthInput.medianPct)}`}
            >
              {distOpt ? <EChart option={distOpt} height={260} /> : <EmptyTip text="分布数据不可用" />}
              <div className="inst-hint">
                左绿右红：红柱越靠右越粗，说明赚钱效应越强。若「-1~0」与「0~1」两根特别高，说明市场在窄幅震荡、缺乏方向。
              </div>
            </Panel>
            <Panel title="打板梯队" icon="🔥" desc="连板高度是短线情绪的骨架：有高标才有接力，断层则退潮">
              {ladderOpt ? <EChart option={ladderOpt} height={260} /> : <EmptyTip text="非交易时段无涨停池数据" />}
              <div className="inst-hint">
                封板率 {(breadthInput.sealRate * 100).toFixed(0)}%（涨停 / (涨停+炸板)）；最高 {breadthInput.maxBoard} 连板。
                封板率低于 60% 说明封单不坚决，次日溢价不稳定。
              </div>
            </Panel>
          </div>

          {/* ===== 情绪时序 ===== */}
          <Panel
            title="情绪温度趋势（近 60 个交易日）"
            icon="📈"
            desc="实线为量价派生的近似温度，虚线为沪市成交量；用于看趋势与拐点，绝对值不可与当日六维分直接比较"
            style={{ marginTop: 16 }}
          >
            {historyOpt ? <EChart option={historyOpt} height={280} /> : <EmptyTip text="指数日线不足，无法回溯" />}
            <div className="inst-hint">
              近似温度 = 0.45 × 动量分 + 0.35 × 量能分 + 0.20 × 波动分。历史涨跌家数与历史资金流无法回溯，
              所以这条线只反映「量价冷暖」，当日温度才是六维完整口径。
            </div>
          </Panel>

          {/* ===== 资金面 ===== */}
          <div className="grid-2" style={{ marginTop: 16 }}>
            <Panel
              title={flowOpt ? '主力资金流（近 20 日）' : '融资净买入（近 20 日）'}
              icon={flowOpt ? '💰' : '🏦'}
              desc={
                flowOpt
                  ? '上证指数口径的主力净流入，红柱流入、绿柱流出（单位：亿元）'
                  : '东财主力资金流接口当前不可达（push2his 整域连不上），改看杠杆资金的净买入：红柱净买入、绿柱净偿还（单位：亿元）'
              }
              extra={
                !flowOpt ? (
                  <button
                    type="button"
                    className="chip-toggle"
                    disabled={refreshing}
                    onClick={() => void load(true)}
                    title="重新拉取东财主力资金流"
                  >
                    {refreshing ? '刷新中…' : '🔄 重试主力口径'}
                  </button>
                ) : undefined
              }
            >
              {flowOpt ? (
                <EChart option={flowOpt} height={250} />
              ) : marginFlowOpt ? (
                <EChart option={marginFlowOpt} height={250} />
              ) : (
                <EmptyTip text="主力与两融资金流都不可用" />
              )}
            </Panel>
            <Panel
              title="融资余额"
              icon="🏦"
              desc={`杠杆资金水位；最新一期 ${latestOf(data.margin.history)?.date ?? '—'}（两融数据通常滞后行情 1 个交易日）`}
            >
              {marginOpt ? <EChart option={marginOpt} height={250} /> : <EmptyTip text="两融数据不可用" />}
            </Panel>
          </div>

          {/* ===== 行业情绪 ===== */}
          <Panel
            title="行业情绪 · 涨跌两端"
            icon="🏭"
            desc={
              structureInput
                ? `新浪行业分类（${structureInput.total} 个）：${structureInput.upCount} 个上涨（${((structureInput.upCount / structureInput.total) * 100).toFixed(0)}%），行业涨幅中位 ${pctText(structureInput.medianPct)}`
                : '行业板块数据不可用'
            }
            style={{ marginTop: 16 }}
          >
            {moodOpt ? <EChart option={moodOpt} height={Math.max(300, 20 * 20)} /> : <EmptyTip text="行业板块不可用" />}
            <div className="inst-hint">取涨幅前 10 与跌幅后 10 的行业；中间那批「不涨不跌」的行业才是分化的主体。</div>
          </Panel>

          <Panel title={`行业情绪明细 · ${data.industries.length} 个行业（新浪分类）`} icon="📋" style={{ marginTop: 16 }}>
            {data.industries.length ? (
              <div className="tbl-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>#</th>
                      <th>行业</th>
                      <th className="num">涨跌幅</th>
                      <th className="num">成分股</th>
                      <th className="num">成交额</th>
                      <th>领涨股</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.industries.map((r, i) => (
                      <tr key={r.code}>
                        <td>{i + 1}</td>
                        <td>
                          <b>{r.name}</b>
                        </td>
                        <td className="num" style={{ color: r.chgPct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                          {pctText(r.chgPct)}
                        </td>
                        <td className="num">{r.members}</td>
                        <td className="num">{yi(r.amount)}</td>
                        <td>
                          {r.leader || '—'}
                          {r.leaderPct ? (
                            <em style={{ marginLeft: 6, color: r.leaderPct >= 0 ? 'var(--up)' : 'var(--down)' }}>{pctText(r.leaderPct)}</em>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <EmptyTip text="行业板块数据不可用" />
            )}
          </Panel>

          {/* ===== 全网讨论 ===== */}
          <Panel
            title="全网讨论 · 股吧热度与多空"
            icon="💬"
            desc="淘股吧（全市场论坛）+ 股吧（最热个股）双源：人气榜看「谁在被追」，热帖看「在说什么」"
            extra={
              buzzLoading ? (
                <span className="inst-hint">正在抓取股吧…</span>
              ) : buzz ? (
                <span className="inst-hint">
                  {buzzPosts?.posts.length ? `热帖 ${buzzPosts.posts.length} 条 · ` : ''}人气榜 {popular.length} 只
                </span>
              ) : undefined
            }
            style={{ marginTop: 16 }}
          >
            {buzzLoading && !buzz && <Loading text="正在抓取股吧人气榜、热帖与千股千评…" />}
            {!buzzLoading && !buzz && <EmptyTip text="讨论数据不可用（股吧接口可能被限流），其余维度不受影响" />}
            {buzz && (
              <>
                {buzz.warnings.filter((w) => !w.startsWith('股吧热帖')).length > 0 && (
                  <div className="inst-notice" style={{ marginBottom: 10 }}>
                    <span>⚠️ {buzz.warnings.filter((w) => !w.startsWith('股吧热帖')).join('；')}</span>
                  </div>
                )}
                <div className="ind-facts">
                  <span>
                    讨论分 <b style={{ color: scoreColor(buzzInput?.score ?? 50) }}>{buzzInput?.score?.toFixed(0) ?? '—'}</b>
                  </span>
                  {buzzPosts && buzzPosts.posts.length > 0 ? (
                    <>
                      <span>
                        热帖看多 <b style={{ color: 'var(--up)' }}>{buzzPosts.bull}</b> / 看空{' '}
                        <b style={{ color: 'var(--down)' }}>{buzzPosts.bear}</b> / 中性 {buzzPosts.neutral}
                      </span>
                      <span>
                        多空比 <b>{buzzPosts.bullRatio != null ? `${(buzzPosts.bullRatio * 100).toFixed(0)}%` : '—'}</b>
                      </span>
                    </>
                  ) : (
                    <span>
                      热帖 <b style={{ color: 'var(--text-3)' }}>不可用</b>
                    </span>
                  )}
                  <span>
                    人气榜 TOP{popStats?.total ?? 0} 上涨{' '}
                    <b style={{ color: (popStats?.up ?? 0) * 2 > (popStats?.total ?? 1) ? 'var(--up)' : 'var(--down)' }}>
                      {popStats?.up ?? 0}/{popStats?.total ?? 0}
                    </b>
                  </span>
                  <span>
                    平均涨幅 <b>{popStats ? pctText(popStats.avg) : '—'}</b>
                  </span>
                  <span>
                    讨论帖 <b>{postSplit.taogu}</b> 淘股吧 + <b>{postSplit.guba}</b> 股吧
                  </span>
                  <span>
                    关注度榜 <b>{buzz.focus.length}</b> 只 · {buzz.focusDate || '—'}
                  </span>
                </div>

                {buzzPosts && buzzPosts.posts.length > 0 ? (
                  <div className="grid-2" style={{ marginTop: 12 }}>
                    <div>
                      <div className="ind-sub">
                        热帖多空比 · 词典打分
                        <em style={{ marginLeft: 8, fontWeight: 400, fontSize: 11, color: 'var(--text-3)' }}>
                          淘股吧 {postSplit.taogu} 条 + 股吧 {postSplit.guba} 条
                          {buzz.postsSource === 'mobile' ? '（移动端）' : ''}
                        </em>
                      </div>
                      {toneOpt ? <EChart option={toneOpt} height={250} /> : <EmptyTip text="未取到热帖" />}
                      <div className="inst-hint">
                        标题按「强词 ±2 / 弱词 ±1」打分，前置否定词（不/没/别）翻转极性；「复盘/早评/公告」等资讯型标题记中性。
                        词典法读不出反讽与谐音，所以它只占综合温度 12% 权重。
                        {buzzPosts.bull + buzzPosts.bear < 20 && (
                          <b style={{ color: 'var(--amber)' }}>
                            {' '}
                            本次有效样本仅 {buzzPosts.bull + buzzPosts.bear} 条，多空比波动会较大。
                          </b>
                        )}
                      </div>
                    </div>
                    <div>
                      <div className="ind-sub">股吧人气榜 TOP 10 · 散户在追什么</div>
                      {popularTable}
                      <div className="inst-hint">
                        排名变化为「较上次统计的名次变动」。人气榜前列若集体下跌，说明人气正在变成接盘。
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="inst-notice" style={{ marginTop: 10 }}>
                      <span>
                        💬 讨论帖暂时取不到（淘股吧与股吧均无返回；股吧 PC 端可能已触发「身份核实」验证码），
                        多空比不可用。讨论维度已自动退化为<b>「人气榜赚钱效应」单因子</b>，不影响其余六维。
                      </span>
                    </div>
                    <div style={{ marginTop: 12 }}>
                      <div className="ind-sub">股吧人气榜 TOP 10 · 散户在追什么</div>
                      {popularTable}
                      <div className="inst-hint">
                        排名变化为「较上次统计的名次变动」。人气榜前列若集体下跌，说明人气正在变成接盘。
                      </div>
                    </div>
                  </>
                )}
              </>
            )}
          </Panel>

          {buzzPosts && buzzPosts.posts.length > 0 && (
            <Panel
              title={`讨论热帖流 · ${buzzPosts.posts.length} 条`}
              icon="📝"
              desc="按热度（阅读 + 评论×20）排序，来自淘股吧全市场论坛与人气榜最热个股的股吧；左侧标签是词典判定的多空"
              style={{ marginTop: 16 }}
            >
              <div className="post-list">
                {buzzPosts.posts.slice(0, 24).map((p, i) => (
                  <div className="post-item" key={`${p.code}-${i}`}>
                    <span className={`post-tone ${p.tone > 0 ? 'up' : p.tone < 0 ? 'down' : 'flat'}`}>
                      {p.tone > 0 ? '看多' : p.tone < 0 ? '看空' : '中性'}
                    </span>
                    <span className="post-title" title={p.title}>
                      {p.title}
                    </span>
                    <span className="post-meta">
                      {p.name}
                      {p.read || p.reply ? ` · 阅 ${p.read.toLocaleString()} / 评 ${p.reply}` : ''}
                      {p.time ? ` · ${p.time}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              <div className="inst-hint">
                标题为股吧原始内容，仅做多空标注，不代表本工具观点。热帖里的「喊单」往往滞后于价格，
                更适合当反向指标看极端情绪。
              </div>
            </Panel>
          )}

          {newsStats.total > 0 && (
            <Panel
              title={`消息面 · 财联社电报 ${newsStats.total} 条`}
              icon="📰"
              desc="快讯先按影响力分级（S/A/B/C），再按主题归类，最后用影响力加权算多空比——避免 40 条小公告把 1 条央行降准淹没"
              extra={
                <span className="inst-hint">
                  S {newsStats.tierCount.S} · A {newsStats.tierCount.A} · 加权多空比{' '}
                  <b>{newsStats.weightedRatio != null ? `${(newsStats.weightedRatio * 100).toFixed(0)}%` : '—'}</b>
                </span>
              }
              style={{ marginTop: 16 }}
            >
              {/* 自动结论：先说结论，再给明细 */}
              <div className="news-brief">
                {newsStats.lines.map((l, i) => (
                  <p key={i}>
                    <span className="nb-dot" />
                    {l}
                  </p>
                ))}
              </div>

              <div className="ind-facts">
                <span>
                  利好 <b style={{ color: 'var(--up)' }}>{newsStats.bull}</b> / 利空{' '}
                  <b style={{ color: 'var(--down)' }}>{newsStats.bear}</b> / 中性 {newsStats.neutral}
                </span>
                <span>
                  条数多空比 <b>{newsStats.ratio != null ? `${(newsStats.ratio * 100).toFixed(0)}%` : '—'}</b>
                </span>
                <span>
                  影响力加权 <b>{newsStats.weightedRatio != null ? `${(newsStats.weightedRatio * 100).toFixed(0)}%` : '—'}</b>
                  {newsStats.gap != null && Math.abs(newsStats.gap) >= 8 && (
                    <em className="nf-gap">{newsStats.gap > 0 ? '+' : ''}{newsStats.gap}pp</em>
                  )}
                </span>
                <span>
                  S/A 级 <b>{newsStats.tierCount.S + newsStats.tierCount.A}</b> 条 · 合集{' '}
                  <b>{newsStats.digestCount}</b> · 例行 <b>{newsStats.routineCount}</b>
                </span>
              </div>

              {/* 焦点：S/A 级消息单独提出来 */}
              {newsStats.focus.length > 0 && (
                <>
                  <div className="news-sec-title">
                    <b>🎯 今日焦点</b>
                    <span>S/A 级按影响力排序，点标题看命中理由</span>
                  </div>
                  <div className="news-focus">
                    {newsStats.focus.map((n) => (
                      <article className={`nfc t-${n.tier}`} key={n.id}>
                        <div className="nfc-head">
                          <span className={`tier-badge t-${n.tier}`} title={TIER_META[n.tier].note}>
                            {n.tier}
                          </span>
                          <span className="news-time">{n.time || '—'}</span>
                          <span className="nfc-topic">
                            {n.topicIcon} {n.topicLabel}
                          </span>
                          <span className={`post-tone ${n.tone > 0 ? 'up' : n.tone < 0 ? 'down' : 'flat'}`}>
                            {n.tone > 0 ? (n.strength === 2 ? '强利好' : '利好') : n.tone < 0 ? (n.strength === 2 ? '强利空' : '利空') : '中性'}
                          </span>
                          <span className="nfc-impact" title={n.reasons.join(' · ')}>
                            影响力 <b>{n.impact}</b>
                          </span>
                        </div>
                        {n.title && <p className="nfc-title">{n.title}</p>}
                        <p className="nfc-text" title={n.text}>{n.body || n.text}</p>
                        <div className="nfc-reasons">{n.reasons.join(' · ') || '无加权项'}</div>
                      </article>
                    ))}
                  </div>
                </>
              )}

              {/* 主题分布：条形长度=影响力占比，红绿=多空构成 */}
              <div className="news-sec-title">
                <b>🧩 主题分布</b>
                <span>点主题筛选；条形=影响力占比，右侧红绿=多空条数</span>
              </div>
              <div className="news-topics">
                {newsStats.topics.slice(0, 8).map((t) => {
                  const on = newsTopic === t.topic;
                  return (
                    <button
                      key={t.topic}
                      className={`nt-row${on ? ' on' : ''}`}
                      onClick={() => setNewsTopic(on ? null : t.topic)}
                      title={`${t.label}：${t.total} 条，影响力 ${t.impactSum} 分，利好 ${t.bull} / 利空 ${t.bear}`}
                    >
                      <span className="nt-name">
                        {t.icon} {t.label}
                      </span>
                      <span className="nt-bar">
                        <i style={{ width: `${Math.max(2, t.impactShare * 100)}%` }} />
                      </span>
                      <span className="nt-num">{t.total} 条</span>
                      <span className="nt-split">
                        {t.bull + t.bear === 0 ? (
                          <i className="flat" style={{ flex: 1 }} />
                        ) : (
                          <>
                            <i className="up" style={{ flex: Math.max(t.bull, 0.4) }} />
                            <i className="down" style={{ flex: Math.max(t.bear, 0.4) }} />
                          </>
                        )}
                      </span>
                      <span className="nt-impact">{t.impactSum}</span>
                    </button>
                  );
                })}
              </div>

              {/* 筛选 + 明细 */}
              <div className="news-chips">
                {NEWS_FILTERS.map((f) => (
                  <button
                    key={f.k}
                    className={`news-chip${newsFilter === f.k ? ' on' : ''}`}
                    onClick={() => setNewsFilter(f.k)}
                  >
                    {f.label}
                  </button>
                ))}
                {newsTopic && (
                  <button className="news-chip on" onClick={() => setNewsTopic(null)}>
                    主题：{newsTopicLabel(newsTopic)} ✕
                  </button>
                )}
                <span className="news-count">显示 {shownNews.length} 条</span>
              </div>

              <div className="news-list">
                {shownNews.slice(0, 40).map((n) => (
                  <div className={`news-item t-${n.tier}${n.routine ? ' routine' : ''}`} key={n.id}>
                    <span className={`tier-badge t-${n.tier}`} title={TIER_META[n.tier].note}>
                      {n.tier}
                    </span>
                    <span className="news-time">{n.time || '—'}</span>
                    <span className={`post-tone ${n.tone > 0 ? 'up' : n.tone < 0 ? 'down' : 'flat'}`}>
                      {n.tone > 0 ? '利好' : n.tone < 0 ? '利空' : '中性'}
                    </span>
                    <span className="news-text" title={n.text}>
                      {n.digest && <em className="news-lv">合集</em>}
                      {n.title ? <b className="news-title">{n.title}</b> : n.body}
                    </span>
                    <span className="news-meta" title={n.reasons.join(' · ')}>
                      {n.topicLabel}
                      {n.read ? ` · 阅 ${n.read >= 10000 ? `${(n.read / 10000).toFixed(1)}万` : n.read}` : ''}
                    </span>
                  </div>
                ))}
              </div>
              <div className="inst-hint">
                影响力 = 官方重要度 + 政策/实质事件关键词 + 金额体量（需挂在事件上，亿元级起）+ 阅读量 + 覆盖板块数。
                例行播报（指数播报、融资余额）压到 C 档、按 0.25 权重；合集型（早间精选、投资日历）打 0.55 折且不计方向。
                规则可解释：把鼠标放在 S/A 徽章或「影响力」上能看到命中了哪些项。
              </div>
            </Panel>
          )}

          {structure && (
            <>
              <Panel
                title="情绪结构 · 阈值与归因"
                icon="🧭"
                desc="多空比只是结果；这一层回答「为什么」「算高还是低」「一致还是分歧」"
                extra={
                  <span className="inst-hint">
                    <span className={`badge ${structure.level === 'fever' ? 'up' : structure.level === 'ice' ? 'down' : 'flat'}`}>
                      {LEVEL_META[structure.level].label}
                    </span>{' '}
                    有效样本 {structure.sample} 条 · 温度 {structure.tempBand}
                  </span>
                }
                style={{ marginTop: 16 }}
              >
                {/* 阈值标尺 */}
                <div className="band-ruler">
                  {RATIO_BANDS.map((b) => (
                    <div key={b.label} className={`band-seg t-${b.tone}`} style={{ flex: b.max - b.min }}>
                      <span className="band-label">{b.label}</span>
                      <span className="band-range">
                        {b.min}~{b.max}%
                      </span>
                    </div>
                  ))}
                  {structure.ratio != null && (
                    <div className="band-marker" style={{ left: `${structure.ratio * 100}%` }}>
                      <span>{(structure.ratio * 100).toFixed(0)}%</span>
                    </div>
                  )}
                </div>
                <div className="inst-hint" style={{ marginTop: 6 }}>
                  当前多空比 {(structure.ratio != null ? (structure.ratio * 100).toFixed(0) : '—')}% 落在
                  <b>「{structure.band.label}」</b>——{structure.band.note}
                  {structure.sample < 20 && <b style={{ color: 'var(--amber)' }}>（样本少于 20 条，仅作参考）</b>}
                </div>

                {/* 结构指标 */}
                <div className="ind-facts" style={{ marginTop: 10 }}>
                  <span>
                    分歧度 <b style={{ color: structure.metrics.divergence >= 60 ? 'var(--amber)' : 'var(--text)' }}>{structure.metrics.divergence}</b>
                    <em className="fact-note">（越高越多空对立）</em>
                  </span>
                  <span>
                    一致性 <b>{structure.metrics.consensus}</b>
                  </span>
                  <span>
                    讨论量 <b>{structure.metrics.volume}</b> 条
                  </span>
                  <span>
                    主题集中度 <b>{(structure.metrics.focus * 100).toFixed(0)}%</b>
                  </span>
                  <span>
                    信息含量{' '}
                    <b style={{ color: structure.metrics.substance < 0.6 ? 'var(--amber)' : 'var(--text)' }}>
                      {(structure.metrics.substance * 100).toFixed(0)}%
                    </b>
                    <em className="fact-note">（非闲聊占比）</em>
                  </span>
                  <span>
                    消息面背离{' '}
                    <b style={{ color: structure.metrics.newsGap == null ? 'var(--text-3)' : Math.abs(structure.metrics.newsGap) >= 20 ? 'var(--amber)' : 'var(--text)' }}>
                      {structure.metrics.newsGap == null ? '—' : `${structure.metrics.newsGap > 0 ? '+' : ''}${structure.metrics.newsGap}pp`}
                    </b>
                  </span>
                  <span>
                    量价背离{' '}
                    <b style={{ color: structure.metrics.priceGap === 'none' ? 'var(--text-3)' : 'var(--amber)' }}>
                      {structure.metrics.priceGap === 'top' ? '顶部特征' : structure.metrics.priceGap === 'bottom' ? '底部特征' : '无'}
                    </b>
                  </span>
                </div>

                {/* 归因 */}
                <div className="grid-2" style={{ marginTop: 12 }}>
                  <div>
                    <div className="ind-sub">看多集中在哪 · 按主题归因</div>
                    {bullDriverOpt ? <EChart option={bullDriverOpt} height={Math.max(150, 40 * structure.bullDrivers.length)} /> : <EmptyTip text="无看多样本" />}
                  </div>
                  <div>
                    <div className="ind-sub">看空集中在哪 · 按主题归因</div>
                    {bearDriverOpt ? <EChart option={bearDriverOpt} height={Math.max(150, 40 * structure.bearDrivers.length)} /> : <EmptyTip text="无看空样本" />}
                  </div>
                </div>

                {/* 结论 */}
                <div className="struct-read">
                  {structure.lines.map((l, i) => (
                    <p key={i}>{l}</p>
                  ))}
                </div>
              </Panel>

              <Panel
                title={`讨论主题分布 · ${structure.topics.length} 类`}
                icon="🗂️"
                desc="每条内容按关键词优先级归到一个主主题；多空比只统计有方向的样本"
                style={{ marginTop: 16 }}
              >
                <div className="grid-2">
                  <div>
                    <div className="tbl-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th>主题</th>
                            <th className="num">条数</th>
                            <th className="num">看多/看空</th>
                            <th className="num">多空比</th>
                          </tr>
                        </thead>
                        <tbody>
                          {structure.topics.map((t) => (
                            <tr key={t.topic}>
                              <td>
                                <b>
                                  {t.icon} {t.label}
                                </b>
                                <span className="inst-parent">{t.sample.slice(0, 22)}</span>
                              </td>
                              <td className="num">{t.total}</td>
                              <td className="num">
                                <span style={{ color: 'var(--up)' }}>{t.bull}</span>
                                <span style={{ color: 'var(--text-3)' }}> / </span>
                                <span style={{ color: 'var(--down)' }}>{t.bear}</span>
                              </td>
                              <td className="num" style={{ color: t.ratio == null ? 'var(--text-3)' : t.ratio >= 0.5 ? 'var(--up)' : 'var(--down)' }}>
                                {t.ratio == null ? '—' : `${(t.ratio * 100).toFixed(0)}%`}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                  <div>
                    <div className="ind-sub">被讨论的个股 · 从标题里抽取</div>
                    {structure.stocks.length ? (
                      <div className="tbl-wrap" style={{ maxHeight: 340, overflowY: 'auto' }}>
                        <table className="tbl">
                          <thead>
                            <tr>
                              <th>名称</th>
                              <th className="num">提及</th>
                              <th className="num">多空</th>
                              <th className="num">今日涨跌</th>
                            </tr>
                          </thead>
                          <tbody>
                            {structure.stocks.map((m) => {
                              const q = data?.stocks.find((x) => x.code === m.code);
                              return (
                                <tr key={m.code}>
                                  <td>
                                    <b>{m.name}</b>
                                    <span className="mono" style={{ marginLeft: 6 }}>
                                      {m.code}
                                    </span>
                                  </td>
                                  <td className="num">{m.count}</td>
                                  <td className="num">
                                    <span className={`post-tone ${m.tone > 0 ? 'up' : m.tone < 0 ? 'down' : 'flat'}`}>
                                      {m.tone > 0 ? '偏多' : m.tone < 0 ? '偏空' : '中性'}
                                    </span>
                                  </td>
                                  <td className="num" style={{ color: (q?.pct ?? 0) >= 0 ? 'var(--up)' : 'var(--down)' }}>
                                    {q ? pctText(q.pct) : '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <EmptyTip text="标题里未识别到股票名" />
                    )}
                    <div className="inst-hint">
                      做法是对标题做 3~5 字滑窗，匹配全 A 股票名索引（5576 只）。只做名称匹配，不做指代消解——
                      「它」「该股」这类无法归属。
                    </div>
                  </div>
                </div>
              </Panel>
            </>
          )}

          {buzz && buzz.focus.length > 0 && (
            <Panel
              title={`市场关注度 TOP${buzz.focus.length} · 千股千评`}
              icon="🔎"
              desc={`按东财千股千评的「市场关注度」排序（0~100）；综合得分与排名变化来自同一张表，数据日期 ${buzz.focusDate || '—'}，通常滞后 1 个交易日`}
              style={{ marginTop: 16 }}
            >
              <div className="tbl-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>#</th>
                      <th>名称</th>
                      <th className="num">关注度</th>
                      <th className="num">综合得分</th>
                      <th className="num">涨跌幅</th>
                      <th className="num">得分排名变化</th>
                    </tr>
                  </thead>
                  <tbody>
                    {buzz.focus.map((r, i) => (
                      <tr key={r.code}>
                        <td>{i + 1}</td>
                        <td>
                          <b>{r.name}</b>
                          <span className="mono" style={{ marginLeft: 6 }}>
                            {r.code}
                          </span>
                        </td>
                        <td className="num">
                          <span className="focus-bar">
                            <i style={{ width: `${Math.min(100, r.focus)}%` }} />
                          </span>
                          {r.focus.toFixed(0)}
                        </td>
                        <td className="num">{r.score.toFixed(1)}</td>
                        <td className="num" style={{ color: r.pct >= 0 ? 'var(--up)' : 'var(--down)' }}>
                          {pctText(r.pct)}
                        </td>
                        <td className="num" style={{ color: r.rankUp > 0 ? 'var(--up)' : r.rankUp < 0 ? 'var(--down)' : 'var(--text-3)' }}>
                          {r.rankUp === 0 ? '—' : `${r.rankUp > 0 ? '↑' : '↓'}${Math.abs(r.rankUp)}`}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {/* ===== 涨停池 ===== */}
          {data.limits.up.length > 0 && (
            <Panel
              title={`涨停池 · ${data.limits.up.length} 家`}
              icon="🚀"
              desc="按首次封板时间排序；连板数 ≥2 用红色徽标标出，首封越早说明资金越坚决"
              style={{ marginTop: 16 }}
            >
              <div className="tbl-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>代码</th>
                      <th>名称</th>
                      <th className="num">涨幅</th>
                      <th className="num">连板</th>
                      <th className="num">封单额</th>
                      <th className="num">换手</th>
                      <th className="num">首封</th>
                      <th>所属行业</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...data.limits.up]
                      .sort((a, b) => a.firstSeal - b.firstSeal)
                      .map((r) => (
                        <tr key={r.code}>
                          <td className="mono">{r.code}</td>
                          <td>
                            <b>{r.name}</b>
                          </td>
                          <td className="num" style={{ color: 'var(--up)' }}>
                            {pctText(r.pct)}
                          </td>
                          <td className="num">
                            {r.boardCount >= 2 ? (
                              <span className="badge up">{r.boardCount} 板</span>
                            ) : (
                              <span style={{ color: 'var(--text-3)' }}>首板</span>
                            )}
                          </td>
                          <td className="num">{yi(r.sealFund)}</td>
                          <td className="num">{r.turnover.toFixed(1)}%</td>
                          <td className="num">{timeText(r.firstSeal)}</td>
                          <td>{r.industry || '—'}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          {/* ===== 解读 ===== */}
          <Panel title="解读 · 加减分从哪来" icon="🧠" style={{ marginTop: 16 }}>
            <div className="sent-read">
              <p>
                <b>结论：</b>
                {result.summary}
              </p>
              <p>
                <b>广度：</b>
                上涨 {breadthInput.up} 家、下跌 {breadthInput.down} 家，上涨占比{' '}
                {((breadthInput.up / breadthInput.total) * 100).toFixed(1)}%，个股涨跌幅中位数 {pctText(breadthInput.medianPct)}。
                {breadthInput.medianPct < 0 && breadthInput.up > breadthInput.down
                  ? ' 注意：涨的家数更多但中位数为负，说明涨幅集中在少数权重股，多数个股其实在跌。'
                  : ''}
              </p>
              {flowInput && (
                <p>
                  <b>资金：</b>
                  {flowInput.main != null ? (
                    <>
                      当日主力{flowText(Number(flowInput.main))}（占沪市成交额{' '}
                      {((Number(flowInput.main) / (flowInput.amount || 1)) * 100).toFixed(2)}%），近 5 日累计 {flowText(flowInput.main5)}；
                    </>
                  ) : (
                    <>东财主力资金流本次不可用，资金维度只按两融口径计分；</>
                  )}
                  融资余额 {yi(flowInput.marginBal)}，最新融资{flowText(flowInput.marginNet)}。
                  主力口径为「大单 + 超大单净额」，5 日累计只作参考，打分用的是当日占成交额比。
                </p>
              )}
              {structureInput && (
                <p>
                  <b>结构：</b>
                  {structureInput.upCount}/{structureInput.total} 个行业上涨，行业涨幅中位 {pctText(structureInput.medianPct)}。
                  {structureInput.upCount / structureInput.total > 0.6
                    ? ' 属于普涨格局，行情有扩散。'
                    : structureInput.upCount / structureInput.total < 0.35
                      ? ' 属于普跌格局，防守优先。'
                      : ' 属于结构性行情，选行业比选个股更重要。'}
                </p>
              )}
              <p>
                <b>打板：</b>
                涨停 {breadthInput.limitUp} 家、跌停 {breadthInput.limitDown} 家、炸板 {breadthInput.broke} 家，封板率{' '}
                {(breadthInput.sealRate * 100).toFixed(0)}%，最高 {breadthInput.maxBoard} 连板。
                {breadthInput.maxBoard === 0 ? ' 当前无涨停池数据。' : breadthInput.maxBoard >= 5 ? ' 高标仍在，短线情绪未退潮。' : ' 缺乏高标，接力意愿弱。'}
              </p>
              <p className="inst-warn">
                情绪分是「当下状态」的度量，不是买卖信号：极端亢奋常伴随回调，极端冰点常伴随反弹，
                但两者都可能持续。建议与「策略信号」「HMM 市场状态」交叉验证后再决策。
              </p>
            </div>
          </Panel>

          <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页情绪指标交给 AI 解读，只读不改任何设置">
            <AiAnalyze
              module="情绪晴雨表"
              note="情绪分是「当下状态」的度量，七维按权重合成；极端值常伴随反转但也可能持续。"
              facts={[
                { label: '综合温度', value: result.score.toFixed(1) + ' / 100（' + result.weather + '）' },
                { label: '极端状态', value: result.extreme || '无' },
                ...result.dims.map((d) => ({ label: '维度·' + d.label, value: d.score.toFixed(0) + '（权重 ' + (d.weight * 100).toFixed(0) + '%）' + (d.available ? '' : '·数据缺失') })),
                ...(structure ? [
                  { label: '消息/讨论多空比', value: structure.ratio == null ? '—' : (structure.ratio * 100).toFixed(0) + '%' },
                  { label: '多空分档 / 样本', value: structure.band + ' / ' + structure.sample + ' 条' }
                ] : []),
                { label: '上涨 / 下跌家数', value: breadthInput.up + ' / ' + breadthInput.down },
                { label: '涨停 / 跌停', value: breadthInput.limitUp + ' / ' + breadthInput.limitDown }
              ]}
            />
          </Panel>

          <MathPanel>
            <p>
              <b>1. 七维打分（各 0~100）</b>
            </p>
            <p>
              广度 = 100·[0.5 + 0.5·tanh(2.2·(r<sub>up</sub> − 0.5))] + 8·tanh(m / 1.2)，其中 r<sub>up</sub> 为上涨占比、m 为涨跌幅中位数（%）。
              用 tanh 是为了压缩极端值：上涨占比 0.9 不应等于 90 分线性。
            </p>
            <p>
              强度 = 100·(0.4·L<sub>up</sub>/(L<sub>up</sub>+L<sub>down</sub>+1) + 0.3·(1 − B/(L<sub>up</sub>+B+1)) + 0.3·min(H/6, 1))，
              其中 L 为涨停/跌停家数、B 为炸板家数、H 为最高连板数。
            </p>
            <p>
              资金 = 0.72·clamp(50 + 50·(M<sub>5</sub>/A<sub>5</sub>)/0.03) + 0.28·clamp(50 + 50·(N<sub>m</sub>/R<sub>m</sub>)/0.015)，
              M<sub>5</sub> 为 5 日主力净流入合计、A<sub>5</sub> 为 5 日成交额、N<sub>m</sub> 为融资净买入、R<sub>m</sub> 为融资余额。
            </p>
            <p>
              量能 = clamp(50 + 50·tanh(0.9·(ρ − 1)))，ρ = 今日成交额 / (20 日均额 × 时段进度)。
              盘中必须先按已走完的交易时段折算，否则 10 点的成交额永远只有全天的四成，会被误判为极度缩量。
            </p>
            <p>
              结构 = 100·[0.5 + 0.5·tanh(2.6·(q − 0.5))] + 10·tanh(m<sub>ind</sub>/0.8)，q 为上涨行业占比、m<sub>ind</sub> 为行业涨幅中位数。
            </p>
            <p>
              波动 = clamp(50 − 45·(σ<sub>20</sub>/σ<sub>60</sub> − 1))，σ 为年化波动率（日收益标准差 × √252）；波动放大扣分（反向）。
            </p>
            <p>
              <b>2. 合成</b>
            </p>
            <p>
              T = Σ w<sub>i</sub>·s<sub>i</sub> / Σ w<sub>i</sub>，权重 w = (0.20, 0.16, 0.20, 0.10, 0.12, 0.10, 0.12)，
              依次对应 广度 / 强度 / 资金 / 量能 / 结构 / 波动 / 讨论。
              某维度不可用时（如非交易时段无涨停池、两融接口失败）从分母中剔除并重新归一，而不是补 50 分——
              否则会凭空把温度拉向中性。
            </p>
            <p>
              <b>3. 五档天气</b>
            </p>
            <p>
              T ≥ 72 晴；58 ≤ T &lt; 72 多云；45 ≤ T &lt; 58 阴；32 ≤ T &lt; 45 小雨；T &lt; 32 暴雨。
              另有极端判定：T ≥ 85 或（上涨占比 ≥ 85% 且涨停 ≥ 60 家）记为「亢奋」；T ≤ 15 或上涨占比 ≤ 10% 记为「冰点」。
            </p>
            <p>
              <b>4. 全网讨论（第七维）</b>
            </p>
            <p>
              讨论分 = 0.6·人气榜赚钱效应 + 0.4·热帖多空分；
              人气榜赚钱效应 = 100·(0.55·TOP30 上涨占比 + 0.45·(0.5 + 0.5·tanh(平均涨幅 / 2.5)))。
            </p>
            <p>
              热帖多空分 = 0.6·条数口径 + 0.4·热度口径，其中热度 = 阅读 + 评论×20；
              单条标题得分 = Σ(强词 ±2 / 弱词 ±1)，前置否定词翻转极性。
              词典读不出反讽与谐音，所以这一维只占 12% 权重，不单独构成信号。
            </p>
            <p>
              <b>5. 历史近似温度</b>
            </p>
            <p>
              T<sub>approx</sub> = 0.45·[50 + 50·tanh(r<sub>5d</sub>/0.06)] + 0.35·量能分 + 0.20·波动分。
              历史涨跌家数与历史资金流不可回溯，因此这条曲线只用于观察趋势与拐点。
            </p>
            <p>
              <b>6. 口径说明</b>
            </p>
            <p>
              北向资金自 2024-08 起不再逐日披露净买入（接口返回 null），因此页面只把「北向成交额」当活跃度参考，不参与打分。
              两融与千股千评由交易所盘后披露，通常滞后 1 个交易日，页面均标注数据日期。
              讨论数据只取股吧——雪球被 WAF 拦、微博需登录态、同花顺无公开接口，股吧是唯一稳定可达的高密度散户社区。
            </p>
          </MathPanel>
        </>
      )}
    </div>
  );
}

function scoreColor(score: number): string {
  if (score >= 72) return '#e04343';
  if (score >= 58) return '#f59e0b';
  if (score >= 45) return '#94a3b8';
  if (score >= 32) return '#3b82f6';
  return '#6d28d9';
}
