import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import EChart from '../components/EChart';
import { C, lineOption } from '../components/chartOptions';
import { CtrlGroup, EmptyTip, Loading, MetricGrid, Panel } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { useApp } from '../hooks/AppContext';
import { searchStocks, type StockHit } from '../data/search';
import { getSymbol, MARKET_LABEL, type Market } from '../data/symbols';
import { loadRecent, loadWatchlist } from '../data/watchlist';
import { marketRuleOf } from '../data/marketRules';
import { DEFAULT_SWING_CONFIG, analyzeSwing, type SwingConfig } from '../math/swing';
import { DEFAULT_PANIC_CONFIG, analyzePanic, type PanicConfig } from '../math/panic';
import { DEFAULT_BOTTOMING_CONFIG, detectBottoming, type BottomingConfig } from '../math/bottoming';

type Tab = 'swing' | 'panic' | 'bottoming';

const HOT: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', secid: '1.600519' },
  { code: 'hk00700', name: '腾讯控股', market: 'HK', marketLabel: '港股' },
  { code: 'usAAPL', name: '苹果', market: 'US', marketLabel: '美股' },
  { code: 'usNVDA', name: '英伟达', market: 'US', marketLabel: '美股' },
  { code: 'jp7203', name: '丰田汽车', market: 'JP', marketLabel: '日股' },
  { code: 'kr005930', name: '三星电子', market: 'KR', marketLabel: '韩股' }
];

const num = (v: string, fallback: number): number => {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? x : fallback;
};

export default function SwingPage() {
  const { klines, ensureKlines, registerStock } = useApp();
  const params = useParams();
  const loc = useLocation();
  const codeParam = (() => {
    const s = (loc.search || '').replace(/^\?/, '');
    for (const part of s.split('&')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i) === 'code') return decodeURIComponent(part.slice(i + 1));
    }
    return params.code || '';
  })();

  const [tab, setTab] = useState<Tab>('swing');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDrop, setShowDrop] = useState(false);
  const [picked, setPicked] = useState<StockHit | null>(null);
  const [swingCfg, setSwingCfg] = useState<SwingConfig>(DEFAULT_SWING_CONFIG);
  const [panicCfg, setPanicCfg] = useState<PanicConfig>(DEFAULT_PANIC_CONFIG);
  const [bottomingCfg, setBottomingCfg] = useState<BottomingConfig>(DEFAULT_BOTTOMING_CONFIG);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  const skipSearch = useRef(false);

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (skipSearch.current) {
      skipSearch.current = false;
      setHits([]);
      setShowDrop(false);
      return;
    }
    if (!query.trim()) {
      setHits([]);
      return;
    }
    setSearching(true);
    debounce.current = setTimeout(async () => {
      const r = await searchStocks(query, 12);
      const groups = new Map<string, StockHit[]>();
      const order: string[] = [];
      for (const h of r) {
        if (!groups.has(h.name)) {
          groups.set(h.name, []);
          order.push(h.name);
        }
        groups.get(h.name)!.push(h);
      }
      // 同名时把美股 ADR 排后（同估值页的处理）
      setHits(
        order.flatMap((name) => {
          const arr = groups.get(name)!;
          return [...arr.filter((x) => !/^us/i.test(x.code)), ...arr.filter((x) => /^us/i.test(x.code))];
        })
      );
      setSearching(false);
      setShowDrop(true);
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [query]);

  const pick = (hit: StockHit) => {
    registerStock(hit);
    setPicked(hit);
    skipSearch.current = true;
    setQuery(hit.name);
    setHits([]);
    setShowDrop(false);
  };

  useEffect(() => {
    if (!codeParam || picked?.code === codeParam) return;
    const sym = getSymbol(codeParam);
    if (sym) {
      pick({ code: sym.code, name: sym.name, market: sym.market, marketLabel: MARKET_LABEL[sym.market], secid: sym.secid || undefined });
      return;
    }
    const stored = loadWatchlist().find((i) => i.code === codeParam) ?? loadRecent().find((i) => i.code === codeParam);
    if (stored) {
      pick(stored);
      return;
    }
    const prefix = codeParam.slice(0, 2).toLowerCase();
    const market: Market =
      prefix === 'hk' ? 'HK' : prefix === 'us' ? 'US' : prefix === 'jp' ? 'JP' : prefix === 'kr' ? 'KR' : 'CN';
    pick({ code: codeParam, name: codeParam, market, marketLabel: MARKET_LABEL[market] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeParam, picked]);

  useEffect(() => {
    if (picked) ensureKlines([picked.code], { allowDemo: false });
  }, [picked, ensureKlines]);

  const st = picked ? klines[picked.code] : undefined;
  const bars = st && !st.loading && !st.failed && st.bars.length >= 80 ? st.bars : null;
  const rule = picked ? marketRuleOf(picked.code) : null;
  const lot = rule?.lotSize ?? 100;
  const cur = rule?.currency ?? '元';

  // A 股 T+1：抄底只能次日买，历史统计也要按次日买入算
  const entryDelay = rule?.settlement === 'T+1' ? 1 : 0;

  const swing = useMemo(
    () => (tab === 'swing' && bars ? analyzeSwing(bars, swingCfg, lot) : null),
    [tab, bars, swingCfg, lot]
  );
  const panic = useMemo(
    () => (tab === 'panic' && bars ? analyzePanic(bars, { ...panicCfg, entryDelay }, lot) : null),
    [tab, bars, panicCfg, entryDelay, lot]
  );
  const bottoming = useMemo(
    () => (tab === 'bottoming' && bars && bars.length >= 120 ? detectBottoming(bars, bottomingCfg, lot) : null),
    [tab, bars, bottomingCfg, lot]
  );

  const chart = useMemo(() => {
    if (!bars || (!swing && !panic && !bottoming)) return null;
    const n = Math.min(120, bars.length);
    const seg = bars.slice(-n);
    const labels = seg.map((b) => b.date.slice(5));
    const series: { name: string; data: (number | null)[]; color: string; lineWidth: number }[] = [
      { name: '收盘', data: seg.map((b) => b.close), color: C.accent, lineWidth: 2 }
    ];
    if ((tab === 'swing' && swing) || (tab === 'bottoming' && bottoming)) {
      const src = tab === 'swing' ? swing!.ma20 : bottoming!.ma20;
      const src60 = tab === 'swing' ? swing!.ma60 : bottoming!.ma60;
      series.push({ name: 'MA20', data: src.slice(-n), color: C.orange, lineWidth: 1.4 });
      series.push({ name: 'MA60', data: src60.slice(-n), color: C.purple, lineWidth: 1.4 });
    }
    const opt = lineOption(labels, series, { yName: cur });
    const first = (opt.series as unknown as { markLine?: unknown; markArea?: unknown }[])[0];
    const setScale = () => {
      // 不写死 min/max：ECharts 在绝对范围下会算出 1e9 这种鬼刻度。
      // scale 让它按数据自动缩放，目标价超出范围时线不显示（计划卡片里仍有数字）。
      const yAxis = opt.yAxis as unknown as { scale?: boolean } | { scale?: boolean }[];
      if (yAxis && !Array.isArray(yAxis)) yAxis.scale = true;
    };

    if (tab === 'bottoming' && bottoming) {
      const p = bottoming.plan;
      const list = [
        { name: '颈线', yAxis: bottoming.neck, color: C.orange },
        { name: '底部低点', yAxis: bottoming.baseLow, color: C.purple },
        ...(p ? [{ name: '止损', yAxis: p.stop, color: C.down }] : [])
      ];
      first.markLine = {
        symbol: 'none',
        silent: true,
        label: { formatter: '{b}', fontSize: 10, color: C.text, position: 'middle' },
        data: list.map((x) => ({ name: x.name, yAxis: x.yAxis, lineStyle: { color: x.color, type: 'dashed', width: 1 } }))
      };
      // 背景带按结构位切分：主升高点 → 下跌段 → 降波筑底段（示意，不是逐根聚类）
      const off = bars.length - n;
      const at = (k: number) => labels[Math.min(n - 1, Math.max(0, k))];
      const hi = Math.max(0, bottoming.highIndex - off);
      const bs = Math.max(hi, bottoming.baseStart - off);
      const areas: { name: string; from: number; to: number; color: string }[] = [
        { name: '下跌段', from: hi, to: bs, color: C.down },
        { name: '降波筑底', from: bs, to: n - 1, color: C.amber }
      ];
      first.markArea = {
        silent: true,
        label: { fontSize: 10, color: C.text, position: 'insideTop' },
        data: areas
          .filter((a) => a.to > a.from)
          .map((a) => [
            { name: a.name, xAxis: at(a.from), itemStyle: { color: a.color, opacity: 0.07 } },
            { xAxis: at(a.to) }
          ])
      };
      setScale();
      return opt;
    }

    const levels = tab === 'swing' ? swing?.levels : panic?.plan;
    if (levels) {
      const list =
        tab === 'swing'
          ? [
              { name: '入场', yAxis: (levels as NonNullable<typeof swing>['levels'])!.entryHigh, color: C.accent },
              { name: '止损', yAxis: (levels as NonNullable<typeof swing>['levels'])!.stop, color: C.down },
              { name: '目标', yAxis: (levels as NonNullable<typeof swing>['levels'])!.target, color: C.up }
            ]
          : [
              { name: '止损', yAxis: panic!.plan!.stop, color: C.down },
              { name: '目标', yAxis: panic!.plan!.target1, color: C.up }
            ];
      first.markLine = {
        symbol: 'none',
        silent: true,
        label: { formatter: '{b}', fontSize: 10, color: C.text, position: 'middle' },
        data: list.map((x) => ({ name: x.name, yAxis: x.yAxis, lineStyle: { color: x.color, type: 'dashed', width: 1 } }))
      };
      setScale();
    }
    return opt;
  }, [bars, tab, swing, panic, bottoming, cur]);

  const swingColor =
    swing?.verdict === '可做多'
      ? 'var(--up)'
      : swing?.verdict === '等回踩'
        ? 'var(--amber)'
        : swing?.verdict === '不做'
          ? 'var(--down)'
          : 'var(--text-3)';

  const panicColor =
    panic?.triggered ? 'var(--up)' : panic && panic.score >= 40 ? 'var(--amber)' : 'var(--text-3)';

  const bottomingColor =
    bottoming?.signal === '筑底确认·买入'
      ? 'var(--up)'
      : bottoming?.signal === '筑底中·小仓试探'
        ? 'var(--amber)'
        : bottoming?.signal === '筑底失败·离场'
          ? 'var(--down)'
          : 'var(--text-3)';

  const bp = bottoming ? bottoming.plan : null;

  return (
    <div>
      <div className="page-title-row">
        <h2>📈 波段 · 抄底 · 筑底</h2>
        <span className="en">Swing · Panic · Base Building</span>
      </div>
      <p className="page-lead">
        <b>波段</b>：看趋势与位置，给「回踩买 / 突破买」的入场、止损、目标与仓位，持有 3~20 个交易日。
        <b>抄底</b>：先给恐慌程度打分，再用这只股票<b>自己的历史</b>回答「同样跌幅后 1/3/5 天涨跌概率」。
        <b>降波筑底</b>：识别「大涨 → 逐级下跌 → 波动与量能收敛 → 低点抬高 → 放量突破」这段中期底部构造，给筑底信号与<b>小仓试探 / 破底即走</b>计划。
        覆盖 <b>A 股 / 港股 / 美股 / 日股 / 韩股</b>，按各市场 T+1、涨跌停、每手股数给可执行的计划。
      </p>

      <div className="control-bar" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 260 }}>
          <input
            value={query}
            onChange={(e) => {
              skipSearch.current = false;
              setQuery(e.target.value);
            }}
            onFocus={() => hits.length > 0 && setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 200)}
            placeholder="输入名称或代码（A股 / 港股 / 美股 / 日股 / 韩股），如：茅台 / 00700 / AAPL / 7203"
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

      <div className="panel" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
          <CtrlGroup label="模式">
            {(['swing', 'panic', 'bottoming'] as Tab[]).map((t) => (
              <button key={t} type="button" className={`chip-toggle${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
                {t === 'swing' ? '波段（3~20 日）' : t === 'panic' ? '恐慌抄底（1~5 日）' : '降波筑底（中期）'}
              </button>
            ))}
          </CtrlGroup>

          {tab === 'swing' ? (
            <>
              <label className="t0-field">
                本金
                <input type="number" value={swingCfg.capital} onChange={(e) => setSwingCfg((c) => ({ ...c, capital: num(e.target.value, c.capital) }))} />
              </label>
              <label className="t0-field">
                单笔风险 %
                <input type="number" step="0.1" value={swingCfg.riskPct} onChange={(e) => setSwingCfg((c) => ({ ...c, riskPct: num(e.target.value, c.riskPct) }))} />
              </label>
              <label className="t0-field">
                止损 ATR 倍
                <input type="number" step="0.1" value={swingCfg.atrStop} onChange={(e) => setSwingCfg((c) => ({ ...c, atrStop: num(e.target.value, c.atrStop) }))} />
              </label>
              <label className="t0-field">
                最长持有
                <input type="number" value={swingCfg.maxHoldDays} onChange={(e) => setSwingCfg((c) => ({ ...c, maxHoldDays: num(e.target.value, c.maxHoldDays) }))} />
              </label>
            </>
          ) : tab === 'panic' ? (
            <>
              <label className="t0-field">
                跌幅门槛 %
                <input type="number" step="0.5" value={panicCfg.dropPct} onChange={(e) => setPanicCfg((c) => ({ ...c, dropPct: num(e.target.value, c.dropPct) }))} />
              </label>
              <label className="t0-field">
                放量倍数
                <input type="number" step="0.1" value={panicCfg.volumeRatio} onChange={(e) => setPanicCfg((c) => ({ ...c, volumeRatio: num(e.target.value, c.volumeRatio) }))} />
              </label>
              <label className="t0-field">
                本金
                <input type="number" value={panicCfg.capital} onChange={(e) => setPanicCfg((c) => ({ ...c, capital: num(e.target.value, c.capital) }))} />
              </label>
              <label className="t0-field">
                单笔风险 %
                <input type="number" step="0.1" value={panicCfg.riskPct} onChange={(e) => setPanicCfg((c) => ({ ...c, riskPct: num(e.target.value, c.riskPct) }))} />
              </label>
            </>
          ) : (
            <>
              <label className="t0-field">
                本金
                <input type="number" value={bottomingCfg.capital} onChange={(e) => setBottomingCfg((c) => ({ ...c, capital: num(e.target.value, c.capital) }))} />
              </label>
              <label className="t0-field">
                试探仓 %
                <input
                  type="number" step="1" min="1" max="50"
                  value={Math.round(bottomingCfg.probePct * 100)}
                  onChange={(e) => setBottomingCfg((c) => ({ ...c, probePct: Math.min(0.5, num(e.target.value, c.probePct * 100) / 100) }))}
                />
              </label>
              <label className="t0-field">
                确认后总仓 %
                <input
                  type="number" step="1" min="1" max="100"
                  value={Math.round(bottomingCfg.confirmPct * 100)}
                  onChange={(e) => setBottomingCfg((c) => ({ ...c, confirmPct: Math.min(1, num(e.target.value, c.confirmPct * 100) / 100) }))}
                />
              </label>
              <label className="t0-field">
                突破量比
                <input
                  type="number" step="0.1" min="1"
                  value={bottomingCfg.breakoutVol}
                  onChange={(e) => setBottomingCfg((c) => ({ ...c, breakoutVol: num(e.target.value, c.breakoutVol) }))}
                />
              </label>
            </>
          )}

          {rule && (
            <span className="inst-hint" style={{ flexBasis: '100%' }}>
              交易制度：<b>{rule.label}</b> · {rule.settlement} · {rule.priceLimit} · 每手 {rule.lotSize} 股。{rule.note}
            </span>
          )}
        </div>
      </div>

      {!picked && <EmptyTip text="搜索或点击上方热门标的，开始波段 / 抄底分析" />}
      {picked && st?.loading && <Loading text={`正在拉取 ${picked.name} 日 K…`} />}
      {picked && st?.failed && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 暂不可达</div>
          <div className="panel-desc">没有历史 K 线就算不出趋势与恐慌评分。本站不用模拟数据冒充真实行情。</div>
        </div>
      )}
      {picked && !st?.loading && !st?.failed && !bars && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 不足 80 根</div>
          <div className="panel-desc">波段至少需要 80 根日 K（MA60 + 20 日结构位），请把顶部回看周期调大后重试。</div>
        </div>
      )}
      {tab === 'bottoming' && picked && bars && bars.length < 120 && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 不足 120 根</div>
          <div className="panel-desc">
            降波筑底要同时看到主升段（60 日）、下跌段与筑底窗口，至少 120 根日 K，建议把顶部回看周期调到 250 日以上。当前 {bars.length} 根。
          </div>
        </div>
      )}

      {/* ===== 波段 ===== */}
      {tab === 'swing' && swing && (
        <>
          <div className="panel" style={{ borderWidth: 2, borderColor: swingColor, background: `color-mix(in srgb, ${swingColor} 8%, var(--panel))` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 30, fontWeight: 900, color: swingColor, whiteSpace: 'nowrap' }}>{swing.verdict}</div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  {swing.setup} · {swing.score}<span style={{ fontSize: 13, color: 'var(--text-3)' }}> / 100</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>
                  收盘 {swing.close.toFixed(2)} {cur} · ATR 占价 {swing.atrPct.toFixed(2)}% · 量比 {swing.volRatio.toFixed(2)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 240, fontSize: 13, color: 'var(--text-2)' }}>{swing.note}</div>
            </div>
          </div>

          {swing.plan && (
            <Panel title="交易计划" icon="🎯" desc={`${swing.setup}：入场、止损、目标都按 ATR 与结构位算，不拍百分比`}>
              <div className="plan-grid">
                <div className="plan-cell">
                  <span>入场区间</span>
                  <b>{swing.plan.entryLow.toFixed(2)} ~ {swing.plan.entryHigh.toFixed(2)}</b>
                  <small>
                    {cur} ·{' '}
                    {swing.setup === '箱体突破' ? '突破回踩' : swing.setup === '突破延伸' ? '回踩 MA20' : '回踩均线'}
                  </small>
                </div>
                <div className="plan-cell">
                  <span>止损</span>
                  <b style={{ color: 'var(--down)' }}>{swing.plan.stop.toFixed(2)}</b>
                  <small>{(((swing.plan.stop - swing.plan.entryHigh) / swing.plan.entryHigh) * 100).toFixed(2)}% · {swingCfg.atrStop} ATR</small>
                </div>
                <div className="plan-cell">
                  <span>目标 1</span>
                  <b style={{ color: 'var(--up)' }}>{swing.plan.target1.toFixed(2)}</b>
                  <small>风险回报 {swing.plan.rr.toFixed(1)}</small>
                </div>
                <div className="plan-cell">
                  <span>目标 2</span>
                  <b>{swing.plan.target2 != null ? swing.plan.target2.toFixed(2) : '—'}</b>
                  <small>{swing.setup === '箱体突破' ? '箱体高度' : swing.setup === '突破延伸' ? 'ATR 外推' : '前高'}</small>
                </div>
                <div className="plan-cell">
                  <span>建议仓位</span>
                  <b>{swing.plan.shares > 0 ? `${swing.plan.shares} 股` : '不足一手'}</b>
                  <small>风险预算 {swing.plan.riskAmount.toFixed(0)} {cur}</small>
                </div>
                <div className="plan-cell">
                  <span>持有周期</span>
                  <b>{swing.plan.holdLow}~{swing.plan.holdHigh} 日</b>
                  <small>跌破止损先走，不摊平</small>
                </div>
              </div>
            </Panel>
          )}

          <Panel title="📋 判定依据" icon="📋" desc="形态、评分、计划都写清楚，不做黑箱">
            <div className="news-brief">
              {swing.lines.map((l, i) => (
                <p key={i}><span className="nb-dot" />{l}</p>
              ))}
            </div>
            <MetricGrid items={swing.facts.map((f) => ({ label: f.label, value: f.value, tone: f.tone }))} />
          </Panel>

          {chart && (
            <Panel title="📈 价格与均线" icon="📈" desc="最近 120 个交易日；虚线为入场 / 止损 / 目标">
              <EChart option={chart} height={340} />
            </Panel>
          )}
        </>
      )}

      {/* ===== 抄底 ===== */}
      {tab === 'panic' && panic && (
        <>
          <div className="panel" style={{ borderWidth: 2, borderColor: panicColor, background: `color-mix(in srgb, ${panicColor} 8%, var(--panel))` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 30, fontWeight: 900, color: panicColor, whiteSpace: 'nowrap' }}>
                {panic.triggered ? '触发抄底' : '不触发'}
              </div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  {panic.level} · {panic.score}<span style={{ fontSize: 13, color: 'var(--text-3)' }}> / 100</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>
                  今日 {panic.drop > 0 ? `-${panic.drop.toFixed(2)}%` : '0.00%'} · 量比 {panic.volRatio.toFixed(2)} · RSI {panic.rsi.toFixed(1)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 240, fontSize: 13, color: 'var(--text-2)' }}>
                {panic.triggered
                  ? '跌幅与恐慌评分都达标。下面先看历史同类样本的胜率，再看计划。'
                  : panic.drop < panicCfg.dropPct
                    ? `今日跌幅没到 ${panicCfg.dropPct}% 的门槛。`
                    : '跌幅到了，但放量/超卖/偏离度不足，不算恐慌性大跌。'}
              </div>
            </div>
          </div>

          <Panel title="📊 历史同类恐慌日" icon="📊" desc={`过去 ${bars?.length ?? 0} 根 K 线里，单日跌幅 ≥ ${panicCfg.dropPct}% 的日子，后续 1/3/5 日收益分布`}>
            {panic.stats.every((s) => s.samples === 0) ? (
              <EmptyTip text="这段 K 线里没有同类样本，无法给出胜率" />
            ) : (
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>持有</th><th>样本数</th><th>上涨概率</th><th>平均收益</th><th>中位数</th><th>最差</th><th>最好</th>
                    </tr>
                  </thead>
                  <tbody>
                    {panic.stats.map((s) => (
                      <tr key={s.horizon}>
                        <td>{s.horizon} 日</td>
                        <td className="num">{s.samples}</td>
                        <td className="num" style={{ color: s.winRate >= 50 ? 'var(--up)' : 'var(--down)' }}>{s.samples ? `${s.winRate.toFixed(0)}%` : '—'}</td>
                        <td className="num" style={{ color: s.avg >= 0 ? 'var(--up)' : 'var(--down)' }}>{s.samples ? `${s.avg >= 0 ? '+' : ''}${s.avg.toFixed(2)}%` : '—'}</td>
                        <td className="num">{s.samples ? `${s.median >= 0 ? '+' : ''}${s.median.toFixed(2)}%` : '—'}</td>
                        <td className="num" style={{ color: 'var(--down)' }}>{s.samples ? `${s.worst.toFixed(2)}%` : '—'}</td>
                        <td className="num" style={{ color: 'var(--up)' }}>{s.samples ? `${s.best >= 0 ? '+' : ''}${s.best.toFixed(2)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="inst-hint">
              统计口径：{entryDelay ? 'A 股 T+1，按信号次日收盘买入' : 'T+0 市场，按信号当日收盘买入'}；
              只统计跌幅，不要求放量，否则样本太少。
            </div>
          </Panel>

          {panic.plan && (
            <Panel title="交易计划" icon="🎯" desc="抄底是短线：止损放在今日低点下方，目标先看 5 日线与跌幅回补">
              <div className="plan-grid">
                <div className="plan-cell">
                  <span>入场区间</span>
                  <b>{panic.plan.entryLow.toFixed(2)} ~ {panic.plan.entryHigh.toFixed(2)}</b>
                  <small>{panic.plan.entryDelay ? '次日开盘' : '当日收盘'} · {cur}</small>
                </div>
                <div className="plan-cell">
                  <span>止损</span>
                  <b style={{ color: 'var(--down)' }}>{panic.plan.stop.toFixed(2)}</b>
                  <small>今日低点 − 0.8 ATR</small>
                </div>
                <div className="plan-cell">
                  <span>目标 1</span>
                  <b style={{ color: 'var(--up)' }}>{panic.plan.target1.toFixed(2)}</b>
                  <small>5 日线 / 回补一半跌幅</small>
                </div>
                <div className="plan-cell">
                  <span>目标 2</span>
                  <b>{panic.plan.target2 != null ? panic.plan.target2.toFixed(2) : '—'}</b>
                  <small>{panic.plan.target2 != null ? '完全回补' : '与目标 1 重合'}</small>
                </div>
                <div className="plan-cell">
                  <span>建议仓位</span>
                  <b>{panic.plan.shares > 0 ? `${panic.plan.shares} 股` : '不足一手'}</b>
                  <small>风险预算 {panic.plan.riskAmount.toFixed(0)} {cur}</small>
                </div>
                <div className="plan-cell">
                  <span>持有周期</span>
                  <b>{panic.plan.holdLow}~{panic.plan.holdHigh} 日</b>
                  <small>不涨就撤，不把短线做成套牢</small>
                </div>
              </div>
            </Panel>
          )}

          <Panel title="📋 判定依据" icon="📋" desc="恐慌评分由跌幅、放量、超卖、偏离度、下影线共同决定">
            <div className="news-brief">
              {panic.lines.map((l, i) => (
                <p key={i}><span className="nb-dot" />{l}</p>
              ))}
            </div>
            <MetricGrid items={panic.facts.map((f) => ({ label: f.label, value: f.value, tone: f.tone }))} />
          </Panel>

          {chart && (
            <Panel title="📈 价格与关键位" icon="📈" desc="最近 120 个交易日；虚线为止损 / 目标">
              <EChart option={chart} height={340} />
            </Panel>
          )}
        </>
      )}

      {/* ===== 降波筑底 ===== */}
      {tab === 'bottoming' && bottoming && (
        <>
          <div className="panel" style={{ borderWidth: 2, borderColor: bottomingColor, background: `color-mix(in srgb, ${bottomingColor} 8%, var(--panel))` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 27, fontWeight: 900, color: bottomingColor, whiteSpace: 'nowrap' }}>{bottoming.signal}</div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  筑底评分 {bottoming.score}<span style={{ fontSize: 13, color: 'var(--text-3)' }}> / 100</span>
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>
                  收盘 {bottoming.close.toFixed(2)} {cur} · 波动压缩 {(bottoming.compress * 100).toFixed(0)}% · 量能压缩 {(bottoming.volCompress * 100).toFixed(0)}% · 距顶 {bottoming.barsFromHigh} 日
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 240, fontSize: 13, color: 'var(--text-2)' }}>
                {bp?.summary ??
                  (bottoming.signal === '筑底失败·离场'
                    ? '底部已破，形态失败。若持有试探仓，按铁律立即离场，不要摊平。'
                    : bottoming.signal === '不符合形态'
                      ? '当前不是「大涨后降波筑底」形态，本模块不给信号。'
                      : '还在等结构确认，当前不给任何仓位。缩量横盘也可能是下跌中继，收敛本身不是买入理由。')}
              </div>
            </div>
          </div>

          {bp && (
            <Panel
              title="🎯 操作策略"
              icon="🎯"
              desc={bp.action === 'probe' ? '小仓试探：先买一点点，放量确认后再加，破底立刻走' : '筑底确认：放量突破颈线后才允许把仓位加上去'}
            >
              <div className="plan-grid">
                <div className="plan-cell">
                  <span>入场区间</span>
                  <b>{bp.entryLow.toFixed(2)} ~ {bp.entryHigh.toFixed(2)}</b>
                  <small>{cur} · {bp.action === 'probe' ? '现价附近分批' : '突破回踩颈线'}</small>
                </div>
                <div className="plan-cell">
                  <span>{bp.action === 'probe' ? '试探仓位' : '目标总仓'}</span>
                  <b>{(bp.positionPct * 100).toFixed(0)}% · {bp.shares > 0 ? `${bp.shares} 股` : '不足一手'}</b>
                  <small>约 {bp.amount.toFixed(0)} {cur} · 本金 {bottomingCfg.capital.toFixed(0)}</small>
                </div>
                <div className="plan-cell">
                  <span>止损（铁律）</span>
                  <b style={{ color: 'var(--down)' }}>{bp.stop.toFixed(2)}</b>
                  <small>底部低点 − {bottomingCfg.atrStop} ATR · 收盘破位即走</small>
                </div>
                <div className="plan-cell">
                  <span>目标 1</span>
                  <b style={{ color: 'var(--up)' }}>{bp.target1.toFixed(2)}</b>
                  <small>{bp.action === 'probe' ? '先看颈线' : '箱体量度涨幅'}</small>
                </div>
                <div className="plan-cell">
                  <span>目标 2</span>
                  <b>{bp.target2.toFixed(2)}</b>
                  <small>{bp.action === 'probe' ? '突破后的量度位' : '前高回撤 0.618 位'}</small>
                </div>
                <div className="plan-cell">
                  <span>盈亏比</span>
                  <b style={{ color: bp.rrOk ? 'var(--up)' : 'var(--amber)' }}>{bp.rr.toFixed(2)}</b>
                  <small>参考 {bottomingCfg.minRR} · 单笔风险约 {bp.riskAmount.toFixed(0)} {cur}</small>
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 12, marginTop: 14 }}>
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '12px 14px', background: 'var(--panel-2)' }}>
                  <b style={{ fontSize: 13 }}>➕ 什么时候才加仓</b>
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 2, color: 'var(--text-2)' }}>
                    {bp.addTriggers.map((t, k) => <li key={k}>{t}</li>)}
                  </ul>
                </div>
                <div style={{ border: '1px solid var(--border)', borderLeft: '4px solid var(--down)', borderRadius: 8, padding: '12px 14px', background: 'var(--panel-2)' }}>
                  <b style={{ fontSize: 13 }}>🛑 什么时候必须走</b>
                  <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, lineHeight: 2, color: 'var(--text-2)' }}>
                    {bp.exitTriggers.map((t, k) => <li key={k}>{t}</li>)}
                  </ul>
                </div>
              </div>
              {bp.shares === 0 && (
                <div className="inst-hint" style={{ marginTop: 10, color: 'var(--amber)' }}>
                  ⚠️ 按当前本金与仓位比例算出的金额不足 1 手（每手 {lot} 股），暂时建不了仓。请调高「本金」或「试探仓 %」。
                </div>
              )}
              {!bp.rrOk && (
                <div className="inst-hint" style={{ marginTop: 10, color: 'var(--amber)' }}>
                  ⚠️ 第一目标盈亏比 {bp.rr.toFixed(2)} 低于参考值 {bottomingCfg.minRR}，上方空间偏小，仓位已压回试探档，别一次打满。
                </div>
              )}
            </Panel>
          )}

          <Panel title="📡 六个筑底信号详解" icon="📡" desc="每个信号都用大白话说明现在是什么状态、对你意味着什么；六项合计 100 分">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: 12 }}>
              {bottoming.factors.map((f) => (
                <div
                  key={f.key}
                  style={{
                    border: '1px solid var(--border)',
                    borderLeft: `4px solid ${f.ok ? 'var(--up)' : 'var(--gray)'}`,
                    borderRadius: 8,
                    padding: '12px 14px',
                    background: 'var(--panel-2)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                    <span style={{ fontSize: 16 }}>{f.icon}</span>
                    <b style={{ fontSize: 13.5 }}>{f.name}</b>
                    <span style={{ marginLeft: 'auto', fontSize: 12, color: f.ok ? 'var(--up)' : 'var(--text-3)', fontWeight: 700 }}>
                      {f.score}/{f.max} · {f.value}
                    </span>
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.8 }}>{f.plain}</div>
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="📋 判定依据" icon="📋" desc="形态前置、压缩比、结构位、评分门槛全部写清楚，不做黑箱">
            <div className="news-brief">
              {bottoming.lines.map((l, k) => (
                <p key={k}><span className="nb-dot" />{l}</p>
              ))}
            </div>
            <MetricGrid items={bottoming.facts.map((f) => ({ label: f.label, value: f.value, tone: f.tone }))} />
          </Panel>

          {chart && (
            <Panel title="📈 价格 · 颈线 · 底部低点" icon="📈" desc="最近 120 个交易日；背景带按下跌段 / 降波筑底段示意，虚线为颈线、底部低点与止损">
              <EChart option={chart} height={340} />
            </Panel>
          )}
        </>
      )}

      {(swing || panic || bottoming) && (
        <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页当前模式的指标交给 AI 解读，只读不改任何设置">
          <AiAnalyze
            module={tab === 'swing' ? '波段交易' : tab === 'panic' ? '恐慌抄底' : '降波筑底'}
            symbol={picked?.name}
            note={tab === 'swing' ? '波段评分是「当前位置值不值得进」，不是预测涨幅。' : tab === 'panic' ? '胜率来自该股自身历史同类样本，样本少时不可靠。' : '只收敛不突破停在观察档；试探仓小、破底即走。'}
            facts={
              tab === 'swing' && swing
                ? [
                    { label: '形态 / 判定', value: swing.setup + ' / ' + swing.verdict },
                    { label: '评分', value: swing.score.toFixed(0) + ' / 100' },
                    { label: '收盘价', value: swing.close.toFixed(2) + ' ' + cur },
                    { label: 'ATR 占价', value: swing.atrPct.toFixed(2) + '%' },
                    { label: '量比', value: swing.volRatio.toFixed(2) },
                    { label: 'RSI / ADX', value: swing.rsi.toFixed(1) + ' / ' + swing.adx.toFixed(1) },
                    ...(swing.plan ? [
                      { label: '入场区间', value: swing.plan.entryLow.toFixed(2) + ' ~ ' + swing.plan.entryHigh.toFixed(2) },
                      { label: '止损 / 目标1', value: swing.plan.stop.toFixed(2) + ' / ' + swing.plan.target1.toFixed(2) },
                      { label: '风险回报比', value: swing.plan.rr.toFixed(1) }
                    ] : [])
                  ]
                : tab === 'panic' && panic
                  ? [
                      { label: '判定', value: panic.triggered ? '触发抄底' : '不触发' },
                      { label: '恐慌等级 / 评分', value: panic.level + ' / ' + panic.score },
                      { label: '今日跌幅', value: panic.drop.toFixed(2) + '%' },
                      { label: '量比', value: panic.volRatio.toFixed(2) },
                      { label: 'RSI', value: panic.rsi.toFixed(1) },
                      ...panic.stats.map((x) => ({ label: x.horizon + '日胜率', value: x.samples ? x.winRate.toFixed(0) + '%（样本 ' + x.samples + '）' : '无样本' }))
                    ]
                  : bottoming
                    ? [
                        { label: '信号', value: bottoming.signal },
                        { label: '筑底评分', value: bottoming.score.toFixed(0) + ' / 100' },
                        { label: '收盘价', value: bottoming.close.toFixed(2) + ' ' + cur },
                        { label: '波动压缩 / 量能压缩', value: (bottoming.compress * 100).toFixed(0) + '% / ' + (bottoming.volCompress * 100).toFixed(0) + '%' },
                        { label: '距顶天数 / 回撤', value: bottoming.barsFromHigh + ' 日 / ' + (bottoming.drawdown * 100).toFixed(2) + '%' },
                        ...bottoming.factors.map((f) => ({ label: f.name, value: f.score + '/' + f.max + ' · ' + f.value }))
                      ]
                    : []
            }
          />
        </Panel>
      )}

      <Panel title="⚠️ 使用边界" icon="⚠️">
        <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><b>波段</b>只做多头：下跌中继不给计划，区间震荡只做区间不做追多。评分是「当前位置值不值得进」，不是预测涨幅。</li>
            <li><b>抄底</b>的胜率来自这只股票自己的历史，样本少的时候不可靠；历史相似不等于这次一样，重大利空（造假、退市、政策）下技术性抄底会连续失效。</li>
            <li><b>降波筑底</b>只识别「大涨 → 逐级下跌 → 波动与量能双收敛」这一段。缩量横盘同样可能是下跌中继，所以只收敛不突破一律停在观察档；试探仓很小、破底必须即走，加仓的唯一条件是放量站上颈线。至少需要 120 根日 K，建议 250 根以上。</li>
            <li><b>涨跌停与 T+1</b>：A 股跌停可能买不到、T+1 当天不能卖；日韩有値幅制限，港股美股无涨跌停但单日波动更大。计划里的价格是「挂单价」，不是「一定能成交」。</li>
            <li>所有计划都假设按止损离场。不设止损、亏损加仓，再好的入场也会变成套牢。</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
