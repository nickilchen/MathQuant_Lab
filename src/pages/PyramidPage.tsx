import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import EChart from '../components/EChart';
import { C, lineOption, pyramidLadderOption } from '../components/chartOptions';
import { CtrlGroup, EmptyTip, Loading, MathPanel, MetricGrid, Panel } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { useApp } from '../hooks/AppContext';
import { searchStocks, type StockHit } from '../data/search';
import { getSymbol, MARKET_LABEL, type Market } from '../data/symbols';
import { loadRecent, loadWatchlist } from '../data/watchlist';
import { marketRuleOf } from '../data/marketRules';
import {
  analyzePyramid,
  DEFAULT_PYRAMID_CONFIG,
  PYRAMID_RISKS,
  type PyramidConfig,
  type PyramidMode,
  type StopMode
} from '../math/pyramid';

const HOT: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', secid: '1.600519' },
  { code: 'sh601318', name: '中国平安', market: 'CN', marketLabel: 'A股', secid: '1.601318' },
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

const verdictColor = (v: string | undefined): string =>
  v === '可执行' ? 'var(--up)' : v === '风险过高' || v === '不适合' ? 'var(--down)' : 'var(--amber)';

export default function PyramidPage() {
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

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [showDrop, setShowDrop] = useState(false);
  const [picked, setPicked] = useState<StockHit | null>(null);
  const [cfg, setCfg] = useState<PyramidConfig>(DEFAULT_PYRAMID_CONFIG);
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
  const bars = st && !st.loading && !st.failed && st.bars.length >= 60 ? st.bars : null;
  const rule = picked ? marketRuleOf(picked.code) : null;
  const lot = rule?.lotSize ?? 100;
  const cur = rule?.currency ?? '元';

  const result = useMemo(
    () => (bars ? analyzePyramid(bars, { ...cfg, lot }) : null),
    [bars, cfg, lot]
  );

  /* ---------- 价格 + 五档回撤位 + 止损线 ---------- */
  const priceChart = useMemo(() => {
    if (!bars || !result) return null;
    const n = Math.min(160, bars.length);
    const seg = bars.slice(-n);
    const labels = seg.map((b) => b.date.slice(5));
    const opt = lineOption(labels, [{ name: '收盘', data: seg.map((b) => b.close), color: C.accent, lineWidth: 2 }], { yName: cur });
    const first = (opt.series as unknown as { markLine?: unknown; markArea?: unknown }[])[0];
    const yAxis = opt.yAxis as unknown as { scale?: boolean } | { scale?: boolean }[];
    if (yAxis && !Array.isArray(yAxis)) yAxis.scale = true;

    const lines = [
      ...result.rows.map((r) => ({ name: r.label + (r.active ? '' : '·停'), yAxis: r.price, color: r.zone === '核心区' ? C.up : C.gray })),
      { name: '止损 ' + result.stopLabel.replace(/（.*/, ''), yAxis: result.stopPrice, color: C.down },
      { name: '高点', yAxis: result.high, color: C.orange }
    ];
    first.markLine = {
      symbol: 'none',
      silent: true,
      label: { formatter: '{b}', fontSize: 10, color: C.text, position: 'middle' },
      data: lines.map((x) => ({ name: x.name, yAxis: x.yAxis, lineStyle: { color: x.color, type: 'dashed', width: 1 } }))
    };
    return opt;
  }, [bars, result, cur]);

  const ladderChart = useMemo(
    () => (result ? pyramidLadderOption(result.rows.map((r) => ({ label: r.label, weight: r.weight, shares: r.shares, zone: r.zone, active: r.active }))) : null),
    [result]
  );

  const vColor = verdictColor(result?.verdict);

  return (
    <div>
      <div className="page-title-row">
        <h2>🪜 斐波那契加仓 · 橄榄型</h2>
        <span className="en">Fibonacci Pyramid · Olive Build</span>
      </div>
      <p className="page-lead">
        <b>两头小、中间大</b>：浅回撤先小加，进入 <b>38.2%—61.8% 黄金分割核心区</b>重仓，跌到末端若还没止跌反而不敢再加、甚至整体止损。
        这不是标准的逆势（越跌越重 1/1/2/3/5）或顺势（越涨越重 1/2/4/8）斐波那契加仓，而是把风险预算<b>集中押在自认为胜率最高的核心回撤区</b>的「区间信念型」加仓。
        覆盖 <b>A 股 / 港股 / 美股 / 日股 / 韩股</b>。
      </p>

      <div className="control-bar" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 260 }}>
          <input
            value={query}
            onChange={(e) => { skipSearch.current = false; setQuery(e.target.value); }}
            onFocus={() => hits.length > 0 && setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 200)}
            placeholder="输入名称或代码（A股 / 港股 / 美股 / 日股 / 韩股），如：茅台 / 00700 / AAPL"
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
            <button key={h.code} type="button" className="chip-toggle" onClick={() => pick(h)}>{h.name}</button>
          ))}
        </CtrlGroup>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'center' }}>
          <CtrlGroup label="策略">
            <button type="button" className={`chip-toggle${cfg.mode === 'olive' ? ' on' : ''}`} onClick={() => setCfg((c) => ({ ...c, mode: 'olive' as PyramidMode }))}>橄榄型 1/3/5/3/1</button>
            <button type="button" className={`chip-toggle${cfg.mode === 'fib' ? ' on' : ''}`} onClick={() => setCfg((c) => ({ ...c, mode: 'fib' as PyramidMode }))}>逆势斐波那契（对照）</button>
          </CtrlGroup>
          <CtrlGroup label="止损位">
            <button type="button" className={`chip-toggle${cfg.stopMode === '786' ? ' on' : ''}`} onClick={() => setCfg((c) => ({ ...c, stopMode: '786' as StopMode }))}>78.6%（末端）</button>
            <button type="button" className={`chip-toggle${cfg.stopMode === '618' ? ' on' : ''}`} onClick={() => setCfg((c) => ({ ...c, stopMode: '618' as StopMode }))}>61.8%（核心下沿）</button>
          </CtrlGroup>
          <label className="t0-field">本金<input type="number" value={cfg.capital} onChange={(e) => setCfg((c) => ({ ...c, capital: num(e.target.value, c.capital) }))} /></label>
          <label className="t0-field">回看日<input type="number" value={cfg.lookback} onChange={(e) => setCfg((c) => ({ ...c, lookback: num(e.target.value, c.lookback) }))} /></label>
          {rule && (
            <span className="inst-hint" style={{ flexBasis: '100%' }}>
              交易制度：<b>{rule.label}</b> · {rule.settlement} · {rule.priceLimit} · 每手 {rule.lotSize} 股。{rule.note}
            </span>
          )}
        </div>
      </div>

      {!picked && <EmptyTip text="搜索或点击上方热门标的，开始橄榄型加仓分析" />}
      {picked && st?.loading && <Loading text={`正在拉取 ${picked.name} 日 K…`} />}
      {picked && st?.failed && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 暂不可达</div>
          <div className="panel-desc">没有历史 K 线就识别不出主升段与回撤位。本站不用模拟数据冒充真实行情。</div>
        </div>
      )}
      {picked && !st?.loading && !st?.failed && !bars && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 不足 60 根</div>
          <div className="panel-desc">加仓计划至少需要 60 根日 K，请把顶部回看周期调大后重试。</div>
        </div>
      )}

      {result && (
        <>
          <div className="panel" style={{ borderWidth: 2, borderColor: vColor, background: `color-mix(in srgb, ${vColor} 8%, var(--panel))` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 30, fontWeight: 900, color: vColor, whiteSpace: 'nowrap' }}>{result.verdict}</div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  现价 {result.close.toFixed(2)} {cur} · 回撤 {(result.retrace * 100).toFixed(1)}%
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>
                  主升段 {result.low.toFixed(2)}（{result.lowDate}）→ {result.high.toFixed(2)}（{result.highDate}）· 幅度 {result.amplitude.toFixed(2)}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 240, fontSize: 13, color: 'var(--text-2)' }}>{result.verdictNote}</div>
            </div>
          </div>

          {!result.valid && (
            <div className="panel notice">
              <div className="panel-title">⚠️ 回撤结构不成立</div>
              <div className="panel-desc">{result.invalidReason}。橄榄型加仓要求「先有主升段、后有回撤」，不满足时不给任何加仓计划，避免把下跌段误当回撤。</div>
            </div>
          )}

          {result.valid && (
            <>
              <Panel title="🪜 五档加仓计划" icon="🪜" desc="按回撤位挂单；核心区权重最重，末端只留极小仓或停止">
                <div className="tbl-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>回撤档</th><th>挂单价</th><th>距现价</th><th>区域</th><th>权重</th><th>股数</th><th>金额</th><th>累计股数</th><th>累计均价</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.map((r) => (
                        <tr key={r.label} style={{ opacity: r.active ? 1 : 0.45 }}>
                          <td><b>{r.label}</b></td>
                          <td className="num">{r.price.toFixed(2)}</td>
                          <td className="num" style={{ color: r.fromClose <= 0 ? 'var(--down)' : 'var(--text-3)' }}>{r.fromClose > 0 ? '+' : ''}{r.fromClose.toFixed(2)}%</td>
                          <td>
                            <span className={`badge ${r.zone === '核心区' ? 'info' : r.zone === '浅回撤' ? 'warn' : ''}`}>
                              {r.zone}{r.active ? '' : '·停'}
                            </span>
                          </td>
                          <td className="num">{r.weight}</td>
                          <td className="num">{r.shares}</td>
                          <td className="num">{r.amount.toFixed(0)}</td>
                          <td className="num">{r.cumShares}</td>
                          <td className="num">{r.cumAvgCost > 0 ? r.cumAvgCost.toFixed(2) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="plan-grid" style={{ marginTop: 12 }}>
                  <div className="plan-cell"><span>全档合计</span><b>{result.totalShares} 股</b><small>投入 {result.totalAmount.toFixed(0)} {cur}</small></div>
                  <div className="plan-cell"><span>平均成本</span><b>{result.avgCost.toFixed(2)}</b><small>全档成交后</small></div>
                  <div className="plan-cell"><span>核心区占比</span><b style={{ color: 'var(--up)' }}>{result.coreSharePct.toFixed(1)}%</b><small>38.2/50/61.8 档</small></div>
                  <div className="plan-cell"><span>止损位</span><b style={{ color: 'var(--down)' }}>{result.stopPrice.toFixed(2)}</b><small>{result.stopLabel}</small></div>
                  <div className="plan-cell"><span>最大亏损</span><b style={{ color: 'var(--down)' }}>{result.maxLoss.toFixed(0)}</b><small>占预算 {result.maxLossPct.toFixed(1)}%</small></div>
                  <div className="plan-cell"><span>盈亏比</span><b style={{ color: result.rr >= 2 ? 'var(--up)' : 'var(--amber)' }}>{result.rr.toFixed(2)}</b><small>回到高点 {result.target.toFixed(2)}（+{result.upsidePct.toFixed(2)}%）</small></div>
                </div>
                <div className="inst-hint" style={{ marginTop: 10 }}>
                  每档按每手 {lot} 股取整；T+1 市场当天买入次日才能卖，挂单价是「计划价」不是「必成交价」。
                </div>
              </Panel>

              {ladderChart && (
                <Panel title="📊 仓位摆位（两头小、中间大）" icon="📊" desc="红色为核心区重仓档，两端轻仓；停用的末端档置灰">
                  <EChart option={ladderChart} height={280} />
                </Panel>
              )}

              {priceChart && (
                <Panel title="📈 价格与回撤位" icon="📈" desc="最近 160 个交易日；虚线为五档挂单、止损位与主升高点">
                  <EChart option={priceChart} height={360} />
                </Panel>
              )}
            </>
          )}

          <Panel title="📋 判定依据" icon="📋" desc="结构、权重、计划、止损全部写清楚，不做黑箱">
            <div className="news-brief">
              {result.lines.map((l, i) => <p key={i}><span className="nb-dot" />{l}</p>)}
            </div>
            <MetricGrid items={result.facts.map((f) => ({ label: f.label, value: f.value, tone: f.tone }))} />
          </Panel>

          <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页加仓计划交给 AI 解读，只读不改任何设置">
            <AiAnalyze
              module="橄榄型斐波那契加仓"
              symbol={picked?.name}
              note="本页只回答「预算怎么摆、失效位在哪」，不预测涨跌；核心区重仓的前提是止损位已前置。"
              facts={[
                { label: '判定', value: result.verdict },
                { label: '现价 / 回撤', value: result.close.toFixed(2) + ' ' + cur + ' / ' + (result.retrace * 100).toFixed(1) + '%' },
                { label: '主升段', value: result.low.toFixed(2) + ' → ' + result.high.toFixed(2) },
                { label: '策略 / 止损', value: result.mode === 'olive' ? '橄榄型 1/3/5/3/1' : '逆势斐波那契（对照）' + ' / ' + result.stopLabel },
                { label: '全档股数 / 平均成本', value: result.totalShares + ' 股 / ' + result.avgCost.toFixed(2) },
                { label: '核心区占比', value: result.coreSharePct.toFixed(1) + '%' },
                { label: '止损 / 最大亏损', value: result.stopPrice.toFixed(2) + ' / ' + result.maxLoss.toFixed(0) + '（' + result.maxLossPct.toFixed(1) + '%）' },
                { label: '盈亏比', value: result.rr.toFixed(2) },
                ...result.rows.map((r) => ({ label: r.label + ' 档', value: r.price.toFixed(2) + ' × ' + r.shares + ' 股（' + r.zone + (r.active ? '' : '·停') + '）' }))
              ]}
            />
          </Panel>

          <Panel title="📐 数学原理" icon="📐">
            <MathPanel>
              <p><b>1. 回撤位</b>：以主升段起点低点 L、高点 H 为锚，回撤位 P(r) = H − (H − L) × r，r ∈ {'{'}23.6%, 38.2%, 50%, 61.8%, 76.4%{'}'}。</p>
              <p><b>2. 权重摆位</b>：橄榄型 w = [1, 3, 5, 3, 1]，每档预算 = 本金 × wᵢ / Σw，股数 = floor(预算 / Pᵢ / 每手) × 每手。核心区 38.2%/50%/61.8% 合计 11 份，占 11/13 ≈ 84.6%。</p>
              <p><b>3. 对照模式</b>：标准逆势斐波那契 w = [1, 1, 2, 3, 5]（越跌越重），与本策略的「中间大、末端收」相反，切换后可直接比较核心区占比差异。</p>
              <p><b>4. 成本与风险</b>：平均成本 = Σ(股数ᵢ × Pᵢ) / Σ股数ᵢ；最大亏损 = (平均成本 − 止损位) × 总股数；盈亏比 = (H − 平均成本) / (平均成本 − 止损位)。</p>
              <p><b>5. 止损档差异</b>：止损 61.8% 时末端 76.4% 档停用（还没走到就止损）；止损 78.6% 时保留末端极小仓，但破位必须整体离场。</p>
              <p><b>6. 适用前提</b>：只在「趋势结构仍完好、核心区有明确失效位、总风险预算前置」三种条件同时满足时才适用。它赌的是黄金分割带撑住，不是预测工具。</p>
            </MathPanel>
          </Panel>
        </>
      )}

      <Panel title="⚠️ 使用边界（务必先读）" icon="⚠️">
        <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
          <p style={{ margin: '0 0 8px', color: 'var(--down)', fontWeight: 700 }}>四条致命风险：</p>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {PYRAMID_RISKS.map((r, i) => <li key={i}>{r}</li>)}
          </ul>
          <p style={{ margin: '10px 0 0' }}>
            <b>它适合</b>：趋势结构仍完好、核心回撤区有明确失效位、总风险预算前置的场景。
            <b>使用前必须先定义「核心区失效」的止损位</b>（有效跌破 61.8% 或 78.6% 就整体止损），而不是继续在末端小加摊平——否则「中间大加」很容易变成重仓赌支撑。
            所有价格是挂单计划价，不保证成交；涨跌停与 T+1 可能导致买不到或卖不掉。
          </p>
        </div>
      </Panel>
    </div>
  );
}
