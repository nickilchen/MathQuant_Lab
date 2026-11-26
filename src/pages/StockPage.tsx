import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import EChart from '../components/EChart';
import {
  CtrlGroup,
  EmptyTip,
  Loading,
  MathPanel,
  MetricGrid,
  Panel,
  SourcePill,
  fmtPct
} from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { C, gaugeOption, lineOption } from '../components/chartOptions';
import { useApp } from '../hooks/AppContext';
import { searchStocks, type StockHit } from '../data/search';
import { getSymbol, MARKET_LABEL, type Market } from '../data/symbols';
import { loadRecent, loadWatchlist } from '../data/watchlist';
import { analyzeTrend } from '../pipelines/trend';
import { runFactorModel, runHmmModel, runMlModel, runVolModel } from '../pipelines';
import { sma } from '../math/indicators';
import { analyzeTechnicals } from '../math/technicals';
import { ANN_TAG_META, analyzeAnnouncements, type AnnAnalysis, type AnnTag } from '../math/stockNews';
import { canFetchAnn, ensureAnnouncements, isIndexCode } from '../data/stockNews';

const HOT: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', tencent: 'sh600519', sina: 'sh600519', secid: '1.600519' },
  { code: 'sh000001', name: '上证指数', market: 'CN', marketLabel: 'A股', tencent: 'sh000001', sina: 'sh000001', secid: '1.000001' },
  { code: 'hk00700', name: '腾讯控股', market: 'HK', marketLabel: '港股', tencent: 'hk00700' },
  { code: 'usAAPL', name: '苹果', market: 'US', marketLabel: '美股', sina: 'AAPL', yahoo: 'AAPL' },
  { code: 'usNVDA', name: '英伟达', market: 'US', marketLabel: '美股', sina: 'NVDA', yahoo: 'NVDA' },
  { code: 'kr005930', name: '三星电子', market: 'KR', marketLabel: '韩股', naver: '005930' }
];

/** 从 hash 查询串读取 ?code=（/stock 路由无路径参数） */
const STARS = (n: number) => {
  const v = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(v) + '☆'.repeat(5 - v);
};

/** 基本面数值格式化：拿不到一律「—」，不猜 */
const fmtN = (v: number | null | undefined, d = 1, unit = ''): string =>
  v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(d)}${unit}`;

const fmtCap = (v: number | null | undefined, cur = ''): string => {
  if (v == null || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e12) return `${cur}${(v / 1e12).toFixed(2)} 万亿`;
  if (v >= 1e8) return `${cur}${(v / 1e8).toFixed(0)} 亿`;
  return `${cur}${(v / 1e4).toFixed(0)} 万`;
};

/** 阈值只做「偏高/偏低」的提示，不构成估值判断 */
const toneOf = (v: number | null | undefined, good: number, bad: number, higherBetter = true): 'up' | 'down' | 'flat' => {
  if (v == null || !Number.isFinite(v)) return 'flat';
  if (higherBetter) return v >= good ? 'up' : v <= bad ? 'down' : 'flat';
  return v <= good ? 'up' : v >= bad ? 'down' : 'flat';
};

export default function StockPage() {
  const { btCfg, registerStock, ensureKlines, invalidateKline, klines, ensureExtras, extras } = useApp();
  const params = useParams();
  const loc = useLocation();
  const queryCode = (() => {
    const s = (loc.search || '').replace(/^\?/, '');
    for (const part of s.split('&')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i) === 'code') return decodeURIComponent(part.slice(i + 1));
    }
    return '';
  })();
  const codeParam = params.code || queryCode;
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDrop, setShowDrop] = useState(false);
  const [picked, setPicked] = useState<StockHit | null>(null);
  const navigate = useNavigate();
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      const r = await searchStocks(query, 12);
      setHits(r);
      setSearching(false);
      setShowDrop(true);
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [query]);

  const pick = (hit: StockHit) => {
    registerStock(hit);
    setPicked(hit);
    setQuery(hit.name);
    setShowDrop(false);
  };

  // 深链：/stock?code=xxx 直接定位标的（自选池、全局搜索、对比页都跳这里）
  useEffect(() => {
    if (!codeParam || picked?.code === codeParam) return;
    const sym = getSymbol(codeParam);
    if (sym) {
      pick({
        code: sym.code,
        name: sym.name,
        market: sym.market,
        marketLabel: MARKET_LABEL[sym.market],
        secid: sym.secid || undefined,
        sina: sym.sina,
        naver: sym.naver,
        yahoo: sym.yahoo
      });
      return;
    }
    const stored = loadWatchlist().find((i) => i.code === codeParam) ?? loadRecent().find((i) => i.code === codeParam);
    if (stored) {
      pick(stored);
      return;
    }
    const prefix = codeParam.slice(0, 2).toLowerCase();
    const market: Market =
      prefix === 'hk' ? 'HK' : prefix === 'us' ? 'US' : prefix === 'kr' ? 'KR' : prefix === 'jp' ? 'JP' : 'CN';
    pick({ code: codeParam, name: codeParam, market, marketLabel: MARKET_LABEL[market] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeParam, picked]);

  // 选中后拉数（个股分析禁用模拟数据：拿不到实时行情就明确失败，绝不用假数据）
  useEffect(() => {
    if (picked) ensureKlines([picked.code], { allowDemo: false });
  }, [picked, ensureKlines]);

  // 资金流/估值快照属于副作用，放到 effect 里触发，避免渲染期更新 AppProvider
  useEffect(() => {
    if (picked) ensureExtras(picked.code);
  }, [picked, ensureExtras]);

  /* ---------- 个股消息面（公告） ---------- */

  const [annState, setAnnState] = useState<{
    loading: boolean;
    data: AnnAnalysis | null;
    total: number;
    error: string | null;
    /** 公告接口自带的股票简称（深链进来时 picked.name 可能只是代码） */
    name?: string;
  }>({ loading: false, data: null, total: 0, error: null });
  const [annTag, setAnnTag] = useState<AnnTag | null>(null);

  useEffect(() => {
    setAnnTag(null);
    if (!picked) {
      setAnnState({ loading: false, data: null, total: 0, error: null });
      return;
    }
    if (!canFetchAnn(picked.code)) {
      setAnnState({
        loading: false,
        data: null,
        total: 0,
        error: isIndexCode(picked.code)
          ? '指数没有公告（这里只看个股）'
          : '该市场暂无消息面数据源（当前支持 A 股 / 港股 / 美股）'
      });
      return;
    }
    let alive = true;
    setAnnState({ loading: true, data: null, total: 0, error: null });
    ensureAnnouncements(picked.code)
      .then((r) => {
        if (!alive) return;
        setAnnState({ loading: false, data: analyzeAnnouncements(r.list, r.name ?? picked.name), total: r.total, error: null, name: r.name });
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setAnnState({ loading: false, data: null, total: 0, error: e instanceof Error ? e.message : '公告获取失败' });
      });
    return () => {
      alive = false;
    };
  }, [picked]);

  const st = picked ? klines[picked.code] : undefined;
  const bars = st && !st.loading && !st.failed && st.bars.length >= 60 ? st.bars : null;

  const trend = useMemo(() => (bars ? analyzeTrend(bars) : null), [bars]);
  const models = useMemo(() => {
    if (!bars || bars.length < 150 || !picked) return null;
    const hmm = runHmmModel(bars, 4, 0.15, btCfg);
    const fac = runFactorModel(bars, extras[picked.code]?.fundFlow ?? null, null, { 估值: 0.25, 情绪: 0.25, 资金: 0.25, 技术: 0.25 }, 0.15, btCfg, Math.max(5, Math.round(bars.length / 100)));
    const vol = runVolModel(bars, 0.15, 1.2, btCfg);
    const ml = runMlModel(bars, 'mlp', 150, btCfg);
    return { hmm, fac, vol, ml };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bars, btCfg, picked]);

  const tech = useMemo(() => (bars ? analyzeTechnicals(bars) : null), [bars]);

  const maSeries = useMemo(() => {
    if (!bars) return null;
    const closes = bars.map((b) => b.close);
    return { ma5: sma(closes, 5), ma20: sma(closes, 20), ma60: sma(closes, 60), ma250: sma(closes, 250) };
  }, [bars]);

  const s = trend?.strategy;
  const bannerColor = s?.action === 'buy' ? 'var(--up)' : s?.action === 'wait' ? 'var(--amber)' : s?.action === 'reduce' ? 'var(--orange)' : 'var(--down)';
  const bannerBg = `color-mix(in srgb, ${bannerColor} 8%, var(--panel))`;

  const prof = picked ? extras[picked.code]?.profile ?? null : null;
  const profLoading = picked ? extras[picked.code]?.loading ?? false : false;
  // 东财快照按本币计价：A 股人民币、港股港币、美股美元——不标货币会误导
  const profCur = picked?.market === 'HK' ? 'HK$' : picked?.market === 'US' ? '$' : '';
  const profCurName = picked?.market === 'HK' ? '港币' : picked?.market === 'US' ? '美元' : '人民币';

  // 公告按标签筛选：用 tags.includes 而不是 primary，一条公告可能同时是「回购+注销」
  const annItems = annState.data?.items ?? [];
  const annMarket =
    picked?.market === 'HK' ? 'HK' : picked?.market === 'US' ? 'US' : picked?.market === 'JP' ? 'JP' : picked?.market === 'KR' ? 'KR' : 'CN';
  const annLabel =
    annMarket === 'US' ? 'SEC 申报' : annMarket === 'HK' ? '港交所公告' : annMarket === 'JP' ? '適時開示' : annMarket === 'KR' ? '新闻' : '公告';
  const annDesc =
    annMarket === 'US'
      ? '来自 SEC EDGAR：8-K 重大事件、10-Q/10-K 财报、Form 4 内部人交易、13D/13G 大额持股——监管申报是结构化枚举，不靠猜标题'
      : annMarket === 'HK'
        ? '来自东财港股公告库（繁体原文）：回购、减持、增持、供股、收购、业绩——已做繁简归一，方向比新闻标题明确'
        : annMarket === 'JP'
          ? '来自 TDnet 適時開示（日文原文）：自己株式取得、決算短信、公開買付、配当——日本披露用词固定，词表覆盖率高'
          : annMarket === 'KR'
            ? '来自 Naver 证券新闻（韩文原文）：这是媒体报道，不是公司公告，方向只作提示、不并入多空比'
            : '来自东财公告库，按重要性排序：回购、减持、增持、中标、获批、立案等公司行为——这类动作方向明确，比新闻标题可靠';
  const annShown = annTag ? annItems.filter((it) => it.tags.includes(annTag)) : annItems;

  // 消息面面板与行情解耦：行情拉不到时也能看公告
  const annPanel = picked ? (
  <Panel
    title={`个股消息面 · ${annLabel}${annItems.length ? ` 近 ${annItems.length} 条` : ''}`}
    icon="📰"
    desc={annDesc}
    extra={
      annState.data ? (
        <span className="inst-hint">
          利好 <b style={{ color: 'var(--up)' }}>{annState.data.bull}</b> / 利空{' '}
          <b style={{ color: 'var(--down)' }}>{annState.data.bear}</b> / 中性 {annState.data.neutral}
          {annState.data.routineBuyback > 0 && (
            <>
              {' '}
              · 例行购回 <b>{annState.data.routineBuyback}</b> 条
            </>
          )}
        </span>
      ) : undefined
    }
  >
    {annState.loading && <Loading text="正在拉取公告…" />}

    {!annState.loading && annState.error && (
      <div className="ann-empty">
        <span>📭 {annState.error}</span>
        {canFetchAnn(picked.code) && (
          <button
            type="button"
            className="gear-btn"
            onClick={() => {
              setAnnState({ loading: true, data: null, total: 0, error: null });
              ensureAnnouncements(picked.code, true)
                .then((r) => setAnnState({ loading: false, data: analyzeAnnouncements(r.list, r.name ?? picked.name), total: r.total, error: null, name: r.name }))
                .catch((e: unknown) =>
                  setAnnState({ loading: false, data: null, total: 0, error: e instanceof Error ? e.message : '公告获取失败' })
                );
            }}
          >
            🔄 重试
          </button>
        )}
      </div>
    )}

    {!annState.loading && annState.data && (
      <>
        <div className="news-brief">
          {annState.data.lines.map((l, i) => (
            <p key={i}>
              <span className="nb-dot" />
              {l}
            </p>
          ))}
        </div>

        <div className="ann-tags">
          <button type="button" className={`ann-chip${annTag === null ? ' on' : ''}`} onClick={() => setAnnTag(null)}>
            全部 {annItems.length}
          </button>
          {annState.data.counts.map(({ tag, count }) => {
            const m = ANN_TAG_META[tag];
            const on = annTag === tag;
            return (
              <button
                key={tag}
                type="button"
                className={`ann-chip t-${m.tone > 0 ? 'up' : m.tone < 0 ? 'down' : 'flat'}${on ? ' on' : ''}`}
                onClick={() => setAnnTag(on ? null : tag)}
                title={`${m.label}：${count} 条`}
              >
                <span className="ann-chip-ico">{m.icon}</span>
                {m.label} <b>{count}</b>
              </button>
            );
          })}
        </div>

        <div className="ann-list">
          {annShown.map((it) => {
            const m = ANN_TAG_META[it.primary];
            return (
              <div className={`ann-item${it.routine ? ' routine' : ''}`} key={it.id}>
                <span className="ann-date">{it.date ? it.date.slice(5) : '—'}</span>
                <span className={`ann-badge ${it.tone > 0 ? 'up' : it.tone < 0 ? 'down' : 'flat'}`}>
                  {m.icon} {m.label}
                </span>
                <span className="ann-title" title={`${it.clean}${it.reason ? `（命中：${it.reason}）` : ''}`}>
                  {it.clean.length > 76 ? `${it.clean.slice(0, 76)}…` : it.clean}
                </span>
                <span className="ann-score" title={`重要性 ${it.score}（标签权重 + 时效 + 金额/比例）`}>
                  {it.score}
                </span>
                {it.url ? (
                  <a className="ann-link" href={it.url} target="_blank" rel="noreferrer">
                    详情 ↗
                  </a>
                ) : (
                  <span className="ann-link" />
                )}
              </div>
            );
          })}
        </div>

        <div className="inst-hint">
          {annMarket === 'US'
            ? '标签由 SEC form 类型与 8-K items 映射（2.02 业绩、5.02 高管、1.01 重大协议…），完全结构化。Form 4 只说明「有内部人交易」，买卖方向要解析 XML，因此暂记中性、不并入多空比。'
            : annMarket === 'HK'
              ? '港股公告为繁体原文，已做繁简归一后再打标；标签由「标题关键词 + 公告分类」共同判定，一条最多取 2 个。'
              : annMarket === 'JP'
                ? '日股来自 Yahoo!ファイナンス 的適時開示页（TDnet 数据），日文原文 + TDnet 英文版标题都在词表里；只取标题，PDF 原文不下载。'
                : annMarket === 'KR'
                  ? '韩股没有免费公告源（DART 需 API key），这里抓的是 Naver 新闻。新闻≠公告：标题里的「자사주 매입」可能是记者解读，方向仅供提示，准确率低于公告。'
                  : '标签由「标题关键词 + 东财公告分类」共同判定，一条最多取 2 个（如「回购注销」同时命中回购与注销）。'}
          重要性 = 标签权重 + 时效（3 天内加分）+ 金额/比例，分数越高越该先看。
        </div>
      </>
    )}
  </Panel>
  ) : null;

  // 基本面与行情解耦：行情拉不到时也能看估值与财务
  const fundPanel = picked ? (
  <Panel
    title="💰 基本面速览"
    icon="💰"
    desc={`估值 + 盈利 + 成长，来自东财快照（金额单位：${profCurName}）。拿不到的字段显示「—」——各市场覆盖度不同，不做估算`}
  >
    {profLoading && !prof && <Loading text="正在拉取基本面…" />}
    {!profLoading && !prof && <EmptyTip text="该标的基本面数据不可用（东财未覆盖或接口限流）" />}
    {prof && (
      <>
        <div className="fund-sec">估值</div>
        <MetricGrid
          items={[
            { label: '市盈率 PE', value: fmtN(prof.pe, 1, ' 倍'), sub: prof.pe == null ? '东财未提供' : '动态口径' },
            { label: '市净率 PB', value: fmtN(prof.pb, 2, ' 倍') },
            { label: '总市值', value: fmtCap(prof.marketCap, profCur) },
            { label: '换手率', value: fmtN(prof.turnover, 2, '%') }
          ]}
        />
        <div className="fund-sec">盈利能力</div>
        <MetricGrid
          items={[
            { label: 'ROE', value: fmtN(prof.roe, 2, '%'), tone: toneOf(prof.roe, 15, 8), sub: '净资产收益率' },
            { label: '毛利率', value: fmtN(prof.grossMargin, 1, '%'), tone: toneOf(prof.grossMargin, 40, 15) },
            { label: '净利率', value: fmtN(prof.netMargin, 1, '%'), tone: toneOf(prof.netMargin, 15, 3) },
            {
              label: '资产负债率',
              value: fmtN(prof.debtRatio, 1, '%'),
              tone: toneOf(prof.debtRatio, 40, 70, false),
              sub: '越低越稳'
            }
          ]}
        />
        <div className="fund-sec">成长性</div>
        <MetricGrid
          items={[
            { label: '营业收入', value: fmtCap(prof.revenue, profCur) },
            { label: '营收同比', value: fmtN(prof.revenueYoY, 1, '%'), tone: toneOf(prof.revenueYoY, 20, 0) },
            { label: '净利润', value: fmtCap(prof.netProfit, profCur) },
            { label: '每股收益', value: fmtN(prof.eps, 2) }
          ]}
        />
        <div className="inst-hint">
          PE / PB 的绝对值没有统一标准（银行 5 倍不算便宜、科技 50 倍不算贵），必须跟同行业横向比；
          这里只给读数，不做「贵/便宜」的结论。港股与美股东财只提供部分字段，缺失项显示「—」。
        </div>
      </>
    )}
  </Panel>
  ) : null;


  return (
    <div>
      <div className="page-title-row">
        <h2>🔍 个股分析</h2>
        <span className="en">Stock Analysis</span>
        <button
          type="button"
          className="gear-btn"
          style={{ marginLeft: 10 }}
          onClick={() => {
            const c = picked?.code ?? codeParam;
            if (c) navigate('/momentum?code=' + encodeURIComponent(c));
          }}
        >
          🚀 动量择时
        </button>
      </div>
      <p className="page-lead">
        搜索<b>各市场个股</b>（A股 / 港股 / 美股 / 日股 / 韩股 / 台股），把<b>技术面</b>和<b>消息面</b>放在一起看：
        7 个大白话趋势信号 + 0–100 趋势评分 + <b>个股公告标签（回购 / 减持 / 中标 / 获批…）</b>
        + 明确的操作策略（买不买、什么价位买、买多少、什么时候卖）。
      </p>

      <div className="control-bar" style={{ alignItems: 'flex-start' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 280 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => hits.length > 0 && setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 200)}
            placeholder="输入股票名称或代码搜索，如：茅台 / 00700 / AAPL / 005930"
            style={{ width: '100%', border: '1px solid var(--border-strong)', borderRadius: 8, padding: '9px 12px', fontSize: 13.5, outline: 'none', background: 'var(--panel-2)', color: 'var(--text)' }}
          />
          {searching && <span style={{ position: 'absolute', right: 12, top: 10, fontSize: 12, color: 'var(--text-3)' }}>搜索中…</span>}
          {showDrop && hits.length > 0 && (
            <div className="search-pop">
              {hits.map((h) => (
                <div key={h.code} className="search-item" onMouseDown={() => pick(h)}>
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
            <button key={h.code} type="button" className="chip-toggle" onClick={() => pick(h)}>
              {h.name}
            </button>
          ))}
        </CtrlGroup>
      </div>

      {!picked && <EmptyTip text="搜索或点击上方热门标的，开始分析" />}
      {picked && st?.loading && <Loading text={`正在拉取 ${picked.name} 真实行情…`} />}
      {picked && st?.failed && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 实时行情暂不可达</div>
          <div className="panel-desc" style={{ color: 'inherit' }}>
            {picked.name}（{picked.marketLabel}）的实时行情获取失败，已尝试数据源：
            {st.attempts?.length ? st.attempts.join(' → ') : '全部可用源'}。
            本站<b>不会用模拟数据冒充真实行情</b>，请检查网络后重试。
          </div>
          <button type="button" className="gear-btn" style={{ marginTop: 10 }} onClick={() => { invalidateKline(picked.code); ensureKlines([picked.code], { allowDemo: false }); }}>
            🔄 重试
          </button>
        </div>
      )}
      {picked && st?.failed && (
        <>
          {fundPanel}
          {annPanel}
        </>
      )}
      {picked && !st?.loading && !st?.failed && !bars && (
        <>
          <EmptyTip text="行情数据不足（至少需要 60 个交易日），下方仍可查看基本面与消息面" />
          {fundPanel}
          {annPanel}
        </>
      )}

      {picked && bars && trend && s && (
        <>
          {/* ===== 股票头部 ===== */}
          <div className="panel" style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 18, fontWeight: 800 }}>{annState.name ?? picked.name}</span>
                <span className="badge info">{picked.marketLabel}</span>
                <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{picked.code}</span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4 }}>
                {trend.date} 收盘 · 回看 {bars.length} 日 · <SourcePill source={st!.source} cacheTs={st!.cacheTs} />
              </div>
            </div>
            <div style={{ fontSize: 26, fontWeight: 800 }} className="num">{trend.price.toFixed(2)}</div>
          </div>

          {/* ===== 🚦 大信号横幅（小白第一眼只看这里） ===== */}
          <div className="panel" style={{ borderWidth: 2, borderColor: bannerColor, background: bannerBg }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 38, fontWeight: 900, color: bannerColor, whiteSpace: 'nowrap' }}>
                {s.actionIcon} {s.actionLabel}
              </div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>信号强度 {STARS(s.stars)}</div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2 }}>
                  趋势评分 <b className="num">{trend.score}</b> / 100 · {trend.verdict} · ADX {trend.adx.toFixed(0)}（{trend.adxLevel}）
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 260, fontSize: 13.5, lineHeight: 1.8 }}>
                💡 <b>一句话操作：</b>{s.summary}
              </div>
            </div>
          </div>

          {/* ===== 🎯 操作策略卡 ===== */}
          <Panel title="🎯 操作策略（照着做就行）" desc="所有价位都由当前技术位自动计算，价格变动后会自动更新">
            <div className="grid-2">
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: s.action === 'buy' ? 'var(--up)' : s.action === 'wait' ? 'var(--amber)' : 'var(--down)' }}>
                  {s.action === 'buy' ? '✅ 买入计划' : s.action === 'wait' ? '🟡 观望计划' : s.action === 'reduce' ? '🟠 减持计划' : '🔴 卖出计划'}
                </div>
                <div className="tbl-wrap">
                  <table className="tbl">
                    <tbody>
                      <tr>
                        <td style={{ color: 'var(--text-3)', width: 118 }}>建议买入区间</td>
                        <td className="num" style={{ fontWeight: 700 }}>{s.entryZone[0]} ~ {s.entryZone[1]}</td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-3)' }}>建议仓位</td>
                        <td style={{ fontWeight: 700 }}>{s.positionPct}</td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-3)' }}>🛑 止损价（铁律）</td>
                        <td className="num" style={{ fontWeight: 700, color: 'var(--down)' }}>
                          {s.stopLoss.toFixed(2)}（{fmtPct(s.stopLoss / trend.price - 1, 1)}）
                        </td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-3)' }}>🎯 第一目标位</td>
                        <td className="num" style={{ fontWeight: 700, color: 'var(--up)' }}>
                          {s.targets[0].toFixed(2)}（{fmtPct(s.targets[0] / trend.price - 1, 1)}）
                        </td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-3)' }}>🎯 第二目标位</td>
                        <td className="num" style={{ fontWeight: 700, color: 'var(--up)' }}>
                          {s.targets[1].toFixed(2)}（{fmtPct(s.targets[1] / trend.price - 1, 1)}）
                        </td>
                      </tr>
                      <tr>
                        <td style={{ color: 'var(--text-3)' }}>⚖️ 盈亏比</td>
                        <td className="num" style={{ fontWeight: 700 }}>
                          {((s.targets[0] - trend.price) / Math.max(trend.price - s.stopLoss, 1e-9)).toFixed(1)} : 1
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--up)' }}>➕ 加仓 / 跟进触发（满足可加）</div>
                <ul style={{ margin: '0 0 14px', paddingLeft: 18, fontSize: 12.5, lineHeight: 2, color: 'var(--text-2)' }}>
                  {s.buyTriggers.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8, color: 'var(--down)' }}>➖ 卖出触发（出现任一条就执行）</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5, lineHeight: 2, color: 'var(--text-2)' }}>
                  {s.sellTriggers.map((t, i) => (
                    <li key={i}>{t}</li>
                  ))}
                </ul>
              </div>
            </div>
          </Panel>

          {/* ===== 📡 七大信号明细 ===== */}
          <Panel title="📡 七个趋势信号详解" desc="每个信号都用大白话解释：它是什么、现在是什么状态、对你意味着什么">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {trend.signals.map((sig) => (
                <div
                  key={sig.key}
                  style={{
                    border: '1px solid var(--border)',
                    borderLeft: `4px solid ${sig.status === 'bullish' ? 'var(--up)' : sig.status === 'bearish' ? 'var(--down)' : 'var(--gray)'}`,
                    borderRadius: 8,
                    padding: '12px 14px',
                    background: 'var(--panel-2)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 16 }}>{sig.icon}</span>
                    <b style={{ fontSize: 13.5 }}>{sig.name}</b>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: sig.status === 'bullish' ? 'var(--up)' : sig.status === 'bearish' ? 'var(--down)' : 'var(--text-3)', fontWeight: 700 }}>
                      {sig.status === 'bullish' ? '看多' : sig.status === 'bearish' ? '看空' : '中性'}
                      {sig.stars > 0 ? ` ${STARS(sig.stars)}` : ''}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 5 }}>{sig.statusText}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8 }}>{sig.plain}</div>
                </div>
              ))}
            </div>
          </Panel>

          {/* ===== 📊 技术面体检 ===== */}
          {tech && (
            <Panel
              title="📊 技术面体检"
              icon="📊"
              desc="七个常用指标的实时读数：MACD / RSI / KDJ / 布林带 / ATR / 量能 / OBV。注意：这里评的是「指标状态」，上面趋势法评的是「方向」，两者口径不同、分数不必一致"
              extra={
                <span className="inst-hint">
                  技术面评分{' '}
                  <b style={{ color: tech.score >= 55 ? 'var(--up)' : tech.score <= 45 ? 'var(--down)' : 'var(--text)' }}>{tech.score}</b>{' '}
                  / 100 · {tech.verdict}
                </span>
              }
            >
              <div className="tech-summary">{tech.summary}</div>
              <div className="tech-grid">
                {tech.rows.map((r) => (
                  <div className={`tech-card t-${r.tone}`} key={r.key}>
                    <div className="tc-head">
                      <b>{r.label}</b>
                      <span className={`tc-state ${r.tone}`}>{r.state}</span>
                    </div>
                    <div className="tc-value num">{r.value}</div>
                    <div className="tc-note">{r.note}</div>
                  </div>
                ))}
              </div>
            </Panel>
          )}

          {fundPanel}

          {annPanel}

          {/* ===== 图表 ===== */}
          <div className="grid-2">
            <Panel title="价格趋势图（MA5/20/60/250）" icon="📈" desc="价格在均线上方=强势，下方=弱势；短期均线在长期均线上方=上升趋势">
              <EChart
                option={lineOption(
                  bars.map((b) => b.date),
                  [
                    { name: '收盘价', data: bars.map((b) => b.close), color: C.accent, lineWidth: 2 },
                    { name: 'MA5', data: maSeries!.ma5.map((v) => (Number.isNaN(v) ? null : v)), color: C.orange },
                    { name: 'MA20', data: maSeries!.ma20.map((v) => (Number.isNaN(v) ? null : v)), color: C.cyan },
                    { name: 'MA60', data: maSeries!.ma60.map((v) => (Number.isNaN(v) ? null : v)), color: C.purple },
                    { name: 'MA250', data: maSeries!.ma250.map((v) => (Number.isNaN(v) ? null : v)), color: C.gray, dashed: true }
                  ]
                )}
                height={330}
              />
            </Panel>
            <Panel title="趋势评分仪表盘" icon="🎚" desc="0 = 极度看空，100 = 极度看多；50 附近 = 震荡">
              <EChart option={gaugeOption((trend.score - 50) / 50, '趋势评分')} height={240} />
              <MetricGrid
                items={[
                  { label: '趋势评分', value: String(trend.score), tone: trend.score >= 58 ? 'up' : trend.score <= 42 ? 'down' : 'flat' },
                  { label: '均线排列', value: trend.maAlignment },
                  { label: '金叉死叉', value: trend.cross === '无' ? '无' : `${trend.cross}（${trend.crossDaysAgo}日前）` },
                  { label: '通道位置', value: `${(trend.donchianPos * 100).toFixed(0)}% · ${trend.breakout}` },
                  { label: '52 周位置', value: fmtPct(trend.pos52, 0) },
                  { label: '支撑 / 阻力', value: `${trend.support.toFixed(2)} / ${trend.resistance.toFixed(2)}` }
                ]}
              />
            </Panel>
          </div>

          {/* ===== 模型辅助 ===== */}
          {models && (
            <Panel title="🤖 其他模型怎么看这只股票" desc="技术面之外，站内四大模型对同一标的的独立判断（互相印证更可靠）">
              <MetricGrid
                items={[
                  {
                    label: 'HMM 市场状态',
                    value: models.hmm.output.labels[models.hmm.currentProbs.indexOf(Math.max(...models.hmm.currentProbs))],
                    sub: `观点 ${models.hmm.positions[models.hmm.positions.length - 1].toFixed(2)}`
                  },
                  { label: '因子信号', value: `${models.fac.signal > 0 ? '+' : ''}${models.fac.signal.toFixed(2)}`, sub: `${models.fac.report.values.length} 因子` },
                  { label: 'GARCH 预测波动', value: fmtPct(models.vol.garch.forecast, 1), sub: `regime：${models.vol.regime === 'high' ? '上行' : models.vol.regime === 'low' ? '回落' : '中性'}` },
                  {
                    label: 'MLP 明日方向',
                    value: fmtPct(models.ml.lastProba, 1),
                    sub: models.ml.auc >= 0.5 ? `AUC ${models.ml.auc.toFixed(2)}` : 'AUC<0.5 仅供参考'
                  }
                ]}
              />
            </Panel>
          )}

          {/* ===== 新手学堂 ===== */}
          <Panel title="🎓 新手学堂：3 分钟看懂趋势法">
            <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
              <p style={{ marginTop: 0 }}>
                <b style={{ color: 'var(--text)' }}>什么是趋势法？</b>
                一句话：<b>“跟着大势走，不猜底不猜顶”</b>。价格上涨且趋势确立时买入，趋势走坏时卖出，不做逆势抄底。
                历史数据表明：趋势一旦形成，延续的概率大于反转——这就是趋势策略的底层逻辑。
              </p>
              <p>
                <b style={{ color: 'var(--text)' }}>几个必懂名词：</b>
              </p>
              <ul>
                <li><b>均线（MA）</b>：过去 N 天的平均价格连线。价格在均线上方 = 强势；短期均线在长期均线上方 = 上升趋势。</li>
                <li><b>金叉</b>：短期均线上穿长期均线 → 经典<b>买入</b>信号。<b>死叉</b>：短期均线下穿长期均线 → 经典<b>卖出</b>信号。</li>
                <li><b>止损</b>：买入前就设定好的“认赔价”，到了必须卖——<b>保护本金的铁律，没有任何例外</b>。</li>
                <li><b>仓位</b>：投入这只股票的钱占总资金的比例。再好的信号也不要满仓一只股票。</li>
                <li><b>盈亏比</b>：目标位涨幅 ÷ 止损位跌幅。大于 2:1 才值得做，否则赚的不够赔。</li>
              </ul>
              <p style={{ marginBottom: 0 }}>
                <b style={{ color: 'var(--text)' }}>给新手的 3 条忠告：</b>
                ① 先模拟练习至少 1 个月再上实盘；② 单只股票仓位不超过总资金的 20–30%；
                ③ 如果多个信号矛盾（比如价格站上均线但 ADX 显示无趋势），<b>选择观望永远不会错</b>。
              </p>
            </div>
            <MathPanel>
              <pre>{`七信号 → 评分 → 策略 完整规则:

1. 均线排列(权重0.30):  MA5>MA10>MA20>MA60 成立 3 项=多头排列
2. 回归趋势(权重0.25):  60 日直线拟合，斜率×R²，斜率>0.03%/日=上升
3. ADX 强度(权重0.20):  >25 强趋势(方向由回归定)，18-25 弱，<18 无趋势
4. 通道位置(权重0.15):  价格在 20 日高低点通道中的位置，破上轨=强势
5. 量价配合(权重0.10):  价量相关系数>0.2=量价齐升(健康)

评分 = 50 + 50×加权和 ∈ [0,100]

策略映射:  ≥70 买入(强) | 58-70 买入 | 45-58 观望 | 30-45 减持 | <30 卖出

关键位:
  支撑 = max(20日低点, min(MA60, 低点×1.02))
  阻力 = min(20日高点, max(MA60, 高点×0.98))
  止损 = max(52周低点, min(支撑, 现价×0.92))
  目标 = min(52周高点, max(阻力, 现价×1.12))`}</pre>
            </MathPanel>
          </Panel>

          <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页趋势、技术面、基本面指标交给 AI 解读，只读不改任何设置">
            <AiAnalyze
              module="个股分析 · 趋势 / 技术面 / 基本面"
              symbol={picked?.name}
              note="趋势评分与技术面评分口径不同（前者评方向、后者评指标状态），分数不必一致。"
              facts={[
                { label: '现价', value: trend.price.toFixed(2) },
                { label: '趋势评分 / 判定', value: trend.score.toFixed(0) + ' / ' + trend.verdict },
                { label: '策略建议', value: s.actionLabel + '（' + s.stars + ' 星）' },
                { label: '均线排列 / ADX', value: trend.maAlignment + ' / ' + trend.adx.toFixed(1) + '（' + trend.adxLevel + '）' },
                { label: '通道位置 / 52周位置', value: (trend.donchianPos * 100).toFixed(0) + '% / ' + (trend.pos52 * 100).toFixed(0) + '%' },
                { label: '支撑 / 阻力 / 止损', value: trend.support.toFixed(2) + ' / ' + trend.resistance.toFixed(2) + ' / ' + s.stopLoss.toFixed(2) },
                ...(tech ? [
                  { label: '技术面评分 / 判定', value: tech.score.toFixed(0) + ' / ' + tech.verdict },
                  ...tech.rows.map((r) => ({ label: '技术·' + r.label, value: r.value + '（' + r.state + '）' }))
                ] : []),
                ...(prof ? [
                  { label: 'PE / PB', value: (prof.pe == null ? '—' : prof.pe.toFixed(1)) + ' / ' + (prof.pb == null ? '—' : prof.pb.toFixed(1)) },
                  { label: 'ROE / 毛利率', value: (prof.roe == null ? '—' : prof.roe.toFixed(1) + '%') + ' / ' + (prof.grossMargin == null ? '—' : prof.grossMargin.toFixed(1) + '%') },
                  { label: '营收同比', value: prof.revenueYoY == null ? '—' : prof.revenueYoY.toFixed(1) + '%' }
                ] : [])
              ]}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
