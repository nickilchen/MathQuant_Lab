import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import EChart from '../components/EChart';
import {
  ControlBar,
  CtrlGroup,
  EmptyTip,
  Loading,
  MathPanel,
  MetricGrid,
  Panel,
  Select,
  SignalBadge,
  Slider,
  SourcePill,
  fmtPct
} from '../components/ui';
import { C, lineOption } from '../components/chartOptions';
import { useApp, useKline } from '../hooks/AppContext';
import { MARKET_LABEL, getSymbol, type Market } from '../data/symbols';
import { searchStocks, type StockHit } from '../data/search';
import { loadRecent, loadWatchlist } from '../data/watchlist';
import { DEFAULT_MOM, buildMomentumReport, type MomParams } from '../math/momentum';
import { ActionPanel } from '../components/ActionPanel';
import { AiPanel } from '../components/AiPanel';
import { buildActionPlan } from '../math/action';

const LOOKBACKS = [
  { value: '63', label: '3 个月' },
  { value: '126', label: '6 个月' },
  { value: '252', label: '12 个月' }
];

const SKIPS = [
  { value: '0', label: '不跳过' },
  { value: '5', label: '跳过 5 日' },
  { value: '21', label: '跳过 21 日' }
];

const MAS = [
  { value: '0', label: '关闭' },
  { value: '100', label: 'MA100' },
  { value: '200', label: 'MA200' }
];

/** 常用个股名称兜底（未进自选/最近访问时也能显示中文名） */
const HOT: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', tencent: 'sh600519', sina: 'sh600519', secid: '1.600519' },
  { code: 'sz300750', name: '宁德时代', market: 'CN', marketLabel: 'A股', tencent: 'sz300750', sina: 'sz300750', secid: '0.300750' },
  { code: 'hk00700', name: '腾讯控股', market: 'HK', marketLabel: '港股', tencent: 'hk00700' },
  { code: 'usAAPL', name: '苹果', market: 'US', marketLabel: '美股', sina: 'AAPL', yahoo: 'AAPL' },
  { code: 'usNVDA', name: '英伟达', market: 'US', marketLabel: '美股', sina: 'NVDA', yahoo: 'NVDA' },
  { code: 'kr005930', name: '三星电子', market: 'KR', marketLabel: '韩股', naver: '005930' },
  { code: 'jp7203', name: '丰田汽车', market: 'JP', marketLabel: '日股', yahoo: '7203.T' }
];

const KNOWN_NAMES: Record<string, string> = {
  sh600519: '贵州茅台',
  sh601318: '中国平安',
  sh600036: '招商银行',
  sh601899: '紫金矿业',
  sz000001: '平安银行',
  sz000858: '五粮液',
  sz300750: '宁德时代',
  sz002594: '比亚迪',
  hk00700: '腾讯控股',
  hk09988: '阿里巴巴',
  hk03690: '美团',
  usAAPL: '苹果',
  usNVDA: '英伟达',
  usTSLA: '特斯拉'
};

function lookup(code: string): StockHit | undefined {
  return (
    loadWatchlist().find((x) => x.code === code) ??
    loadRecent().find((x) => x.code === code)
  );
}

/** 任意代码 -> StockHit：内置优先，其次自选/最近，最后按前缀推断市场并补全数据源映射 */
function resolveHit(code: string): StockHit | undefined {
  const sym = getSymbol(code);
  if (sym) {
    return {
      code: sym.code,
      name: sym.name,
      market: sym.market,
      marketLabel: MARKET_LABEL[sym.market],
      tencent: sym.code,
      secid: sym.secid || undefined,
      sina: sym.sina,
      naver: sym.naver,
      yahoo: sym.yahoo
    };
  }
  const known = lookup(code);
  if (known) return known;
  const nick = KNOWN_NAMES[code];
  const prefix = code.slice(0, 2).toLowerCase();
  const market: Market =
    prefix === 'hk' ? 'HK' : prefix === 'us' ? 'US' : prefix === 'kr' ? 'KR' : prefix === 'jp' ? 'JP' : 'CN';
  const hit: StockHit = { code, name: nick ?? code, market, marketLabel: MARKET_LABEL[market], tencent: code };
  const m = /^(sh|sz)(\d{6})$/i.exec(code);
  if (m) {
    const ex = m[1].toLowerCase();
    hit.sina = ex + m[2];
    hit.secid = (ex === 'sh' ? '1.' : '0.') + m[2];
  }
  return hit;
}

/** 从 hash 路由里读取 ?code=xxx（不依赖 location 的查询字段） */
function useCodeParam(): string {
  const loc = useLocation();
  return useMemo(() => {
    const s = (loc.search || '').replace(/^\?/, '');
    for (const part of s.split('&')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i) === 'code') return decodeURIComponent(part.slice(i + 1));
    }
    return '';
  }, [loc.search]);
}

export default function MomentumPage() {
  const { settings, btCfg, ensureKlines, registerStock } = useApp();
  const navigate = useNavigate();
  const codeParam = useCodeParam();
  const [p, setP] = useState<MomParams>(DEFAULT_MOM);
  const [pool, setPool] = useState<StockHit[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [showDrop, setShowDrop] = useState(false);
  const [ing, setIng] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  // 全球个股搜索（与个股分析页同一套 /api/suggest 建议源）
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!query.trim()) {
      setHits([]);
      setIng(false);
      return;
    }
    setIng(true);
    debounce.current = setTimeout(async () => {
      try {
        setHits(await searchStocks(query.trim(), 12));
      } catch {
        setHits([]);
      }
      setIng(false);
    }, 300);
    return () => clearTimeout(debounce.current);
  }, [query]);

  const pick = (hit: StockHit) => {
    registerStock(hit);
    setQuery(hit.name);
    setShowDrop(false);
    navigate('/momentum?code=' + encodeURIComponent(hit.code));
  };


  // 标的池：基准指数 + 自选 + 最近访问
  useEffect(() => {
    const seen = new Set<string>();
    const list: StockHit[] = [];
    const push = (h: StockHit) => {
      if (!h || !h.code || seen.has(h.code)) return;
      seen.add(h.code);
      list.push(h);
    };
    const bench = getSymbol(settings.benchmark);
    if (bench) {
      push({ code: bench.code, name: bench.name, market: bench.market, marketLabel: MARKET_LABEL[bench.market] });
    }
    loadWatchlist().forEach(push);
    loadRecent().forEach(push);
    setPool(list);
  }, [settings.benchmark]);

  const code = codeParam || settings.benchmark;

  // URL 带 code 时，把自选里记录的完整命中注册进 AppContext（含各源映射）
  useEffect(() => {
    if (!codeParam || getSymbol(codeParam)) return;
    const hit = resolveHit(codeParam);
    if (hit) registerStock(hit);
  }, [codeParam, registerStock]);

  const ensureRef = useRef(ensureKlines);
  ensureRef.current = ensureKlines;

  useEffect(() => {
    if (!code) return;
    const hit = getSymbol(code) ? undefined : resolveHit(code);
    if (hit) registerStock(hit);
    const builtin = !!getSymbol(code);
    const t = setTimeout(() => {
      ensureRef.current([code], { allowDemo: builtin });
    }, 60);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const st = useKline(code);
  const sym = getSymbol(code);
  const hit = pool.find((x) => x.code === code) ?? resolveHit(code);
  const name = sym?.name ?? hit?.name ?? code;
  const marketLabel = sym ? MARKET_LABEL[sym.market] : hit?.marketLabel ?? '';

  const set = (k: keyof MomParams, v: number) => setP((cur) => ({ ...cur, [k]: v }));

  const onPick = (v: string) => {
    navigate('/momentum?code=' + encodeURIComponent(v));
  };

  const ready = !!st && !st.loading && !st.failed && st.bars.length >= 300;

  const report = useMemo(() => {
    if (!ready || !st) return null;
    return buildMomentumReport(st.bars, p, btCfg);
  }, [ready, st, p, btCfg]);

  const options = useMemo(() => {
    const seen = new Set<string>();
    const opts: { value: string; label: string }[] = [];
    const push = (v: string, label: string) => {
      if (seen.has(v)) return;
      seen.add(v);
      opts.push({ value: v, label });
    };
    // 当前标的必须排在首位，保证受控 select 的 value 一定能命中
    push(code, name + '（' + (marketLabel || code) + '）');
    const b = getSymbol(settings.benchmark);
    push(settings.benchmark, '基准指数 · ' + (b?.name ?? settings.benchmark));
    for (const h of pool) push(h.code, h.name + '（' + h.marketLabel + '）');
    return opts;
  }, [pool, settings.benchmark, code, name, marketLabel]);

  return (
    <div>
      <div className="page-title-row" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <h2>🚀 动能动量策略</h2>
        <span className="en">Time-Series Momentum</span>
        <button
          type="button"
          id="ai-assistant-jump"
          className="chip-toggle"
          style={{ marginLeft: 'auto' }}
          onClick={() => {
            const el = document.getElementById('ai-assistant');
            if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }}
        >
          🤖 AI 助手
        </button>
      </div>
      <p className="page-lead">
        动量效应：过去涨得多的标的，短期内倾向继续跑赢。策略取「回看窗口累计收益」作为信号，跳过最近几日以规避短期反转；
        用滞后带降低换手，用长均线过滤下跌趋势，再按目标波动率缩放仓位，波动放大时自动减仓。
        既能跑指数，也能对个股做单标的动量择时（个股不使用任何模拟数据）。
      </p>

      <ControlBar>
        <CtrlGroup label="标的">
          <Select label="分析对象" value={code} options={options} onChange={onPick} />
        </CtrlGroup>
        <CtrlGroup label="搜索全球个股">
          <div style={{ position: 'relative' }}>
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowDrop(true);
              }}
              onFocus={() => hits.length > 0 && setShowDrop(true)}
              onBlur={() => setTimeout(() => setShowDrop(false), 200)}
              placeholder="茅台 / 600519 / AAPL / 00700 / 005930"
              style={{ width: 260, border: '1px solid var(--border-strong)', borderRadius: 8, padding: '7px 10px', fontSize: 13, outline: 'none', background: 'var(--panel-2)', color: 'var(--text)' }}
            />
            {ing && <span style={{ position: 'absolute', right: 8, top: 8, fontSize: 11, color: 'var(--text-3)' }}>搜索中…</span>}
            {showDrop && hits.length > 0 && (
              <div className="-pop">
                {hits.map((h) => (
                  <div key={h.code} className="-item" onMouseDown={() => pick(h)}>
                    <span className="badge info">{h.marketLabel}</span>
                    <b>{h.name}</b>
                    <span className="code">{h.code}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CtrlGroup>
        <CtrlGroup label="热门">
          {HOT.map((h) => (
            <button key={h.code} type="button" className="chip-toggle" onClick={() => pick(h)}>
              {h.name}
            </button>
          ))}
        </CtrlGroup>
        <CtrlGroup label="信号">
          <Select label="回看" value={String(p.lookback)} options={LOOKBACKS} onChange={(v) => set('lookback', Number(v))} />
          <Select label="跳过" value={String(p.skip)} options={SKIPS} onChange={(v) => set('skip', Number(v))} />
          <Select label="趋势过滤" value={String(p.maLen)} options={MAS} onChange={(v) => set('maLen', Number(v))} />
        </CtrlGroup>
        <CtrlGroup label="阈值">
          <Slider label="开仓" value={p.entry} min={-0.05} max={0.1} step={0.01} onChange={(v) => set('entry', v)} fmt={(v) => fmtPct(v, 0)} />
          <Slider label="平仓" value={p.exit} min={-0.1} max={0.05} step={0.01} onChange={(v) => set('exit', v)} fmt={(v) => fmtPct(v, 0)} />
        </CtrlGroup>
        <CtrlGroup label="风险">
          <Slider label="目标波动" value={p.targetVol} min={0} max={0.35} step={0.01} onChange={(v) => set('targetVol', v)} fmt={(v) => (v <= 0 ? '关闭' : fmtPct(v, 0))} />
          <Slider label="仓位上限" value={p.cap} min={0.2} max={1} step={0.1} onChange={(v) => set('cap', v)} fmt={(v) => fmtPct(v, 0)} />
        </CtrlGroup>
      </ControlBar>

      <p className="page-lead" style={{ marginTop: -4 }} data-target-code={code}>
        当前标的：<b>{name}</b>（{code}{marketLabel ? ' · ' + marketLabel : ''}）
        {!sym && <span style={{ color: 'var(--text-3)' }}> · 个股实时数据，无模拟兜底</span>}
      </p>

      {!ready && st?.loading && <Loading text="正在拉取行情…" />}
      {!ready && !st?.loading && st?.failed && (
        <EmptyTip text={'实时行情源全部失败（已尝试：' + ((st.attempts ?? []).join(' / ') || '无') + '），个股不使用模拟数据，请稍后重试或更换标的'} />
      )}
      {!ready && !st?.loading && !st?.failed && (
        <EmptyTip text="该标的可用行情不足（需至少 300 个交易日），请换流动性更好的指数或个股" />
      )}

      {report && st && (
        <>
          <Panel
            title="信号总览"
            icon="🎯"
            desc={report.dates[0] + ' ~ ' + report.dates[report.dates.length - 1] + ' · 共 ' + report.dates.length + ' 个交易日'}
            extra={<SourcePill source={st.source} cacheTs={st.cacheTs} />}
          >
            <div style={{ marginBottom: 10 }}>
              <SignalBadge
                tone={report.verdict === 'bull' ? 'bull' : report.verdict === 'bear' ? 'bear' : 'flat'}
                text={report.verdictText}
              />
            </div>
            <MetricGrid
              items={[
                { label: '动量强度分', value: report.score.toFixed(0), sub: '0~100，50 为中性', tone: report.score >= 60 ? 'up' : report.score <= 40 ? 'down' : 'flat' },
                { label: '当前仓位', value: fmtPct(report.currentPos, 0), sub: report.held ? '信号持有中' : '空仓', tone: report.held ? 'up' : 'flat' },
                { label: '区间动量', value: fmtPct(report.raw), sub: '回看 ' + p.lookback + ' 日，跳过 ' + p.skip + ' 日', tone: report.raw >= 0 ? 'up' : 'down' },
                { label: '年化波动', value: fmtPct(report.vol), sub: '近 20 日已实现', tone: 'flat' },
                { label: '平均仓位', value: fmtPct(report.exposure, 0), sub: '样本内时间加权', tone: 'flat' },
                { label: '开仓次数', value: String(report.tradeCount), sub: '空仓转持仓', tone: 'flat' }
              ]}
            />
          </Panel>

          <Panel title="策略净值 vs 买入持有" icon="📈" desc="已扣双边手续费与卖出印花税">
            <EChart
              option={lineOption(
                report.dates,
                [
                  { name: '动量策略', data: report.bt.equity, color: C.up, lineWidth: 2 },
                  { name: '买入持有', data: report.bt.benchmark, color: C.accent, dashed: true }
                ],
                { yName: '净值' }
              )}
              height={320}
            />
            <MetricGrid
              items={[
                { label: '总收益', value: fmtPct(report.bt.metrics.totalReturn), tone: report.bt.metrics.totalReturn >= 0 ? 'up' : 'down' },
                { label: '年化', value: fmtPct(report.bt.metrics.cagr), tone: report.bt.metrics.cagr >= 0 ? 'up' : 'down' },
                { label: '夏普', value: report.bt.metrics.sharpe.toFixed(2), tone: report.bt.metrics.sharpe >= 1 ? 'up' : 'flat' },
                { label: '最大回撤', value: fmtPct(-report.bt.metrics.maxDD), tone: 'down' },
                { label: '卡玛', value: report.bt.metrics.calmar.toFixed(2), tone: 'flat' },
                { label: '胜率', value: fmtPct(report.bt.metrics.winRate, 1), tone: 'flat' }
              ]}
            />
          </Panel>

          <div className="grid-2">
            <Panel title="分周期动量" icon="⏱" desc="同一天往回看不同窗口的累计涨幅（未跳过）">
              <div className="tbl-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>窗口</th>
                      <th className="num">区间收益</th>
                      <th className="num">年化</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.windows.map((w) => (
                      <tr key={w.label}>
                        <td>{w.label}</td>
                        <td className="num" style={{ color: w.ret >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(w.ret)}</td>
                        <td className="num" style={{ color: w.ann >= 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(w.ann)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="仓位与动量" icon="🌊" desc="仓位（面积）与区间动量（虚线，右轴）">
              <EChart
                option={lineOption(
                  report.dates,
                  [
                    { name: '目标仓位', data: report.positions, color: C.cyan, area: true, lineWidth: 1.6 },
                    { name: '区间动量', data: report.momSeries, color: C.orange, dashed: true, yAxisIndex: 1, lineWidth: 1.4 }
                  ],
                  { pct: true, yName: '仓位', rightName: '动量' }
                )}
                height={280}
              />
            </Panel>
          </div>

          <ActionPanel report={report} params={p} />

          <div id="ai-assistant" style={{ scrollMarginTop: 12 }}>
            <AiPanel
              code={code}
              name={name}
              marketLabel={marketLabel}
              source={st.source}
              report={report}
              plan={buildActionPlan(report, p)}
              params={p}
              onParams={setP}
              onSymbol={onPick}
            />
          </div>

          <MathPanel>
            <p><b>1. 时序动量</b>：r = P(t-s) / P(t-s-L) - 1，L 为回看窗口、s 为跳过天数。跳过最近 s 日是因为短期存在反转效应，会削弱动量信号。</p>
            <p><b>2. 滞后带</b>：r 大于 entry 才开仓，r 小于 exit 才平仓，entry 大于 exit 构成死区。信号在死区内保持原状态，可显著压低换手与手续费磨损。</p>
            <p><b>3. 趋势过滤</b>：仅当价格站上 n 日均线时才允许做多，避免在长期下跌趋势里接刀。</p>
            <p><b>4. 波动率目标</b>：w = min(cap, 目标波动 / 近 20 日已实现年化波动)。波动翻倍则仓位减半，使风险预算大致恒定。</p>
            <p><b>5. 强度分</b>：score = 50 + 50·tanh(r / (波动·√(L/252)))，把动量按波动标准化后压到 0~100，便于跨标的比较。</p>
          </MathPanel>
        </>
      )}
    </div>
  );
}
