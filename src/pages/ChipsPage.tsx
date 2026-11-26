import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import EChart from '../components/EChart';
import { C, chipOption, lineOption } from '../components/chartOptions';
import { CtrlGroup, EmptyTip, Loading, MathPanel, MetricGrid, Panel } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { useApp } from '../hooks/AppContext';
import { searchStocks, type StockHit } from '../data/search';
import { getSymbol, MARKET_LABEL, type Market } from '../data/symbols';
import { loadRecent, loadWatchlist } from '../data/watchlist';
import { marketRuleOf } from '../data/marketRules';
import { DEFAULT_CHIP, analyzeChips, type ChipConfig } from '../math/chips';

const HOT: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', secid: '1.600519' },
  { code: 'sz300750', name: '宁德时代', market: 'CN', marketLabel: 'A股', secid: '0.300750' },
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

export default function ChipsPage() {
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
  const [cfg, setCfg] = useState<ChipConfig>(DEFAULT_CHIP);
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
  const bars = st && !st.loading && !st.failed && st.bars.length >= 30 ? st.bars : null;
  const rule = picked ? marketRuleOf(picked.code) : null;
  const cur = rule?.currency ?? '元';

  const result = useMemo(() => (bars ? analyzeChips(bars, cfg) : null), [bars, cfg]);

  // 价格走势小图（最近 60 日），把成本区/现价叠加进去辅助理解
  const priceChart = useMemo(() => {
    if (!bars || !result) return null;
    const seg = bars.slice(-90);
    const labels = seg.map((b) => b.date.slice(5));
    const opt = lineOption(labels, [{ name: '收盘', data: seg.map((b) => b.close), color: C.accent, lineWidth: 2 }], { yName: cur });
    const yAxis = opt.yAxis as unknown as { scale?: boolean } | { scale?: boolean }[];
    if (yAxis && !Array.isArray(yAxis)) yAxis.scale = true;
    const first = (opt.series as unknown as { markLine?: unknown }[])[0];
    first.markLine = {
      symbol: 'none',
      silent: true,
      label: { formatter: '{b}', fontSize: 10, color: C.text, position: 'middle' },
      data: [
        { name: '现价', yAxis: result.price, lineStyle: { color: C.accent, width: 1.5 } },
        { name: '平均成本', yAxis: result.avgCost, lineStyle: { color: C.orange, type: 'dashed', width: 1 } },
        { name: '成本区上沿', yAxis: result.costHigh, lineStyle: { color: C.purple, type: 'dashed', width: 1 } },
        { name: '成本区下沿', yAxis: result.costLow, lineStyle: { color: C.purple, type: 'dashed', width: 1 } }
      ]
    };
    return opt;
  }, [bars, result, cur]);

  const chipChart = useMemo(() => {
    if (!result) return null;
    return chipOption(
      result.bins.map((b) => ({ price: b.price, ratio: b.ratio })),
      {
        price: result.price,
        costLow: result.costLow,
        costHigh: result.costHigh,
        avgCost: result.avgCost,
        peakPrices: result.peaks.map((p) => p.price),
        digits: result.price < 10 ? 3 : 2
      }
    );
  }, [result]);

  const verdictColor =
    result?.profitRatio != null && result.profitRatio >= 0.85
      ? 'var(--up)'
      : result?.profitRatio != null && result.profitRatio <= 0.15
        ? 'var(--down)'
        : result?.shape === 'single' && result.concentration <= 0.3
          ? 'var(--up)'
          : 'var(--amber)';

  return (
    <div>
      <div className="page-title-row">
        <h2>🧱 筹码分布 · 持仓成本</h2>
        <span className="en">Chip Distribution · Cost Basis</span>
      </div>
      <p className="page-lead">
        模拟当前流通筹码分布在哪些价位——看清<b>平均成本、获利盘 / 套牢盘、成本密集区与峰位</b>，
        判断现价上方是压力还是下方有支撑。采用「三角形分布 + 换手率衰减」迭代，
        覆盖 <b>A 股 / 港股 / 美股 / 日股 / 韩股</b>。
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
          <label className="t0-field">
            回看交易日
            <input type="number" min={30} max={500} step={10} value={cfg.lookback} onChange={(e) => setCfg((c) => ({ ...c, lookback: Math.max(30, num(e.target.value, c.lookback)) }))} />
          </label>
          <label className="t0-field">
            价格精度（格）
            <input type="number" min={20} max={200} step={10} value={cfg.bins} onChange={(e) => setCfg((c) => ({ ...c, bins: Math.max(20, num(e.target.value, c.bins)) }))} />
          </label>
          <label className="t0-field">
            基准换手率 %
            <input
              type="number" step="0.5" min="0.1" max="20"
              value={Number((cfg.baseTurnover * 100).toFixed(2))}
              onChange={(e) => setCfg((c) => ({ ...c, baseTurnover: num(e.target.value, c.baseTurnover * 100) / 100 }))}
            />
          </label>
          <label className="t0-field">
            量能均窗
            <input type="number" min={5} max={120} step={5} value={cfg.volWindow} onChange={(e) => setCfg((c) => ({ ...c, volWindow: Math.max(5, num(e.target.value, c.volWindow)) }))} />
          </label>
          {rule && (
            <span className="inst-hint" style={{ flexBasis: '100%' }}>
              交易制度：<b>{rule.label}</b> · {rule.settlement} · {rule.priceLimit} · 每手 {rule.lotSize} 股。{rule.note}
            </span>
          )}
        </div>
      </div>

      {!picked && <EmptyTip text="搜索或点击上方热门标的，开始筹码分布分析" />}
      {picked && st?.loading && <Loading text={`正在拉取 ${picked.name} 日 K…`} />}
      {picked && st?.failed && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 暂不可达</div>
          <div className="panel-desc">没有历史 K 线就算不出筹码分布。本站不用模拟数据冒充真实行情。</div>
        </div>
      )}
      {picked && !st?.loading && !st?.failed && !bars && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 不足 30 根</div>
          <div className="panel-desc">筹码分布至少需要 30 根日 K 才有意义，请把顶部回看周期调大后重试。</div>
        </div>
      )}

      {result && (
        <>
          <div className="panel" style={{ borderWidth: 2, borderColor: verdictColor, background: `color-mix(in srgb, ${verdictColor} 8%, var(--panel))` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 28, fontWeight: 900, color: verdictColor, whiteSpace: 'nowrap' }}>{result.verdict}</div>
              <div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  获利盘 {(result.profitRatio * 100).toFixed(0)}% · 集中度 {result.concentration.toFixed(2)}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>
                  {picked?.name} · 现价 {result.price.toFixed(2)} {cur} · {result.shapeLabel} · {result.concentrationLabel}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 240, fontSize: 13, color: 'var(--text-2)' }}>{result.position}。</div>
            </div>
          </div>

          <Panel title="📊 关键成本指标" icon="📊" desc="成本区间取 5%~95% 分位；集中度 =(上沿−下沿)/(上沿+下沿)，越小越集中">
            <MetricGrid
              items={[
                { label: '现价', value: `${result.price.toFixed(2)} ${cur}` },
                { label: '平均成本', value: result.avgCost.toFixed(2), sub: cur },
                { label: '中位成本', value: result.medianCost.toFixed(2), sub: cur },
                { label: '获利盘', value: `${(result.profitRatio * 100).toFixed(0)}%`, sub: '成本低于现价', tone: result.profitRatio >= 0.5 ? 'up' : 'down' },
                { label: '90% 成本下沿', value: result.costLow.toFixed(2), sub: '5% 分位' },
                { label: '90% 成本上沿', value: result.costHigh.toFixed(2), sub: '95% 分位' },
                { label: '集中度', value: result.concentration.toFixed(2), sub: result.concentrationLabel },
                { label: '形态', value: result.shapeLabel, sub: `${result.peaks.length} 个主要峰` }
              ]}
            />
          </Panel>

          {chipChart && (
            <Panel title="🧱 筹码分布图" icon="🧱" desc="横向峰：纵轴为成本价、横轴为该价位筹码占比；红色=获利盘、绿色=套牢盘；虚线为平均成本与峰位，阴影为 90% 成本区">
              <EChart option={chipChart} height={460} />
            </Panel>
          )}

          {priceChart && (
            <Panel title="📈 价格与成本区" icon="📈" desc="最近 90 个交易日收盘；虚线为现价、平均成本与 90% 成本区上下沿">
              <EChart option={priceChart} height={320} />
            </Panel>
          )}

          {result.peaks.length > 0 && (
            <Panel title="⛰️ 成本峰位" icon="⛰️" desc="筹码最密集的价位，通常构成支撑（现价下方）或压力（现价上方）">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr><th>峰位成本</th><th>筹码占比</th><th>相对现价</th><th>含义</th></tr>
                  </thead>
                  <tbody>
                    {result.peaks.map((p, i) => {
                      const below = p.price <= result.price;
                      return (
                        <tr key={i}>
                          <td className="num">{p.price.toFixed(2)} {cur}</td>
                          <td className="num">{(p.ratio * 100).toFixed(2)}%</td>
                          <td className="num" style={{ color: below ? 'var(--up)' : 'var(--down)' }}>{below ? '下方' : '上方'}</td>
                          <td>{below ? '支撑参考（获利筹码密集）' : '压力参考（套牢筹码密集）'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          )}

          <Panel title="📋 判定依据" icon="📋" desc="每条结论都能对应到一个成本指标，不做黑箱">
            <div className="news-brief">
              {result.lines.map((l, i) => (
                <p key={i}><span className="nb-dot" />{l}</p>
              ))}
            </div>
          </Panel>

          <MathPanel>
            <div style={{ fontSize: 13, lineHeight: 2, color: 'var(--text-2)' }}>
              <p><b>1. 价格离散化</b>：把回看窗口内的 [最低价, 最高价] 切成 N 个格子，每个格子记录「成本落在这里的筹码占比」。</p>
              <p><b>2. 换手率代理</b>：本站没有历史每日流通股本，用 <code>换手率 = 当日量 / 近 {cfg.volWindow} 日均量 × {cfg.baseTurnover}</code>（上限 100%）作为代理，它反映相对换手强弱，<b>不是真实换手率</b>。</p>
              <p><b>3. 三角形分配</b>：把当日成交按三角形摊到 [low, high]，顶点在当日均价——均价附近成交最密集，两端最少。</p>
              <p><b>4. 衰减迭代</b>：<code>新筹码 = 旧筹码 ×(1−换手率) + 当日分配 × 换手率</code>。换手越快，历史成本被冲刷得越多，新成本占比越大。</p>
              <p><b>5. 衍生指标</b>：获利盘 = 成本低于现价的筹码占比；成本区间取累计占比 5%/95% 分位；集中度 = (上沿−下沿)/(上沿+下沿)。</p>
            </div>
          </MathPanel>
        </>
      )}

      {result && (
        <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页筹码指标交给 AI 解读，只读不改任何设置">
          <AiAnalyze
            module="筹码分布 · 持仓成本"
            symbol={picked?.name}
            note="筹码分布为换手率代理下的近似模拟，非真实持仓数据。"
            facts={[
              { label: '现价', value: result.price.toFixed(2) + ' ' + cur },
              { label: '平均成本', value: result.avgCost.toFixed(2) + ' ' + cur },
              { label: '中位成本', value: result.medianCost.toFixed(2) + ' ' + cur },
              { label: '获利盘比例', value: (result.profitRatio * 100).toFixed(0) + '%' },
              { label: '90% 成本区间', value: result.costLow.toFixed(2) + ' ~ ' + result.costHigh.toFixed(2) + ' ' + cur },
              { label: '集中度', value: result.concentration.toFixed(2) + '（' + result.concentrationLabel + '，越小越集中）' },
              { label: '形态', value: result.shapeLabel },
              { label: '成本峰位', value: result.peaks.length ? result.peaks.map((p) => p.price.toFixed(2)).join('、') : '无明显峰' },
              { label: '综合判定', value: result.verdict },
              { label: '样本', value: '最近 ' + result.usedBars + ' 根日 K' }
            ]}
          />
        </Panel>
      )}

      <Panel title="⚠️ 使用边界" icon="⚠️">
        <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            <li><b>这是近似模拟，不是真实持仓</b>：换手率由量能代理，且未考虑复权、大宗交易、股东实际增减持，得到的成本分布只用于观察结构变化，不等于交易所或机构的精确筹码数据。</li>
            <li><b>参数敏感</b>：基准换手率、回看天数、价格精度都会改变结果。基准换手率调大→历史筹码衰减更快、分布更贴近近期价格；调小→更看重长期成本。同一只票不同参数会给出不同形态，请横向比较而非迷信单一数值。</li>
            <li><b>峰位是参考不是预言</b>：密集峰意味着大量筹码成本相近，可能形成支撑/压力，但在重大利好利空、涨跌停、停牌复牌面前会迅速失效。</li>
            <li><b>只做多头视角</b>：获利盘高既可能是强势也可能是兑现前夜，套牢盘重既可能是压力也可能是底部，必须结合趋势与量能一起看，本模块不给买卖点。</li>
            <li>所有模型仅供学习研究，不构成任何投资建议。</li>
          </ul>
        </div>
      </Panel>
    </div>
  );
}
