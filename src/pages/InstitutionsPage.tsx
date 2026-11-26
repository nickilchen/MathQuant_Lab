/**
 * 机构持仓分析 · 公募 / 私募 / 国家大基金 / 国家队 …（多源 + 行业维度）
 *
 * 三个视角：
 *  1. 穿透口径（当期明细 + 名称规则）：机构投资者持股合计与属性结构；
 *  2. 官方口径（多报告期汇总）：基金/QFII/社保/券商/保险 的类型演化与环比（「其他」混有控股股东，不并入）；
 *  3. 行业视角：所属行业（东财行业板块）内所有成分股的机构持股横向对比。
 *
 * 数据源：东财数据中心（类型/明细）→ 东财 F10（户数/十大股东）→ 新浪 F10（十大股东兜底）→ 缓存。
 * 东财数据中心整体不可用时进入「降级模式」，只按十大流通股东做结构与集中度，并显式标注样本口径。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EChart from '../components/EChart';
import { CtrlGroup, EmptyTip, Loading, MathPanel, MetricGrid, Panel, Select, SourcePill, fmtPct } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import {
  C,
  barOption,
  highlightBarOption,
  histogramOption,
  lineOption,
  pieOption,
  signedBarOption,
  stackedAreaOption
} from '../components/chartOptions';
import { searchStocks, type StockHit } from '../data/search';
import { useApp } from '../hooks/AppContext';
import {
  BENCH_SCOPES,
  SCOPE_ALL,
  fetchMarketSnapshot,
  scopeLabel,
  type MarketScope,
  type MarketSnapshot
} from '../data/market';
import {
  ORG_TYPE_LABEL,
  SOURCE_LABEL,
  fetchIndustry,
  fetchIndustrySnapshot,
  fetchInstitutionDetail,
  fetchInstitutions,
  incompleteDates as calcIncompleteDates,
  reportKind,
  sameKindPeriods,
  sameKindPrev,
  type HolderRow,
  type IndustrySnapshot,
  type InstDataset,
  type OrgTypeKey,
  type SourceTag
} from '../data/institutions';
import {
  CLASS_META,
  aggregateClasses,
  classifyHolder,
  concentration,
  instSignal,
  histogram,
  institutionRatio,
  institutionValue,
  percentileRank,
  percentileText,
  sharesText,
  yi,
  type HolderClass
} from '../math/holdings';

/* ---------- 常量 ---------- */

const HOT: StockHit[] = [
  { code: 'sh688981', name: '中芯国际', market: 'CN', marketLabel: 'A股', secid: '1.688981', sina: 'sh688981' },
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', secid: '1.600519', sina: 'sh600519' },
  { code: 'sz002371', name: '北方华创', market: 'CN', marketLabel: 'A股', secid: '0.002371', sina: 'sz002371' },
  { code: 'sz300750', name: '宁德时代', market: 'CN', marketLabel: 'A股', secid: '0.300750', sina: 'sz300750' },
  { code: 'sh600036', name: '招商银行', market: 'CN', marketLabel: 'A股', secid: '1.600036', sina: 'sh600036' },
  { code: 'sz002415', name: '海康威视', market: 'CN', marketLabel: 'A股', secid: '0.002415', sina: 'sz002415' }
];

const TYPE_COLOR: Record<OrgTypeKey, string> = {
  total: C.gray,
  fund: '#2563eb',
  qfii: '#0e9f6e',
  social: '#f59e0b',
  broker: '#8b5cf6',
  insurance: '#06b6d4',
  other: '#94a3b8'
};

const TREND_TYPES: OrgTypeKey[] = ['fund', 'qfii', 'social', 'insurance', 'broker'];
const DELTA_TYPES: OrgTypeKey[] = ['fund', 'qfii', 'social', 'insurance', 'broker'];

function clsColor(cls: HolderClass): string {
  switch (cls) {
    case 'bigfund':
      return C.up;
    case 'national':
      return C.orange;
    case 'social':
      return C.amber;
    case 'public':
      return C.accent;
    case 'private':
      return C.purple;
    case 'insurance':
      return C.cyan;
    case 'foreign':
      return C.down;
    case 'broker':
      return '#64748b';
    case 'industrial':
      return '#a3aec2';
    case 'person':
      return '#c3ccda';
    default:
      return C.gray;
  }
}

const periodLabel = (d: string) => {
  const y = d.slice(0, 4);
  const m = d.slice(5, 7);
  const q = m === '03' ? 'Q1' : m === '06' ? 'Q2' : m === '09' ? 'Q3' : 'Q4';
  return `${y}${q}`;
};

const daysSince = (d: string) => Math.max(0, Math.round((Date.now() - new Date(d + 'T00:00:00').getTime()) / 864e5));

const shortName = (s: string, n = 9) => (s.length > n ? s.slice(0, n) + '…' : s);

const bare = (code: string) => code.replace(/^(sh|sz|bj)/, '');

/** 行业快照的进程内缓存（切报告期不重复拉取） */
const industryCache = new Map<string, IndustrySnapshot>();
/** 大盘快照缓存（key = 当期|上期|范围） */
const marketCache = new Map<string, MarketSnapshot>();

/** 层级标题 */
function LayerHeader({
  index,
  title,
  sub,
  extra
}: {
  index: string;
  title: string;
  sub?: string;
  extra?: React.ReactNode;
}) {
  return (
    <div className="layer-head">
      <span className="layer-idx">{index}</span>
      <div className="layer-txt">
        <div className="layer-title">{title}</div>
        {sub && <div className="layer-sub">{sub}</div>}
      </div>
      {extra && <div className="layer-extra">{extra}</div>}
    </div>
  );
}

/* ---------- 页面 ---------- */

export default function InstitutionsPage() {
  const { settings } = useApp();
  const [target, setTarget] = useState<StockHit>(HOT[0]);
  const [data, setData] = useState<InstDataset | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<string>('');
  const [detailByDate, setDetailByDate] = useState<Record<string, { rows: HolderRow[]; total: number }>>({});
  const [detailLoading, setDetailLoading] = useState(false);

  // 行业
  const [industry, setIndustry] = useState<IndustrySnapshot | null>(null);
  const [industryLoading, setIndustryLoading] = useState(false);
  const [industryErr, setIndustryErr] = useState<string | null>(null);

  // 大盘
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [marketLoading, setMarketLoading] = useState(false);
  const [marketErr, setMarketErr] = useState<string | null>(null);
  const [marketProgress, setMarketProgress] = useState<{ done: number; total: number } | null>(null);
  /** 市场层范围：全市场（默认）/ 跟随顶栏基准 */
  const [scope, setScope] = useState<MarketScope>(SCOPE_ALL);
  /** 顶栏基准能映射到的范围（映射不到时为 null） */
  const benchScope = BENCH_SCOPES[settings.benchmark] ?? null;
  /** 三层视图：市场大局 / 行业全景 / 个股透视 */
  const [tab, setTab] = useState<'market' | 'industry' | 'stock'>('market');
  /** 行业全景里选中的行业（null = 跟随当前个股所属行业） */
  const [indPick, setIndPick] = useState<{ code: string; name: string } | null>(null);

  // 搜索
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [showDrop, setShowDrop] = useState(false);
  const [searching, setSearching] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async (hit: StockHit, force = false) => {
    setLoading(true);
    setError(null);
    try {
      const d = await fetchInstitutions(hit.code, { force });
      setData(d);
      // 降级模式下没有全市场/行业数据，直接落到个股视图，避免停在一个空的市场页
      if (d.degraded) setTab('stock');
      setPeriod(d.detailDate || d.periods[d.periods.length - 1] || d.topHolderDate || '');
      setDetailByDate({
        ...(d.detailDate ? { [d.detailDate]: { rows: d.detail, total: d.detailTotal } } : {}),
        ...(d.prevDetailDate && d.prevDetail.length ? { [d.prevDetailDate]: { rows: d.prevDetail, total: d.prevDetailTotal } } : {})
      });
    } catch (e) {
      setData(null);
      setError(e instanceof Error ? e.message : '机构持仓取数失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setIndPick(null);
    void load(target);
  }, [target, load]);

  // 切换报告期：明细按需拉取
  useEffect(() => {
    if (!data || !period || data.degraded) return;
    if (detailByDate[period]) return;
    let alive = true;
    setDetailLoading(true);
    fetchInstitutionDetail(data.code, period)
      .then((r) => alive && setDetailByDate((m) => ({ ...m, [period]: r })))
      .catch(() => alive && setDetailByDate((m) => ({ ...m, [period]: { rows: [], total: 0 } })))
      .finally(() => {
        if (alive) setDetailLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [data, period, detailByDate]);

  // 行业快照（跟随标的与报告期；降级模式下跳过）
  useEffect(() => {
    if (!data || !period || data.degraded) {
      setIndustry(null);
      setIndustryErr(null);
      return;
    }
    // 选中了某个行业就分析那个行业，否则跟随当前个股所属行业
    const key = `${indPick?.code ?? data.code}:${period}`;
    const hit = industryCache.get(key);
    if (hit) {
      setIndustry(hit);
      setIndustryErr(null);
      return;
    }
    let alive = true;
    setIndustryLoading(true);
    setIndustryErr(null);
    (async () => {
      try {
        const info = indPick
          ? { code: indPick.code, name: indPick.name, memberCount: 0 }
          : await fetchIndustry(data.code);
        if (!info) throw new Error('未匹配到东财行业板块');
        const snap = await fetchIndustrySnapshot(info, period, data.code);
        industryCache.set(key, snap);
        if (alive) setIndustry(snap);
      } catch (e) {
        if (alive) {
          setIndustry(null);
          setIndustryErr(e instanceof Error ? e.message : '行业数据不可用');
        }
      } finally {
        if (alive) setIndustryLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [data, period]);

  // 大盘快照（沪深300 成分聚合，跟随报告期与其上一期）
  useEffect(() => {
    if (!data || !period || data.degraded) {
      setMarket(null);
      setMarketErr(null);
      return;
    }
    const prev = sameKindPrev(data.periods, period);
    const key = `${period}|${prev ?? ''}|${scope.kind}${scope.kind === 'all' ? '' : scope.kind === 'board' ? scope.code : scope.prefixes.join(',')}`;
    const hit = marketCache.get(key);
    if (hit) {
      setMarket(hit);
      setMarketErr(null);
      setMarketProgress(null);
      return;
    }
    let alive = true;
    setMarketLoading(true);
    setMarketErr(null);
    setMarketProgress({ done: 0, total: 0 });
    fetchMarketSnapshot(period, prev, scope, (done, total) => {
      if (alive) setMarketProgress({ done, total });
    })
      .then((m) => {
        marketCache.set(key, m);
        if (alive) setMarket(m);
      })
      .catch((e) => {
        if (alive) {
          setMarket(null);
          setMarketErr(e instanceof Error ? e.message : '大盘数据不可用');
        }
      })
      .finally(() => {
        if (alive) {
          setMarketLoading(false);
          setMarketProgress(null);
        }
      });
    return () => {
      alive = false;
    };
  }, [data, period, scope]);

  // 搜索（只保留 A 股）
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      const r = await searchStocks(q, 12);
      setHits(r.filter((h) => h.market === 'CN'));
      setSearching(false);
      setShowDrop(true);
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q]);

  const detailRows = useMemo(() => (period ? detailByDate[period]?.rows ?? [] : []), [period, detailByDate]);
  const detailTotal = useMemo(() => (period ? detailByDate[period]?.total ?? 0 : 0), [period, detailByDate]);
  const badDates = useMemo(() => (data ? calcIncompleteDates(data) : new Set<string>()), [data]);

  /** 分析样本：正常态用全量明细，降级态用十大流通股东（占流通股口径） */
  const sample = useMemo(() => {
    if (!data) return { rows: [] as HolderRow[], valueKnown: true };
    if (!data.degraded) return { rows: detailRows, valueKnown: true };
    const rows: HolderRow[] = (data.topHolders ?? []).map((h) => ({
      date: data.topHolderDate,
      name: h.name,
      orgType: h.kind,
      shares: h.shares,
      // 没有市值字段：用占比当权重，仅用于结构比例与集中度
      value: h.ratio,
      ratio: h.ratio,
      netAssetRatio: null
    }));
    return { rows, valueKnown: false };
  }, [data, detailRows]);

  /* ---- 派生指标 ---- */

  const view = useMemo(() => {
    if (!data || !period) return null;
    const cur = data.typePoints.filter((p) => p.date === period);
    // 环比一律同口径：季报(Q1/Q3) 对季报，半年报/年报(Q2/Q4) 对同类型
    const prevDate = sameKindPrev(data.periods, period);
    const prevCur = prevDate ? data.typePoints.filter((p) => p.date === prevDate) : [];
    const sum = data.summary.find((s) => s.date === period);
    const prevSum = prevDate ? data.summary.find((s) => s.date === prevDate) : null;

    const rows = sample.rows;
    const penetrated = rows.length > 0;
    const buckets = aggregateClasses(rows, { instOnly: true });
    const allBuckets = aggregateClasses(rows, { instOnly: false });
    const conc = concentration(rows);

    const prevRows = data.degraded
      ? []
      : prevDate
        ? (detailByDate[prevDate]?.rows ?? (prevDate === data.prevDetailDate ? data.prevDetail : []))
        : [];
    const prevPenetrated = prevRows.length > 0;
    const prevBuckets = aggregateClasses(prevRows, { instOnly: true });

    const instRatio = penetrated ? institutionRatio(buckets) : (sum?.ratio ?? 0);
    const instVal = sample.valueKnown ? institutionValue(buckets) : 0;
    const instCount = buckets.reduce((s, b) => s + b.count, 0);
    const prevInstRatio = prevPenetrated ? institutionRatio(prevBuckets) : null;

    const industrial = allBuckets.filter((b) => b.cls === 'industrial');
    const industrialRatio = industrial.reduce((s, b) => s + b.ratio, 0);
    const industrialValue = industrial.reduce((s, b) => s + b.value, 0);

    const byCls = (c: HolderClass) => buckets.find((b) => b.cls === c);
    const holderNum =
      data.holderNums.find((h) => h.date === period) ?? data.holderNums.find((h) => h.date <= period) ?? data.holderNums[0] ?? null;

    const typeDeltas = DELTA_TYPES.map((t) => {
      const a = cur.find((p) => p.type === t);
      const b = prevCur.find((p) => p.type === t);
      if (!a && !b) return null;
      return { type: t, label: ORG_TYPE_LABEL[t], cur: a?.ratio ?? 0, prev: b?.ratio ?? 0, delta: (a?.ratio ?? 0) - (b?.ratio ?? 0) };
    }).filter((x): x is { type: OrgTypeKey; label: string; cur: number; prev: number; delta: number } => !!x);

    const incomplete = badDates.has(period);
    const sameBasis = !data.degraded && penetrated && prevPenetrated && prevInstRatio != null;
    const chgPp = incomplete
      ? null
      : sameBasis
        ? instRatio - (prevInstRatio as number)
        : sum && prevSum
          ? sum.ratio - prevSum.ratio
          : null;

    const clsDeltas = sameBasis
      ? buckets
          .map((b) => {
            const p = prevBuckets.find((x) => x.cls === b.cls);
            return { cls: b.cls, label: b.label, cur: b.ratio, prev: p?.ratio ?? 0, delta: b.ratio - (p?.ratio ?? 0) };
          })
          .filter((d) => Math.abs(d.delta) > 0.005)
      : [];

    const sig = instSignal({
      instRatio,
      prevInstRatio: sameBasis ? prevInstRatio : null,
      holderNumChg: holderNum?.chgPct != null ? holderNum.chgPct / 100 : null,
      hasBigfund: !!byCls('bigfund'),
      hasNational: !!byCls('national'),
      publicRatio: byCls('public')?.ratio ?? 0,
      hhi: conc.hhi
    });

    return {
      cur,
      prevDate,
      sum,
      prevSum,
      buckets,
      allBuckets,
      conc,
      penetrated,
      instRatio,
      instVal,
      instCount,
      industrialRatio,
      industrialValue,
      holderNum,
      typeDeltas,
      clsDeltas,
      sameBasis,
      incomplete,
      chgPp,
      holders: sum?.holders ?? 0,
      holdersChg: prevSum && prevSum.holders ? (sum?.holders ?? 0) / prevSum.holders - 1 : null,
      sig,
      coveredValue: instVal
    };
  }, [data, period, detailRows, badDates, detailByDate, sample]);

  /* ---- 图表 ---- */

  const trendDates = useMemo(
    () => (data ? sameKindPeriods(data.periods, period).slice(-12) : []),
    [data, period]
  );

  const trendOption = useMemo(() => {
    if (!data) return {};
    const series = TREND_TYPES.map((t) => ({
      name: ORG_TYPE_LABEL[t],
      color: TYPE_COLOR[t],
      data: trendDates.map((d) => {
        const p = data.typePoints.find((x) => x.date === d && x.type === t);
        return p ? Number(p.ratio.toFixed(3)) : 0;
      })
    })).filter((s) => s.data.some((v) => v > 0));
    return stackedAreaOption(trendDates.map(periodLabel), series, { yName: '占总股本' });
  }, [data, trendDates]);

  const pieData = useMemo(() => {
    if (!view || !view.penetrated) return null;
    const total = view.buckets.reduce((s, b) => s + b.ratio, 0);
    if (total <= 0) return null;
    const items = view.buckets.filter((b) => b.ratio > 0.005).map((b) => ({ name: b.label, value: b.ratio / total, color: clsColor(b.cls) }));
    return items.length ? pieOption(items) : null;
  }, [view]);

  const clsBarOption = useMemo(() => {
    if (!view) return {};
    const list = view.buckets.filter((b) => b.ratio > 0.005).sort((a, b) => b.ratio - a.ratio);
    return barOption(
      list.map((b) => b.label),
      [{ name: data?.degraded ? '占前十合计' : '占总股本', data: list.map((b) => Number(b.ratio.toFixed(2))), color: C.accent }],
      { horizontal: true }
    );
  }, [view, data]);

  const deltaOption = useMemo(() => {
    if (!view || data?.degraded) return null;
    const rows = view.typeDeltas.filter((d) => Math.abs(d.delta) > 0.001);
    if (!rows.length) return null;
    return signedBarOption(
      rows.map((d) => d.label),
      rows.map((d) => d.delta),
      { unit: 'pp', name: '环比' }
    );
  }, [view, data]);

  const holderOption = useMemo(() => {
    if (!data?.holderNums.length) return null;
    const pts = [...data.holderNums].reverse().slice(-16);
    return lineOption(
      pts.map((p) => periodLabel(p.date)),
      [
        { name: '股东户数（万户）', data: pts.map((p) => Number((p.holders / 1e4).toFixed(2))), color: C.accent, area: true },
        { name: '户均持股（万股）', data: pts.map((p) => Number((p.avgFreeShares / 1e4).toFixed(2))), color: C.orange, yAxisIndex: 1 }
      ],
      { yName: '万户', rightName: '万股' }
    );
  }, [data]);

  /** 行业对比：TOP 12 + 当前标的（若不在前 12 则补进去） */
  const industryChart = useMemo(() => {
    if (!industry || !data) return null;
    const self = bare(data.code);
    const top = industry.peers.slice(0, 12);
    if (!top.some((p) => p.code === self)) {
      const me = industry.peers.find((p) => p.code === self);
      if (me) top.push(me);
    }
    const idx = top.findIndex((p) => p.code === self);
    const rankOf = (code: string) => industry.peers.findIndex((p) => p.code === code) + 1;
    return {
      option: highlightBarOption(
        top.map((p) => (p.code === self ? `${shortName(p.name || p.code, 6)} #${rankOf(p.code)}` : shortName(p.name || p.code))),
        top.map((p) => p.instRatio),
        idx,
        { unit: '%', name: '机构持股' }
      ),
      highlightName: idx >= 0 ? top[idx].name || top[idx].code : '',
      selfRatio: idx >= 0 ? top[idx].instRatio : null,
      rows: top.length
    };
  }, [industry, data]);

  /** 该股在行业中的位置 */
  const industrySelf = useMemo(() => {
    if (!industry || !data) return null;
    const peer = industry.peers.find((p) => p.code === bare(data.code)) ?? null;
    const vals = industry.peers.map((p) => p.instRatio);
    return { peer, percentile: peer ? percentileRank(vals, peer.instRatio) : 0 };
  }, [industry, data]);

  /** 行业分布直方图：高亮该股所在箱，标出均值/中位 */
  const histOption = useMemo(() => {
    if (!industry || !industrySelf?.peer) return null;
    const vals = industry.peers.map((p) => p.instRatio);
    const h = histogram(vals, 10);
    return histogramOption(h.labels, h.counts, {
      highlightBin: h.binOf(industrySelf.peer.instRatio),
      lineBins: [
        { name: `均值 ${industry.mean.toFixed(1)}`, bin: h.binOf(industry.mean) },
        { name: `中位 ${industry.median.toFixed(1)}`, bin: h.binOf(industry.median) }
      ],
      yName: '家数'
    });
  }, [industry, industrySelf]);

  /** 类型结构：该股 vs 行业平均（同为官方 5 类口径） */
  const typeCmpOption = useMemo(() => {
    if (!industry || !view) return null;
    // 只保留「该股或行业平均」有实际持仓的类目，否则会出现一排贴地的空柱
    const rows = industry.typeMean
      .map((t) => ({
        label: t.label,
        self: Number((view.cur.find((p) => p.type === t.type)?.ratio ?? 0).toFixed(3)),
        ind: Number(t.ratio.toFixed(3))
      }))
      .filter((r) => Math.max(r.self, r.ind) >= 0.02);
    if (!rows.length) return null;
    return barOption(
      rows.map((r) => r.label),
      [
        { name: '该股', data: rows.map((r) => r.self), color: C.up },
        { name: '行业平均', data: rows.map((r) => r.ind), color: C.accent }
      ],
      { labels: true, unit: '%' }
    );
  }, [industry, view]);

  /** 公募持仓强度：行业均值 vs 该股 */
  const indHistOption = useMemo(() => {
    if (!industry || !data || !industry.history.length) return null;
    const dates = industry.history.map((h) => periodLabel(h.date));
    const ind = industry.history.map((h) => Number(h.fundRatio.toFixed(2)));
    const self = industry.history.map((h) => {
      const p = data.typePoints.find((x) => x.date === h.date && x.type === 'fund');
      return p ? Number(p.ratio.toFixed(2)) : null;
    });
    if (!ind.some((v) => v > 0)) return null;
    return lineOption(
      dates,
      [
        { name: '行业平均（公募）', data: ind, color: C.accent, area: true },
        { name: '该股（公募）', data: self, color: C.up }
      ],
      { yName: '基金持股 %' }
    );
  }, [industry, data]);

  /** 三层对比：大盘 / 板块 / 个股（统一用官方 5 类口径，剔除「其他」） */
  const threeLayer = useMemo(() => {
    if (!market || !view) return null;
    // 板块口径优先用「市场层的同行业聚合」，保证三层是同一套数字；
    // 只有市场层缺这个行业时才退回行业快照。
    const indName = market.stocks.find((x) => x.code === bare(data?.code ?? ''))?.industry;
    const indRow = indName ? market.industries.find((x) => x.name === indName) : null;
    const indSmart = indRow
      ? indRow.smartMean
      : (industry?.typeMean
          .filter((t) => t.type === 'qfii' || t.type === 'social' || t.type === 'insurance')
          .reduce((s, t) => s + t.ratio, 0) ?? 0);
    const indFund = indRow ? indRow.fundMean : (industry?.typeMean.find((t) => t.type === 'fund')?.ratio ?? 0);
    const indInst = indRow ? indRow.instMean : (industry?.mean ?? 0);
    const pick = (types: OrgTypeKey[]) => view.cur.filter((p) => types.includes(p.type)).reduce((s, p) => s + p.ratio, 0);
    const selfAll = pick(['fund', 'qfii', 'social', 'insurance', 'broker']);
    const selfSmart = pick(['qfii', 'social', 'insurance']);
    const selfFund = pick(['fund']);
    return {
      cats: ['机构合计', '聪明资金', '公募基金'],
      market: [market.instMean, market.smartMean, market.fundMean],
      industry: [indInst, indSmart, indFund],
      self: [selfAll, selfSmart, selfFund]
    };
  }, [market, industry, view, data]);

  const threeLayerOption = useMemo(() => {
    if (!threeLayer) return null;
    return barOption(
      threeLayer.cats,
      [
        { name: '大盘（沪深300）', data: threeLayer.market.map((v) => Number(v.toFixed(3))), color: C.gray },
        { name: '板块（所属行业）', data: threeLayer.industry.map((v) => Number(v.toFixed(3))), color: C.accent },
        { name: '个股', data: threeLayer.self.map((v) => Number(v.toFixed(3))), color: C.up }
      ],
      { labels: true, unit: '%' }
    );
  }, [threeLayer]);

  /** 大盘分布：300 只成分股的机构持股比例分布 */
  const marketHistOption = useMemo(() => {
    if (!market || !market.distribution.length) return null;
    const h = histogram(market.distribution, 10);
    return histogramOption(h.labels, h.counts, {
      lineBins: [
        { name: `均值 ${market.instMean.toFixed(1)}`, bin: h.binOf(market.instMean) },
        { name: `中位 ${market.instMedian.toFixed(1)}`, bin: h.binOf(market.instMedian) }
      ],
      yName: '成分股'
    });
  }, [market]);

  /** 各行业排行：全市场口径下，按行业机构持股均值排序 */
  const industryRankOption = useMemo(() => {
    if (!market || !market.industries.length) return null;
    const cur = industry?.industry.name ?? null;
    const top = market.industries.slice(0, 15);
    if (cur && !top.some((x) => x.name === cur)) {
      const me = market.industries.find((x) => x.name === cur);
      if (me) top.push(me);
    }
    const idx = top.findIndex((x) => x.name === cur);
    return {
      option: highlightBarOption(
        top.map((x) => shortName(x.name, 7)),
        top.map((x) => x.instMean),
        idx,
        { unit: '%', name: '行业机构持股' }
      ),
      rows: top.length,
      highlighted: idx >= 0 ? top[idx].name : null,
      total: market.industries.length
    };
  }, [market, industry]);

  /** 该股在「全市场」与「所属行业」中的分位（用市场层本地数据算，零额外请求） */
  const position = useMemo(() => {
    if (!market || !data) return null;
    const self = market.stocks.find((x) => x.code === bare(data.code));
    if (!self) return null;
    const pAll = percentileRank(
      market.stocks.map((x) => x.inst),
      self.inst
    );
    const peers = self.industry ? market.stocks.filter((x) => x.industry === self.industry) : [];
    const pInd = peers.length > 1 ? percentileRank(peers.map((x) => x.inst), self.inst) : null;
    const indMean = peers.length ? peers.reduce((a, x) => a + x.inst, 0) / peers.length : null;
    return { self, pAll, pInd, peerCount: peers.length, indMean };
  }, [market, data]);

  /** 聪明资金明细（个股层，穿透口径：外资含北向通道） */
  const smartDetail = useMemo(() => {
    if (!view) return null;
    const order: HolderClass[] = ['foreign', 'bigfund', 'national', 'social', 'insurance'];
    const rows = order
      .map((c) => {
        const b = view.buckets.find((x) => x.cls === c);
        const d = view.clsDeltas.find((x) => x.cls === c);
        return { cls: c, label: CLASS_META[c].label, ratio: b?.ratio ?? 0, count: b?.count ?? 0, delta: d?.delta ?? null };
      })
      .filter((r) => r.ratio > 0.001 || r.count > 0);
    const total = rows.reduce((s, r) => s + r.ratio, 0);
    const delta = view.sameBasis ? rows.reduce((s, r) => s + (r.delta ?? 0), 0) : null;
    const north = data?.topHolders.find((h) => /香港中央结算|HKSCC/i.test(h.name)) ?? null;
    return { rows, total, delta, north };
  }, [view, data]);

  /* ---- 明细表 ---- */

  const topRows = useMemo(
    () =>
      [...sample.rows]
        .filter((r) => r.ratio > 0)
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 20)
        .map((r) => ({ ...r, cls: classifyHolder(r.name, r.orgType) })),
    [sample]
  );

  const periodOptions = useMemo(() => {
    if (!data) return [];
    return [...data.periods].reverse().map((d) => ({
      value: d,
      label: `${periodLabel(d)}（${d}）· ${reportKind(d) === 'full' ? '全量' : '前十大'}${badDates.has(d) ? ' · 披露中' : ''}`
    }));
  }, [data, badDates]);

  const completeDate = data ? [...data.periods].reverse().find((d) => !badDates.has(d)) ?? null : null;
  /** 最近一个「全量披露」期（半年报/年报） */
  const latestFull = data ? [...data.periods].reverse().find((d) => reportKind(d) === 'full') ?? null : null;
  const latestPeriod = data?.periods[data.periods.length - 1] ?? null;
  const srcText = (tag: SourceTag | null) => (tag ? SOURCE_LABEL[tag] : '—');

  /* ---- 渲染 ---- */

  return (
    <div>
      <div className="page-title-row">
        <h2>🏛️ 机构持仓分析</h2>
        <span className="en">Institutional Holdings · Public / Private / National Fund</span>
      </div>
      <p className="page-lead">
        看<b>谁在持有这只股票</b>：公募、私募、国家大基金、国家队、社保、保险、外资各占多少，最近一个季度谁在加仓谁在撤退，
        以及<b>它在同行业里处于什么位置</b>。官方报表的「其他」把控股股东与产业资本混在一起（茅台集团就占 54%），
        所以本页用<b>股东名称规则穿透</b>把机构投资者单独拎出来。
        数据三源降级：东财数据中心 → 东财 F10 → 新浪 F10；机构持仓是事实数据，<b>取不到就明确报错，不会用模拟数据填充</b>。
      </p>

      <div className="control-bar" style={{ alignItems: 'flex-start' }}>
        <div className="watch-add">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => hits.length > 0 && setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 200)}
            placeholder="搜索 A 股个股，如：中芯国际 / 600519 / 宁德时代"
          />
          {searching && <span className="inst-searching">搜索中…</span>}
          {showDrop && hits.length > 0 && (
            <div className="search-pop">
              {hits.map((h) => (
                <div
                  key={h.code}
                  className="search-item"
                  onMouseDown={() => {
                    setTarget(h);
                    setQ('');
                    setShowDrop(false);
                  }}
                >
                  <span className="badge info">{h.marketLabel}</span>
                  <b>{h.name}</b>
                  <span className="code">{h.code}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <CtrlGroup label="热门">
          {HOT.map((h) => (
            <button
              key={h.code}
              type="button"
              className={'chip-toggle' + (target.code === h.code ? ' on' : '')}
              onClick={() => setTarget(h)}
            >
              {h.name}
            </button>
          ))}
        </CtrlGroup>
        <CtrlGroup label="报告期">
          <Select value={period} onChange={setPeriod} options={periodOptions} />
        </CtrlGroup>
        <div className="watch-actions">
          <button type="button" className="gear-btn" onClick={() => void load(target, true)}>
            🔄 刷新
          </button>
        </div>
      </div>

      {loading && <Loading text="正在拉取机构持仓（类型汇总 / 明细 / 十大股东 / 股东户数）…" />}

      {!loading && error && (
        <div className="inst-error">
          <div>
            <b>机构持仓数据未取到</b>
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
              {error} · 已依次尝试东财数据中心、东财 F10、新浪 F10；不会用模拟数据替代。
            </div>
          </div>
          <button type="button" className="gear-btn" onClick={() => void load(target, true)}>
            重试
          </button>
        </div>
      )}

      {!loading && !error && data && view && (
        <>
          <div className="step-nav">
            {(
              [
                {
                  id: 'market',
                  idx: '①',
                  title: '市场大局',
                  sub: market ? `${market.members.toLocaleString()} 只 · 机构 ${market.instMean.toFixed(2)}%` : '全市场聚合'
                },
                {
                  id: 'industry',
                  idx: '②',
                  title: '行业全景',
                  sub: market ? `${market.industries.length} 个行业` : '各行业排行'
                },
                { id: 'stock', idx: '③', title: '个股透视', sub: data.name || target.name }
              ] as const
            ).map((st) => (
              <button
                key={st.id}
                type="button"
                className={'step' + (tab === st.id ? ' on' : '')}
                onClick={() => setTab(st.id)}
              >
                <span className="step-idx">{st.idx}</span>
                <span className="step-body">
                  <span className="step-title">{st.title}</span>
                  <span className="step-sub">{st.sub}</span>
                </span>
              </button>
            ))}
            <div className="step-meta">
              <span className="badge info">{period ? periodLabel(period) : '—'}</span>
              <span className={'badge ' + (reportKind(period) === 'full' ? 'info' : 'flat')}>
                {reportKind(period) === 'full' ? '全量披露' : '仅前十大'}
              </span>
              <SourcePill
                source={data.source === 'cache' ? 'cache' : data.source === 'sina-f10' ? 'sina' : 'eastmoney'}
                cacheTs={data.cacheTs}
              />
            </div>
          </div>

          {tab === 'market' && (
            <>
          <LayerHeader
            index="①"
            title={`大盘 · ${market ? scopeLabel(market.scope) : scopeLabel(scope)}`}
            sub={
              market
                ? `${market.members.toLocaleString()} 只标的 · ${periodLabel(market.date)} · 官方口径（基金/QFII/社保/保险/券商）`
                : '整个 A 股市场（或按顶栏基准圈定范围）的机构持仓聚合'
            }
            extra={
              market ? (
                <span className="inst-hint">
                  机构均值 {market.instMean.toFixed(2)}% · 中位 {market.instMedian.toFixed(2)}% · 聪明资金{' '}
                  {market.smartMean.toFixed(2)}%
                </span>
              ) : undefined
            }
          />

          <Panel
            title="市场层 · 机构持仓概览"
            icon="🌐"
            desc="先看整个市场（或基准范围）的机构参与度与聪明资金水位，再看各行业，最后落到个股"
            extra={
              <div className="scope-switch">
                <button
                  type="button"
                  className={'chip-toggle' + (scope.kind === 'all' ? ' on' : '')}
                  onClick={() => setScope(SCOPE_ALL)}
                >
                  全市场
                </button>
                {benchScope ? (
                  <button
                    type="button"
                    className={'chip-toggle' + (scope.kind !== 'all' ? ' on' : '')}
                    onClick={() => setScope(benchScope)}
                  >
                    跟随基准 · {scopeLabel(benchScope)}
                  </button>
                ) : (
                  <span className="inst-hint">当前基准「{settings.benchmark}」无对应成分口径</span>
                )}
              </div>
            }
          >
            {marketLoading && (
              <Loading
                text={
                  marketProgress?.total
                    ? `正在聚合${scopeLabel(scope)}机构持仓…（${marketProgress.done}/${marketProgress.total} 页，首次约 2-3 秒，之后走缓存）`
                    : `正在聚合${scopeLabel(scope)}机构持仓…`
                }
              />
            )}
            {!marketLoading && marketErr && <EmptyTip text={`大盘数据不可用：${marketErr}`} />}
            {!marketLoading && !marketErr && market && (
              <>
                <MetricGrid
                  items={[
                    {
                      label: '机构合计持股（均值）',
                      value: `${market.instMean.toFixed(2)}%`,
                      sub: `中位 ${market.instMedian.toFixed(2)}% · ${market.members.toLocaleString()} 只`,
                      tone: market.instChgPp == null ? undefined : market.instChgPp >= 0 ? 'up' : 'down'
                    },
                    {
                      label: '聪明资金占比',
                      value: `${market.smartMean.toFixed(2)}%`,
                      sub:
                        market.smartChgPp == null
                          ? 'QFII+社保+保险'
                          : `环比 ${market.smartChgPp >= 0 ? '+' : ''}${market.smartChgPp.toFixed(2)}pp`,
                      tone: market.smartChgPp == null ? undefined : market.smartChgPp >= 0 ? 'up' : 'down'
                    },
                    { label: '公募基金', value: `${market.fundMean.toFixed(2)}%`, sub: '成分股均值' },
                    { label: '机构持仓市值', value: yi(market.totalValue), sub: `覆盖 ${market.members.toLocaleString()} 只` },
                    {
                      label: '较上一可比期',
                      value: market.instChgPp == null ? '—' : `${market.instChgPp >= 0 ? '+' : ''}${market.instChgPp.toFixed(2)}pp`,
                      sub: market.prevDate ? `同口径 ${periodLabel(market.prevDate)}` : '无同口径可比期',
                      tone: market.instChgPp == null ? undefined : market.instChgPp >= 0 ? 'up' : 'down'
                    },
                    {
                      label: '行业覆盖',
                      value: `${market.coverage.industries}`,
                      sub: `全市场 ${market.coverage.stocks.toLocaleString()} 只股票`
                    }
                  ]}
                />

                <div className="grid-2" style={{ marginTop: 12 }}>
                  <div>
                    <div className="ind-sub">市场分布 · {market.members.toLocaleString()} 只标的的机构持股比例</div>
                    {marketHistOption ? <EChart option={marketHistOption} height={250} /> : <EmptyTip text="分布数据不可用" />}
                    <div className="inst-hint">
                      虚线为均值/中位。本期为{reportKind(market.date) === 'full' ? '半年报/年报（全量披露）' : '季报（仅前十大重仓）'}；
                      全市场口径下大部分个股机构持股很低，长尾明显。
                    </div>
                  </div>
                  <div>
                    <div className="ind-sub">
                      各行业排行 · 共 {industryRankOption?.total ?? 0} 个行业（按机构持股均值）
                    </div>
                    {industryRankOption ? (
                      <EChart option={industryRankOption.option} height={250} />
                    ) : (
                      <EmptyTip text="行业排行数据不可用" />
                    )}
                    <div className="inst-hint">
                      红色为该股所属行业（{industryRankOption?.highlighted ?? '—'}）。这是「从大盘到个股」的中间一层：
                      行业整体被机构低配时，个股再优秀也难独善其身。
                    </div>
                  </div>
                </div>

                <div style={{ marginTop: 12 }}>
                  <div className="ind-sub">三层对比 · 大盘 / 板块 / 个股</div>
                  {threeLayerOption ? <EChart option={threeLayerOption} height={240} /> : <EmptyTip text="对比数据不可用" />}
                  <div className="inst-hint">
                    同一口径（官方 5 类、剔除「其他」）逐层对比：机构合计、聪明资金（QFII+社保+保险）、公募。
                    注意：官方口径把国家大基金/国家队放在「其他」里，所以个股的聪明资金柱可能为 0 ——
                    穿透后的完整聪明资金见下方「聪明资金动向」面板；个股卡片用的是穿透口径，数值会略高于这里的官方口径。
                  </div>
                </div>
              </>
            )}
          </Panel>

            </>
          )}

          {tab === 'industry' && (
            <>
          <LayerHeader
            index="②"
            title="行业全景"
            sub={
              market
                ? `全部 ${market.industries.length} 个行业 · ${periodLabel(market.date)} · 与市场层同口径`
                : '各行业机构持仓排行'
            }
            extra={<span className="inst-hint">点击任一行业 → 下方查看该行业详情</span>}
          />

          <Panel
            title={`行业排行 · ${market?.industries.length ?? 0} 个行业`}
            icon="📊"
            desc="按机构持股均值排序（成分少于 3 只的细分行业已剔除）；点击行查看该行业详情"
          >
            {!market?.industries.length ? (
              <EmptyTip text={marketLoading ? '正在聚合全市场行业数据…' : '行业排行数据不可用'} />
            ) : (
              <div className="tbl-wrap" style={{ maxHeight: 460, overflowY: 'auto' }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th style={{ width: 44 }}>#</th>
                      <th>行业</th>
                      <th className="num">成分</th>
                      <th className="num">机构持股</th>
                      <th className="num">聪明资金</th>
                      <th className="num">公募</th>
                      <th className="num">持仓市值</th>
                    </tr>
                  </thead>
                  <tbody>
                    {market.industries.map((x, i) => {
                      const active = indPick ? indPick.code === x.code : industry?.industry.code === x.code;
                      return (
                        <tr
                          key={x.code || x.name}
                          className={active ? 'hl' : undefined}
                          style={{ cursor: 'pointer' }}
                          onClick={() => setIndPick({ code: x.code, name: x.name })}
                        >
                          <td>{i + 1}</td>
                          <td>
                            <b>{x.name}</b>
                            {active && <span className="badge info" style={{ marginLeft: 6 }}>当前</span>}
                          </td>
                          <td className="num">{x.members}</td>
                          <td className="num">{x.instMean.toFixed(2)}%</td>
                          <td className="num">{x.smartMean.toFixed(2)}%</td>
                          <td className="num">{x.fundMean.toFixed(2)}%</td>
                          <td className="num">{yi(x.totalValue)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <LayerHeader
            index="↳"
            title={`${industry?.industry.name ?? '行业'} · 行业详情`}
            sub={
              industry
                ? `${industry.industry.memberCount} 只成分股 · ${periodLabel(industry.date)} · 与大盘同口径`
                : '按东财行业板块聚合同行业成分股的机构持仓'
            }
            extra={
              industry ? (
                <span className="inst-hint">
                  该股 {industrySelf?.peer ? industrySelf.peer.instRatio.toFixed(2) + '%' : '—'} · 行业均值{' '}
                  {industry.mean.toFixed(2)}% · 排名 {industry.rank ?? '—'}/{industry.peers.length}
                </span>
              ) : undefined
            }
          />

          {!data.degraded && (
            <Panel
              title={`行业视角 · ${industry?.industry.name ?? '识别中'}`}
              icon="🏭"
              desc={
                industry
                  ? `${industry.industry.name}（${industry.industry.code}）· 成分 ${industry.industry.memberCount} 只 · ${periodLabel(
                      industry.date
                    )} · 官方口径（基金/QFII/社保/保险/券商，剔除「其他」）`
                  : '按东财行业板块聚合同行业成分股的机构持股'
              }
              extra={<span className="inst-hint">同口径对比：该股 vs 行业分布 / 类型结构 / 公募强度趋势</span>}
              style={{ marginTop: 16 }}
            >
              {industryLoading && <Loading text="正在聚合同行业机构持仓…" />}
              {!industryLoading && industryErr && <EmptyTip text={`行业数据不可用：${industryErr}`} />}
              {!industryLoading && !industryErr && industry && industrySelf && (
                <>
                  <div className="ind-facts">
                    <span>
                      成分 <b>{industry.industry.memberCount}</b> 只
                    </span>
                    <span>
                      该股机构持股 <b style={{ color: 'var(--up)' }}>{(industrySelf.peer?.instRatio ?? 0).toFixed(2)}%</b>
                    </span>
                    <span>
                      行业均值 <b>{industry.mean.toFixed(2)}%</b>
                    </span>
                    <span>
                      行业中位 <b>{industry.median.toFixed(2)}%</b>
                    </span>
                    <span>
                      排名 <b>{industry.rank ?? '—'}</b>/{industry.peers.length}（{percentileText(industrySelf.percentile)}）
                    </span>
                    <span>
                      机构持仓合计 <b>{yi(industry.totalValue)}</b>
                    </span>
                    <span>
                      机构家数 <b>{industry.totalHolders.toLocaleString()}</b>
                    </span>
                  </div>

                  <div className="grid-2" style={{ marginTop: 12 }}>
                    <div>
                      <div className="ind-sub">行业分布 · 该股落在哪一档</div>
                      {histOption ? (
                        <EChart option={histOption} height={260} />
                      ) : (
                        <EmptyTip text="分布数据不可用" />
                      )}
                      <div className="inst-hint">
                        红色柱为该股所在区间（{(industrySelf.peer?.instRatio ?? 0).toFixed(2)}%），虚线为行业均值/中位；
                        横轴为机构持股比例（%），纵轴为成分股家数。
                      </div>
                    </div>
                    <div>
                      <div className="ind-sub">类型结构 · 该股 vs 行业平均</div>
                      {typeCmpOption ? <EChart option={typeCmpOption} height={260} /> : <EmptyTip text="类型数据不可用" />}
                      <div className="inst-hint">
                        同一口径下逐类对比：若某类柱子明显高于行业，说明该股的机构结构偏向这类资金。
                      </div>
                    </div>
                  </div>

                  <div className="grid-2" style={{ marginTop: 12 }}>
                    <div>
                      <div className="ind-sub">公募持仓强度趋势 · 行业 vs 该股</div>
                      {indHistOption ? (
                        <EChart option={indHistOption} height={240} />
                      ) : (
                        <EmptyTip text="时序数据不可用" />
                      )}
                      <div className="inst-hint">
                        行业线为成分股「基金持股比例」的均值（近 {industry.history.length} 个<b>同口径</b>报告期，
                        已排除季报/半年报混比）；两线背离说明该股被公募单独加仓或减仓。
                      </div>
                    </div>
                    <div>
                      <div className="ind-sub">行业机构重仓榜 · TOP 15</div>
                      {industryChart ? (
                        <EChart option={industryChart.option} height={240} />
                      ) : (
                        <EmptyTip text="榜单数据不可用" />
                      )}
                      <div className="inst-hint">红色为该股（{industryChart?.highlightName || '—'}），其余为同行业成分股。</div>
                    </div>
                  </div>

                  <div className="ind-sub" style={{ marginTop: 14 }}>
                    行业成分明细 · 共 {industry.peers.length} 只（按机构持股比例排序，该股高亮）
                  </div>
                  <div className="tbl-wrap" style={{ maxHeight: 380, overflowY: 'auto' }}>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th style={{ width: 44 }}>#</th>
                          <th>名称</th>
                          <th className="num">机构持股</th>
                          <th className="num">较行业中位</th>
                          <th className="num">机构家数</th>
                          <th className="num">持仓市值</th>
                          <th>类型结构</th>
                        </tr>
                      </thead>
                      <tbody>
                        {industry.peers.map((p, i) => {
                          const isSelf = p.code === bare(data.code);
                          const diff = p.instRatio - industry.median;
                          return (
                            <tr key={p.code} className={isSelf ? 'hl' : undefined}>
                              <td>{i + 1}</td>
                              <td>
                                <b>{p.name || p.code}</b>
                                {isSelf && <span className="badge info" style={{ marginLeft: 6 }}>本股</span>}
                              </td>
                              <td className="num">{p.instRatio.toFixed(2)}%</td>
                              <td className="num" style={{ color: diff >= 0 ? 'var(--up)' : 'var(--down)' }}>
                                {diff >= 0 ? '+' : ''}
                                {diff.toFixed(2)}pp
                              </td>
                              <td className="num">{p.holders.toLocaleString()}</td>
                              <td className="num">{yi(p.value)}</td>
                              <td>
                                <span className="ind-mix">
                                  {(['fund', 'qfii', 'social', 'insurance', 'broker'] as OrgTypeKey[])
                                    .map((t) => ({ t, v: p.byType[t] ?? 0 }))
                                    .filter((x) => x.v > 0.005)
                                    .sort((a, b) => b.v - a.v)
                                    .slice(0, 3)
                                    .map((x) => (
                                      <em key={x.t} style={{ color: TYPE_COLOR[x.t] }}>
                                        {ORG_TYPE_LABEL[x.t]} {x.v.toFixed(1)}%
                                      </em>
                                    ))}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Panel>
          )}
            </>
          )}

          {tab === 'stock' && (
            <>
          <div className="inst-head">
            <div className="inst-name">
              <b>{data.name || target.name}</b>
              <span>{data.code}</span>
              <span className="badge info">{period ? periodLabel(period) : '—'} 报告期</span>
              <SourcePill
                source={data.source === 'cache' ? 'cache' : data.source === 'sina-f10' ? 'sina' : 'eastmoney'}
                cacheTs={data.cacheTs}
              />
              <span
                className={'badge ' + (reportKind(period) === 'full' ? 'info' : 'flat')}
                title={
                  reportKind(period) === 'full'
                    ? '半年报/年报：基金披露全部持仓，机构家数与比例更完整'
                    : '季报：基金只披露前十大重仓股，机构持仓被系统性低估，只与同类季报比较'
                }
              >
                {reportKind(period) === 'full' ? '全量披露' : '仅前十大重仓'}
              </span>
              {data.degraded && <span className="badge flat">降级：十大流通股东口径</span>}
              {view.incomplete && <span className="badge flat">披露未完整</span>}
            </div>
            <div className="inst-hint">
              报告期距今 {daysSince(period)} 天 · 当期明细 {detailTotal} 条
              {detailRows.length < detailTotal ? `（已取前 ${detailRows.length} 条）` : ''}
            </div>
          </div>

          <div className="inst-src-row">
            <span>
              类型汇总 <b>{srcText(data.sources?.orgHold ?? null)}</b>
            </span>
            <span>
              机构明细 <b>{srcText(data.sources?.detail ?? null)}</b>
            </span>
            <span>
              十大流通股东 <b>{srcText(data.sources?.topHolders ?? null)}</b>
              {data.topHolderDate ? ` · ${data.topHolderDate}` : ''}
            </span>
            <span>
              股东户数 <b>{srcText(data.sources?.holderNum ?? null)}</b>
            </span>
          </div>

          {data.degraded && (
            <div className="inst-notice">
              <span>
                ⚠️ 东财数据中心不可达，已降级：只用<b>十大流通股东</b>（{data.topHolders?.length ?? 0} 个主体）做结构与集中度，
                比例口径为<b>占流通股</b>，不等于全量机构持仓。
              </span>
              <button type="button" className="gear-btn" onClick={() => void load(target, true)}>
                重试全量源
              </button>
            </div>
          )}

          {!data.degraded && reportKind(period) === 'full' && latestPeriod && reportKind(latestPeriod) === 'partial' && (
            <div className="inst-notice">
              <span>
                最新报告期 {periodLabel(latestPeriod)} 为<b>季报</b>（基金仅披露前十大重仓），已默认展示最近的<b>全量披露期</b>{' '}
                {periodLabel(period)}。想看最新一季的边际变化可切换过去，但注意其口径偏低。
              </span>
              <button type="button" className="gear-btn" onClick={() => setPeriod(latestPeriod)}>
                看最新 {periodLabel(latestPeriod)}
              </button>
            </div>
          )}

          {!data.degraded && reportKind(period) === 'partial' && (
            <div className="inst-notice">
              <span>
                ℹ️ {periodLabel(period)} 是<b>季报</b>：基金只披露前十大重仓股，机构持仓被<b>系统性低估</b>
                （本期机构投资者 {view.instRatio.toFixed(2)}%，与同为季报的 {view.prevDate ? periodLabel(view.prevDate) : '上期'} 对比才有效）。
                想看完整机构画像，请切到全量披露期。
              </span>
              {latestFull && latestFull !== period && (
                <button type="button" className="gear-btn" onClick={() => setPeriod(latestFull)}>
                  看 {periodLabel(latestFull)}（全量）
                </button>
              )}
            </div>
          )}

          {view.incomplete && !data.degraded && (
            <div className="inst-notice">
              <span>
                ⏳ {periodLabel(period)} 披露未完整：已披露机构 {view.holders} 家，上期 {view.prevSum?.holders ?? '—'} 家。
                环比与结论暂不可靠（不是「机构撤退」，而是还没披露完）。
              </span>
              {completeDate && completeDate !== period && (
                <button type="button" className="gear-btn" onClick={() => setPeriod(completeDate)}>
                  看完整期 {periodLabel(completeDate)}
                </button>
              )}
            </div>
          )}

          <LayerHeader
            index="③"
            title={`个股 · ${data.name || target.name}`}
            sub={`${data.code} · ${period ? periodLabel(period) : '—'} 报告期 · 明细穿透口径（剔除产业资本与个人）`}
            extra={
              view.penetrated ? (
                <span className="inst-hint">
                  机构投资者 {view.instRatio.toFixed(2)}% · {view.instCount} 个披露主体
                </span>
              ) : undefined
            }
          />

          {position?.self && (
            <div className="pos-bar">
              <span>
                所属行业 <b>{position.self.industry ?? '—'}</b>
              </span>
              <span>
                行业分位{' '}
                <b style={{ color: (position.pInd ?? 0) >= 0.5 ? 'var(--up)' : 'var(--down)' }}>
                  {position.pInd != null ? percentileText(position.pInd) : '—'}
                </b>
                {position.peerCount ? `（${position.peerCount} 只）` : ''}
              </span>
              <span>
                全市场分位{' '}
                <b style={{ color: position.pAll >= 0.5 ? 'var(--up)' : 'var(--down)' }}>{percentileText(position.pAll)}</b>
                （{market?.members.toLocaleString()} 只）
              </span>
              <span>
                行业均值 <b>{position.indMean != null ? position.indMean.toFixed(2) + '%' : '—'}</b> · 全市场均值{' '}
                <b>{market ? market.instMean.toFixed(2) + '%' : '—'}</b>
              </span>
            </div>
          )}

          <MetricGrid
            items={
              data.degraded
                ? [
                    { label: '前十大中机构', value: `${view.instCount} 个`, sub: `样本 ${sample.rows.length} 个主体` },
                    {
                      label: '机构占前十合计',
                      value: `${(
                        (view.instRatio / Math.max(1e-6, sample.rows.reduce((s, r) => s + r.ratio, 0))) * 100
                      ).toFixed(1)}%`,
                      sub: '占流通股口径'
                    },
                    { label: '公募基金', value: `${(view.buckets.find((b) => b.cls === 'public')?.ratio ?? 0).toFixed(2)}%`, sub: '占流通股' },
                    { label: '私募基金', value: `${(view.buckets.find((b) => b.cls === 'private')?.ratio ?? 0).toFixed(2)}%`, sub: '占流通股' },
                    {
                      label: '国家大基金 / 国家队',
                      value: `${(
                        (view.buckets.find((b) => b.cls === 'bigfund')?.ratio ?? 0) +
                        (view.buckets.find((b) => b.cls === 'national')?.ratio ?? 0)
                      ).toFixed(2)}%`,
                      sub: '占流通股'
                    },
                    {
                      label: '股东户数',
                      value: view.holderNum ? `${(view.holderNum.holders / 1e4).toFixed(2)}万` : '—',
                      sub: view.holderNum ? `${periodLabel(view.holderNum.date)} · ${view.holderNum.focus}` : '无数据'
                    }
                  ]
                : [
                    {
                      label: '机构投资者持股',
                      value: `${view.instRatio.toFixed(2)}%`,
                      sub: `${view.instCount} 个披露主体 · ${yi(view.instVal)}`,
                      tone: view.chgPp == null ? undefined : view.chgPp >= 0 ? 'up' : 'down'
                    },
                    {
                      label: '较上期变化',
                      value: view.incomplete
                        ? '披露中'
                        : view.chgPp == null
                          ? '—'
                          : `${view.chgPp >= 0 ? '+' : ''}${view.chgPp.toFixed(2)}pp`,
                      sub: view.incomplete
                        ? '披露未完整，暂不比较'
                        : view.chgPp == null
                          ? '无同口径可比期'
                          : `同口径 · 对比 ${periodLabel(view.prevDate ?? '')} · 家数 ${fmtPct(view.holdersChg ?? 0, 1)}`,
                      tone: view.incomplete || view.chgPp == null ? undefined : view.chgPp >= 0 ? 'up' : 'down'
                    },
                    {
                      label: '公募基金',
                      value: `${(view.buckets.find((b) => b.cls === 'public')?.ratio ?? 0).toFixed(2)}%`,
                      sub: `${view.buckets.find((b) => b.cls === 'public')?.count ?? 0} 只产品`
                    },
                    {
                      label: '私募基金',
                      value: `${(view.buckets.find((b) => b.cls === 'private')?.ratio ?? 0).toFixed(2)}%`,
                      sub: `${view.buckets.find((b) => b.cls === 'private')?.count ?? 0} 只产品`
                    },
                    {
                      label: '国家大基金 / 国家队',
                      value: `${(
                        (view.buckets.find((b) => b.cls === 'bigfund')?.ratio ?? 0) +
                        (view.buckets.find((b) => b.cls === 'national')?.ratio ?? 0)
                      ).toFixed(2)}%`,
                      sub: `${(view.buckets.find((b) => b.cls === 'bigfund')?.count ?? 0) + (view.buckets.find((b) => b.cls === 'national')?.count ?? 0)} 个主体`
                    },
                    {
                      label: '股东户数',
                      value: view.holderNum ? `${(view.holderNum.holders / 1e4).toFixed(2)}万` : '—',
                      sub: view.holderNum
                        ? `${periodLabel(view.holderNum.date)} · ${
                            view.holderNum.chgPct != null
                              ? `环比 ${view.holderNum.chgPct > 0 ? '+' : ''}${view.holderNum.chgPct.toFixed(1)}%`
                              : '无环比'
                          }`
                        : '无数据',
                      tone: view.holderNum?.chgPct == null ? undefined : view.holderNum.chgPct < 0 ? 'up' : 'down'
                    }
                  ]
            }
          />

          {!data.degraded && (
            <div className="grid-2" style={{ marginTop: 16 }}>
              <Panel
                title="机构类型持仓占比演化"
                icon="📚"
                desc={`官方口径 · 近 ${trendDates.length} 个报告期 · 仅列基金/QFII/社保/保险/券商；「其他」混有控股股东与产业资本（当期 ${view.industrialRatio.toFixed(
                  2
                )}%），故不并入`}
              >
                <EChart option={trendOption} height={300} />
              </Panel>
              <Panel
                title={`当期资金结构 · ${periodLabel(period)}`}
                icon="🥧"
                desc={
                  view.penetrated
                    ? `穿透口径 · 机构投资者合计 ${view.instRatio.toFixed(2)}%（占已披露机构市值 ${yi(view.coveredValue)}）`
                    : '当期明细不可用，无法穿透'
                }
              >
                {pieData ? <EChart option={pieData} height={300} /> : <EmptyTip text={detailLoading ? '正在拉取该报告期明细…' : '该报告期明细不可用'} />}
              </Panel>
            </div>
          )}

          <div className={data.degraded ? '' : 'grid-2'} style={{ marginTop: 16 }}>
            <Panel
              title={data.degraded ? '前十大流通股东属性结构' : '机构属性穿透（占总股本）'}
              icon="🔍"
              desc={
                data.degraded
                  ? `仅 ${sample.rows.length} 个披露主体 · 占流通股口径 · 产业资本 ${view.industrialRatio.toFixed(2)}% 不计入机构口径`
                  : `按股东名称规则重分类 · 覆盖 ${detailRows.length} 条明细 · 产业资本 ${view.industrialRatio.toFixed(
                      2
                    )}%（${yi(view.industrialValue)}）不计入机构口径`
              }
            >
              {view.buckets.some((b) => b.ratio > 0.005) ? (
                <>
                  <EChart option={clsBarOption} height={260} />
                  <div className="cls-legend">
                    {view.buckets
                      .filter((b) => b.ratio > 0.005)
                      .map((b) => (
                        <span key={b.cls} title={CLASS_META[b.cls].note}>
                          <i style={{ background: clsColor(b.cls) }} />
                          {b.label} {b.ratio.toFixed(2)}%
                          {(() => {
                            const d = view.clsDeltas.find((x) => x.cls === b.cls);
                            return d ? (
                              <em className={d.delta > 0 ? 'd-up' : 'd-down'}>
                                {d.delta > 0 ? '+' : ''}
                                {d.delta.toFixed(2)}pp
                              </em>
                            ) : null;
                          })()}
                        </span>
                      ))}
                  </div>
                </>
              ) : (
                <EmptyTip text={detailLoading ? '正在拉取该报告期明细…' : '该报告期明细不可用，无法做属性穿透'} />
              )}
            </Panel>
            {!data.degraded && (
              <Panel
                title={`环比增减仓 · ${periodLabel(period)}${view.prevDate ? ' vs ' + periodLabel(view.prevDate) : ''}`}
                icon="⚖️"
                desc="官方口径各类型持股比例变动（百分点）；季报披露未完整时仅供参考"
                extra={view.incomplete ? <span className="badge flat">披露中</span> : undefined}
              >
                {deltaOption ? <EChart option={deltaOption} height={260} /> : <EmptyTip text="无上期可比数据" />}
              </Panel>
            )}
          </div>


          {smartDetail && smartDetail.rows.length > 0 && (
            <Panel
              title="聪明资金动向"
              icon="🧠"
              desc="外资（QFII + 北向通道）、国家大基金、国家队、社保、保险 —— 与公募/私募这类交易型资金区分开看"
              extra={
                <span className="inst-hint">
                  合计 {smartDetail.total.toFixed(2)}%
                  {smartDetail.delta != null ? ` · 环比 ${smartDetail.delta >= 0 ? '+' : ''}${smartDetail.delta.toFixed(2)}pp` : ''}
                </span>
              }
              style={{ marginTop: 16 }}
            >
              <div className="grid-2">
                <div>
                  <div className="ind-sub">构成 · 各类聪明资金占总股本</div>
                  <EChart
                    option={barOption(
                      smartDetail.rows.map((r) => r.label),
                      [{ name: '占总股本', data: smartDetail.rows.map((r) => Number(r.ratio.toFixed(3))), color: C.purple }],
                      { horizontal: true, labels: true, unit: '%' }
                    )}
                    height={Math.max(160, 42 * smartDetail.rows.length)}
                  />
                  <div className="inst-hint">
                    北向通道（香港中央结算）在穿透口径里并入「外资/ QFII」，下表单列的是它在十大流通股东里的持股（占流通股），两种口径不叠加。
                  </div>
                </div>
                <div>
                  <div className="ind-sub">明细 · 占比 / 家数 / 环比</div>
                  <div className="tbl-wrap">
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>类别</th>
                          <th className="num">占总股本</th>
                          <th className="num">主体数</th>
                          <th className="num">环比</th>
                        </tr>
                      </thead>
                      <tbody>
                        {smartDetail.rows.map((r) => (
                          <tr key={r.cls}>
                            <td>
                              <span className="cls-tag" style={{ color: clsColor(r.cls), borderColor: clsColor(r.cls) }}>
                                {r.label}
                              </span>
                            </td>
                            <td className="num">{r.ratio.toFixed(3)}%</td>
                            <td className="num">{r.count}</td>
                            <td className="num" style={{ color: r.delta == null ? 'var(--text-3)' : r.delta >= 0 ? 'var(--up)' : 'var(--down)' }}>
                              {r.delta == null ? '—' : `${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(2)}pp`}
                            </td>
                          </tr>
                        ))}
                        {smartDetail.north && (
                          <tr>
                            <td>
                              <span className="cls-tag" style={{ color: C.gray, borderColor: C.gray }}>
                                北向通道（参考）
                              </span>
                            </td>
                            <td className="num">{smartDetail.north.ratio.toFixed(2)}%</td>
                            <td className="num">1</td>
                            <td className="num" style={{ color: 'var(--text-3)' }}>
                              {smartDetail.north.chgShares == null
                                ? '—'
                                : `${smartDetail.north.chgShares >= 0 ? '增持 ' : '减持 '}${Math.abs(
                                    smartDetail.north.chgShares
                                  ).toLocaleString()} 股`}
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                  <div className="inst-hint">「环比」为该类资金占总股本比例的季度变化，仅在两期明细都可穿透时计算。</div>
                </div>
              </div>
            </Panel>
          )}

          <div className="grid-2" style={{ marginTop: 16 }}>
            <Panel
              title="筹码集中度"
              icon="🎯"
              desc={
                view.holderNum
                  ? `股东户数 ${view.holderNum.holders.toLocaleString()} 户 · 户均持股 ${sharesText(view.holderNum.avgFreeShares)} · ${view.holderNum.focus}`
                  : '股东户数数据不可用'
              }
            >
              {holderOption ? <EChart option={holderOption} height={280} /> : <EmptyTip text="F10 股东户数未取到" />}
            </Panel>
            <Panel
              title="集中度指标"
              icon="📐"
              desc={data.degraded ? '基于十大流通股东样本（占流通股），HHI 会系统性偏高' : '仅统计机构投资者（剔除产业资本与个人）'}
            >
              <div className="inst-conc">
                {(data.degraded
                  ? [
                      { k: 'HHI 赫芬达尔指数', v: view.conc.hhi.toFixed(3), n: 'Σwᵢ²，样本仅 10 个主体，偏高' },
                      { k: '等效机构家数', v: view.conc.effectiveN.toFixed(1), n: '1/HHI' },
                      { k: '第一大机构占比', v: `${(view.conc.top1 * 100).toFixed(1)}%`, n: '占样本机构合计' },
                      { k: '前五大占比', v: `${(view.conc.top5 * 100).toFixed(1)}%`, n: 'CR5（样本口径）' }
                    ]
                  : [
                      { k: 'HHI 赫芬达尔指数', v: view.conc.hhi.toFixed(3), n: 'Σwᵢ²，越大越集中' },
                      { k: '等效机构家数', v: view.conc.effectiveN.toFixed(1), n: '1/HHI，相当于多少家等权机构' },
                      { k: '第一大机构占比', v: `${(view.conc.top1 * 100).toFixed(1)}%`, n: '占机构持仓合计' },
                      { k: '前五大占比', v: `${(view.conc.top5 * 100).toFixed(1)}%`, n: 'CR5' },
                      { k: '前十大占比', v: `${(view.conc.top10 * 100).toFixed(1)}%`, n: 'CR10' }
                    ]
                ).map((x) => (
                  <div key={x.k} className="conc-item">
                    <div className="conc-k">{x.k}</div>
                    <div className="conc-v">{x.v}</div>
                    <div className="conc-n">{x.n}</div>
                  </div>
                ))}
              </div>
            </Panel>
          </div>

          <Panel
            title={data.degraded ? '十大流通股东' : `机构明细 TOP ${topRows.length}`}
            icon="📋"
            desc={
              data.degraded
                ? `${data.topHolderDate} · 来源 ${srcText(data.sources?.topHolders ?? null)} · 新浪源无变动股数`
                : `${periodLabel(period)} · 按持仓市值排序 · 属性由名称规则识别，可能与官方分类不同（例如国家大基金被东财归入私募）`
            }
            extra={
              <span className="inst-hint">
                {detailLoading ? '加载中…' : data.degraded ? `${sample.rows.length} 条` : `${detailRows.length}/${detailTotal} 条`}
              </span>
            }
            style={{ marginTop: 16 }}
          >
            {topRows.length === 0 ? (
              <EmptyTip text="该报告期明细不可用" />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>机构名称</th>
                      <th>属性</th>
                      <th className="num">持股（股）</th>
                      {!data.degraded && <th className="num">市值</th>}
                      <th className="num">{data.degraded ? '占流通股' : '占总股本'}</th>
                      {!data.degraded && <th className="num">占净值</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {topRows.map((r, i) => (
                      <tr key={`${r.name}-${i}`}>
                        <td>
                          <b>{r.name}</b>
                          {r.parent && r.parent !== r.name && <span className="inst-parent">{r.parent}</span>}
                        </td>
                        <td>
                          <span className="cls-tag" style={{ color: clsColor(r.cls), borderColor: clsColor(r.cls) }}>
                            {CLASS_META[r.cls].label}
                          </span>
                        </td>
                        <td className="num">{r.shares.toLocaleString()}</td>
                        {!data.degraded && <td className="num">{yi(r.value)}</td>}
                        <td className="num">{r.ratio.toFixed(3)}%</td>
                        {!data.degraded && <td className="num">{r.netAssetRatio != null ? `${r.netAssetRatio.toFixed(2)}%` : '—'}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel
            title="机构持仓解读"
            icon="🧭"
            desc={
              data.degraded
                ? '降级模式：仅按十大流通股东描述结构，不给评分（样本不足会失真）'
                : '规则化评分：机构持股水平 + 环比方向 + 筹码集中度 + 特殊资金在场'
            }
            style={{ marginTop: 16 }}
          >
            {!data.degraded && (
              <div className="inst-signal">
                <div className="sig-score">
                  <div
                    className="sig-num"
                    style={{ color: view.sig.tone === 'bull' ? 'var(--up)' : view.sig.tone === 'bear' ? 'var(--down)' : 'var(--text-2)' }}
                  >
                    {view.sig.score}
                    <span>/100</span>
                  </div>
                  <div className={'badge ' + (view.sig.tone === 'bull' ? 'bull' : view.sig.tone === 'bear' ? 'bear' : 'flat')}>
                    {view.sig.label}
                  </div>
                  <div className="sig-bar">
                    <div
                      style={{
                        width: `${view.sig.score}%`,
                        background: view.sig.tone === 'bull' ? 'var(--up)' : view.sig.tone === 'bear' ? 'var(--down)' : 'var(--gray, #94a3b8)'
                      }}
                    />
                  </div>
                </div>
                <ul className="sig-reasons">
                  {view.sig.reasons.map((r, i) => (
                    <li key={i}>
                      <span className={r.delta > 0 ? 'd-up' : r.delta < 0 ? 'd-down' : 'd-flat'}>
                        {r.delta > 0 ? `+${r.delta.toFixed(1)}` : r.delta.toFixed(1)}
                      </span>
                      {r.text}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="inst-read">
              <p>
                <b>结构：</b>
                {view.buckets.length === 0
                  ? '当期明细不可用，仅能参考官方类型汇总。'
                  : (() => {
                      const top = [...view.buckets].sort((a, b) => b.value - a.value)[0];
                      return (
                        `机构投资者中，${top.label}持仓最多（占机构持仓 ${(top.instShare * 100).toFixed(1)}%）；` +
                        `公募 ${(view.buckets.find((b) => b.cls === 'public')?.ratio ?? 0).toFixed(2)}%` +
                        `、私募 ${(view.buckets.find((b) => b.cls === 'private')?.ratio ?? 0).toFixed(2)}%` +
                        `、外资 ${(view.buckets.find((b) => b.cls === 'foreign')?.ratio ?? 0).toFixed(2)}%` +
                        `、国家大基金 ${(view.buckets.find((b) => b.cls === 'bigfund')?.ratio ?? 0).toFixed(2)}%` +
                        `（${data.degraded ? '占流通股' : '占总股本'}）。`
                      );
                    })()}
              </p>
              {!data.degraded && (
                <p>
                  <b>边际：</b>
                  {view.incomplete
                    ? `${periodLabel(period)} 披露未完整，机构家数仅 ${view.holders} 家（上期 ${view.prevSum?.holders ?? '—'} 家），本期环比不具可比性。`
                    : view.chgPp == null
                      ? '无上一报告期数据，无法计算边际变化。'
                      : `较 ${periodLabel(view.prevDate!)}，机构合计持股 ${view.chgPp >= 0 ? '增加' : '减少'} ${Math.abs(view.chgPp).toFixed(
                          2
                        )} 个百分点，机构家数 ${(view.holdersChg ?? 0) >= 0 ? '增加' : '减少'} ${Math.abs((view.holdersChg ?? 0) * 100).toFixed(1)}%。`}
                  {view.typeDeltas.filter((d) => Math.abs(d.delta) > 0.001).length > 0 && !view.incomplete
                    ? ' 各类型中，' +
                      view.typeDeltas
                        .filter((d) => Math.abs(d.delta) > 0.001)
                        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                        .slice(0, 3)
                        .map((d) => `${d.label}${d.delta > 0 ? '加仓' : '减仓'} ${Math.abs(d.delta).toFixed(2)}pp`)
                        .join('、') +
                      '。'
                    : ''}
                  {view.clsDeltas.length > 0
                    ? ' 属性层面，' +
                      [...view.clsDeltas]
                        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
                        .slice(0, 3)
                        .map((d) => `${d.label}${d.delta > 0 ? '增持' : '减持'} ${Math.abs(d.delta).toFixed(2)}pp`)
                        .join('、') +
                      '。'
                    : ''}
                </p>
              )}
              {!data.degraded && position?.self && (
                <p>
                  <b>位置：</b>
                  所属 <b>{position.self.industry ?? '—'}</b>
                  {position.peerCount ? `（${position.peerCount} 只成分股）` : ''}，该股机构持股{' '}
                  {position.self.inst.toFixed(2)}%，行业均值 {position.indMean?.toFixed(2) ?? '—'}%、全市场均值{' '}
                  {market?.instMean.toFixed(2) ?? '—'}%。
                  {position.pInd != null ? `在行业内${percentileText(position.pInd)}，` : ''}
                  在全市场{percentileText(position.pAll)}。
                </p>
              )}
              <p>
                <b>筹码：</b>
                {view.holderNum
                  ? `股东户数 ${view.holderNum.holders.toLocaleString()} 户（${view.holderNum.focus}），户均持股 ${sharesText(
                      view.holderNum.avgFreeShares
                    )}；` +
                    (view.holderNum.chgPct == null
                      ? '无环比数据。'
                      : `环比 ${view.holderNum.chgPct > 0 ? '增加' : '减少'} ${Math.abs(view.holderNum.chgPct).toFixed(1)}%，${
                          view.holderNum.chgPct < 0 ? '筹码趋于集中' : '筹码趋于分散'
                        }。`)
                  : '股东户数不可用。'}
                机构口径 HHI {view.conc.hhi.toFixed(3)}（等效 {view.conc.effectiveN.toFixed(1)} 家），前十大机构占机构持仓{' '}
                {(view.conc.top10 * 100).toFixed(1)}%。
              </p>
              <p className="inst-warn">
                <b>口径提示：</b>
                {data.degraded
                  ? '当前为降级模式，样本仅十大流通股东，比例口径为占流通股，不能与「占总股本」的机构持仓直接比较。'
                  : `官方「机构汇总」为 ${(view.sum?.ratio ?? 0).toFixed(2)}%，其中产业资本/控股股东约 ${view.industrialRatio.toFixed(
                      2
                    )}%，扣除后才是机构投资者的 ${view.instRatio.toFixed(2)}%。`}
                穿透依赖股东名称规则，可能误判；明细仅覆盖已披露主体（当期{' '}
                {data.degraded ? sample.rows.length : `${detailRows.length}/${detailTotal}`} 条），不等于全量持仓；报告期距今 {daysSince(period)}{' '}
                天，存在滞后。本页不构成投资建议。
              </p>
            </div>
          </Panel>

          <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页机构持仓指标交给 AI 解读，只读不改任何设置">
            <AiAnalyze
              module="机构持仓分析"
              note="机构持仓是事实数据；穿透依赖股东名称规则，明细仅覆盖已披露主体，不等于全量持仓。"
              facts={[
                { label: '机构持股占比', value: view.instRatio.toFixed(2) + '%' + (view.chgPp != null ? '（环比 ' + view.chgPp.toFixed(2) + 'pp）' : '') },
                { label: '机构家数 / 产业资本占比', value: view.instCount + ' 家 / ' + view.industrialRatio.toFixed(2) + '%' },
                { label: '股东户数', value: view.holders.toLocaleString() + (view.holdersChg != null ? '（环比 ' + view.holdersChg.toFixed(2) + '%）' : '') },
                { label: '持仓评分 / 判定', value: view.sig.score.toFixed(0) + ' / ' + view.sig.label + '（' + view.sig.tone + '）' },
                { label: 'HHI 集中度', value: view.conc.hhi.toFixed(3) + '（前10占比 ' + view.conc.top10.toFixed(2) + '%）' },
                ...view.buckets.filter((b) => b.ratio > 0).map((b) => ({ label: '类型·' + b.label, value: b.ratio.toFixed(2) + '%' })),
                { label: '报告期', value: period + (data.degraded ? '（降级：占流通股口径）' : '') }
              ]}
            />
          </Panel>

          <MathPanel>
            <h4>一、两个口径</h4>
            <p>
              官方报表按机构类型聚合，<code>ORG_TYPE=00</code> 的 <code>TOTALSHARES_RATIO</code> 是「机构汇总」，
              但它把控股股东与产业资本也算了进去（例如茅台集团持股 54% 被归入「其他」）。
              因此本页另设穿透口径：<code>R_inst = Σ_(i∈机构) r_i</code>，其中 <code>r_i = 持股数_i / 总股本 × 100%</code>，
              机构集合由名称规则判定，产业资本与个人被排除。
            </p>
            <h4>二、属性穿透规则</h4>
            <p>
              有序正则匹配，强特征优先：<b>国家大基金</b>（国家集成电路产业投资基金 / 制造业转型升级基金…）→
              <b>国家队</b>（证金 / 汇金 / 梧桐树 / 外汇局）→ <b>社保</b> → <b>保险</b> → <b>外资</b>（QFII、香港中央结算）→
              <b>私募</b>（高毅、景林、淡水泉…及官方标注「私募基金」）→ <b>公募</b>（ETF / 指数 / 混合 / 基金专户）→
              <b>券商/信托</b> → <b>产业资本</b> → <b>个人</b>。
              顺序不能颠倒：东财会把国家大基金标注为「私募基金」，若先按官方类型分类就会误判。
            </p>
            <h4>三、多源降级</h4>
            <p>
              按数据块各自降级：<b>类型汇总/明细</b>只有东财数据中心提供；<b>股东户数</b>只有东财 F10 提供；
              <b>十大流通股东</b>为东财 F10 → 新浪 F10（HTML/GBK 解析，含股本性质）。
              数据中心整块不可用时进入降级模式：只用十大流通股东（占流通股口径）做结构与集中度，并隐藏需要全量样本的指标。
            </p>
            <h4>四、行业视角</h4>
            <p>
              所属行业取自东财行业板块（<code>RPT_BOARD_CONSTITUENT</code>，<code>BOARD_TYPE_NEW=2</code>，优先二级行业），
              再用 <code>SECURITY_CODE in (...)</code> 一次批量取全行业成分股的机构持仓。
              行业指标 <code>R̄ = Σ(5类机构占比)</code>（剔除「其他」），排名按该值降序，中位数用于抵抗龙头股拉偏。
            </p>
            <h4>五、集中度</h4>
            <p>
              <code>HHI = Σ_i w_i²</code>，<code>w_i = 市值_i / Σ市值</code>，<code>N_eff = 1/HHI</code>。
              HHI=0.05 相当于 20 家等权机构；HHI&gt;0.35 说明单一机构控盘，流动性风险上升。
              <code>CR_k = Σ_(i≤k) w_i</code> 为前 k 大机构占比。
            </p>
            <h4>六、信号评分</h4>
            <p>
              <code>Score = 50 + Σ δ_k</code>，每一项 δ 都在理由列表里可追溯：
              持股水平（≥30% +14 / ≥15% +10 / ≥8% +5 / &lt;3% −6）、环比（每 1pp ±6，限幅 ±12）、
              股东户数（≤−10% +10 / ≥+10% −10）、国家大基金 +8、国家队 +5、公募主导 +3、HHI&gt;0.35 −5。裁剪到 [0,100]。
            </p>
            <h4>七、披露完整性与为什么不给模拟数据</h4>
            <p>
              季报披露期长达一个月，本页以 <code>家数_t &lt; 0.8 × 家数_(t−1)</code> 判定「披露未完整」，此时不计算环比。
              机构持仓是<b>事实陈述</b>——伪造的机构名单会直接误导判断，因此取数失败只给错误与重试，不给 DEMO。
            </p>
          </MathPanel>
            </>
          )}
        </>
      )}

      {!loading && !error && data && data.warnings.length > 0 && (
        <div className="inst-hint" style={{ marginTop: 10 }}>
          ⚠️ {data.warnings.join('；')}
        </div>
      )}
    </div>
  );
}
