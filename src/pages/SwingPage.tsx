import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import EChart from '../components/EChart';
import { C, lineOption } from '../components/chartOptions';
import { CtrlGroup, EmptyTip, Loading, MetricGrid, Panel } from '../components/ui';
import { useApp } from '../hooks/AppContext';
import { searchStocks, type StockHit } from '../data/search';
import { getSymbol, MARKET_LABEL, type Market } from '../data/symbols';
import { loadRecent, loadWatchlist } from '../data/watchlist';
import { marketRuleOf } from '../data/marketRules';
import { DEFAULT_SWING_CONFIG, analyzeSwing, type SwingConfig } from '../math/swing';
import { DEFAULT_PANIC_CONFIG, analyzePanic, type PanicConfig } from '../math/panic';

type Tab = 'swing' | 'panic';

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

  const chart = useMemo(() => {
    if (!bars || (!swing && !panic)) return null;
    const n = Math.min(120, bars.length);
    const seg = bars.slice(-n);
    const labels = seg.map((b) => b.date.slice(5));
    const series: { name: string; data: (number | null)[]; color: string; lineWidth: number }[] = [
      { name: '收盘', data: seg.map((b) => b.close), color: C.accent, lineWidth: 2 }
    ];
    if (tab === 'swing' && swing) {
      series.push({ name: 'MA20', data: swing.ma20.slice(-n), color: C.orange, lineWidth: 1.4 });
      series.push({ name: 'MA60', data: swing.ma60.slice(-n), color: C.purple, lineWidth: 1.4 });
    }
    const opt = lineOption(labels, series, { yName: cur });
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
      (opt.series as unknown as { markLine?: unknown }[])[0].markLine = {
        symbol: 'none',
        silent: true,
        label: { formatter: '{b}', fontSize: 10, color: C.text, position: 'middle' },
        data: list.map((x) => ({ name: x.name, yAxis: x.yAxis, lineStyle: { color: x.color, type: 'dashed', width: 1 } }))
      };
      // 不写死 min/max：ECharts 在绝对范围下会算出 1e9 这种鬼刻度。
      // scale 让它按数据自动缩放，目标价超出范围时线不显示（计划卡片里仍有数字）。
      const yAxis = opt.yAxis as unknown as { scale?: boolean } | { scale?: boolean }[];
      if (yAxis && !Array.isArray(yAxis)) yAxis.scale = true;
    }
    return opt;
  }, [bars, tab, swing, panic, cur]);

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

  return (
    <div>
      <div className="page-title-row">
        <h2>📈 波段 · 抄底短线</h2>
        <span className="en">Swing &amp; Panic Bottom</span>
      </div>
      <p className="page-lead">
        <b>波段</b>：看趋势与位置，给「回踩买 / 突破买」的入场、止损、目标与仓位，持有 3~20 个交易日。
        <b>抄底</b>：先给恐慌程度打分，再用这只股票<b>自己的历史</b>回答「同样跌幅后 1/3/5 天涨跌概率」。
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
            {(['swing', 'panic'] as Tab[]).map((t) => (
              <button key={t} type="button" className={`chip-toggle${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>
                {t === 'swing' ? '波段（3~20 日）' : '恐慌抄底（1~5 日）'}
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
          ) : (
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

      <Panel title="⚠️ 使用边界" icon="⚠️">
        <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><b>波段</b>只做多头：下跌中继不给计划，区间震荡只做区间不做追多。评分是「当前位置值不值得进」，不是预测涨幅。</li>
            <li><b>抄底</b>的胜率来自这只股票自己的历史，样本少的时候不可靠；历史相似不等于这次一样，重大利空（造假、退市、政策）下技术性抄底会连续失效。</li>
            <li><b>涨跌停与 T+1</b>：A 股跌停可能买不到、T+1 当天不能卖；日韩有値幅制限，港股美股无涨跌停但单日波动更大。计划里的价格是「挂单价」，不是「一定能成交」。</li>
            <li>所有计划都假设按止损离场。不设止损、亏损加仓，再好的入场也会变成套牢。</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
