import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useParams } from 'react-router-dom';
import EChart from '../components/EChart';
import { C, barOption, lineOption } from '../components/chartOptions';
import { CtrlGroup, EmptyTip, Loading, MetricGrid, Panel } from '../components/ui';
import { useApp } from '../hooks/AppContext';
import { searchStocks, type StockHit } from '../data/search';
import { getSymbol, MARKET_LABEL, type Market } from '../data/symbols';
import { loadRecent, loadWatchlist } from '../data/watchlist';
import { canFetchIntraday, fetchIntraday, type IntradaySnapshot } from '../data/intraday';
import { DEFAULT_T0_CONFIG, analyzeT0, type T0Config } from '../math/t0';

const HOT: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', secid: '1.600519' },
  { code: 'sz000001', name: '平安银行', market: 'CN', marketLabel: 'A股', secid: '0.000001' },
  { code: 'sh601318', name: '中国平安', market: 'CN', marketLabel: 'A股', secid: '1.601318' },
  { code: 'hk00700', name: '腾讯控股', market: 'HK', marketLabel: '港股' }
];

export default function TPage() {
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
  const [cfg, setCfg] = useState<T0Config>(DEFAULT_T0_CONFIG);
  const [day, setDay] = useState<IntradaySnapshot | null>(null);
  const [dayLoading, setDayLoading] = useState(false);
  const [dayErr, setDayErr] = useState<string | null>(null);
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

  // 深链
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
    const market: Market = prefix === 'hk' ? 'HK' : prefix === 'us' ? 'US' : 'CN';
    pick({ code: codeParam, name: codeParam, market, marketLabel: MARKET_LABEL[market] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codeParam, picked]);

  // 日 K（做波动空间基准）
  useEffect(() => {
    if (picked) ensureKlines([picked.code], { allowDemo: false });
  }, [picked, ensureKlines]);

  // 分时
  useEffect(() => {
    setDay(null);
    setDayErr(null);
    if (!picked) return;
    if (!canFetchIntraday(picked.code)) {
      setDayErr('该市场暂无分时数据（腾讯分时覆盖 A 股与港股）');
      return;
    }
    let alive = true;
    setDayLoading(true);
    fetchIntraday(picked.code)
      .then((d) => {
        if (!alive) return;
        setDay(d);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setDayErr(e instanceof Error ? e.message : '分时获取失败');
      })
      .finally(() => {
        if (alive) setDayLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [picked]);

  const st = picked ? klines[picked.code] : undefined;
  const bars = st && !st.loading && !st.failed && st.bars.length >= 60 ? st.bars : null;
  const a = useMemo(() => (bars && day ? analyzeT0(bars, day, cfg) : null), [bars, day, cfg]);

  const minuteOpt = useMemo(() => {
    if (!day) return null;
    return lineOption(
      day.points.map((p) => p.time),
      [
        { name: '价格', data: day.points.map((p) => p.price), color: C.accent, lineWidth: 2 },
        { name: '分时均价 VWAP', data: day.points.map((p) => p.vwap), color: C.orange, lineWidth: 1.5 }
      ],
      { yName: '价' }
    );
  }, [day]);

  const rangeOpt = useMemo(() => {
    if (!a) return null;
    return barOption(
      a.ranges.map((_, i) => `T-${a.ranges.length - i}`),
      [{ name: '当日振幅', data: a.ranges, color: C.cyan }],
      { unit: '%', digits: 2 }
    );
  }, [a]);

  // 「不适合」是信息不足/空间不够，不是看空，用中性灰；观望用琥珀提醒；正 T 红、倒 T 蓝
  const verdictColor =
    a?.verdict === '不适合' ? 'var(--text-3)' : a?.verdict === '观望' ? 'var(--amber)' : a?.verdict === '正T' ? 'var(--up)' : 'var(--accent)';

  const setNum = (key: keyof T0Config, v: string, scale = 1) => {
    const n = Number(v);
    setCfg((c) => ({ ...c, [key]: Number.isFinite(n) && n >= 0 ? n / scale : 0 }));
  };

  return (
    <div>
      <div className="page-title-row">
        <h2>🔁 做 T 分析</h2>
        <span className="en">Intraday T+0 Rotation</span>
      </div>
      <p className="page-lead">
        A 股是 <b>T+1</b>，当天买的不能当天卖。做 T 的前提是<b>已有底仓</b>：低吸后卖掉等量老仓（正 T），
        或高抛老仓后低位买回（倒 T），收盘股数不变、只赚价差。这一页用<b>分时均价 + 历史振幅 + 真实交易成本</b>
        判断今天有没有空间、够不够手续费、该做哪个方向。
      </p>

      <div className="control-bar" style={{ alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ position: 'relative', flex: 1, minWidth: 260 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => hits.length > 0 && setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 200)}
            placeholder="输入 A 股 / 港股名称或代码，如：茅台 / 00700"
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
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          <label className="t0-field">
            <span>底仓股数</span>
            <input type="number" min="0" step="100" value={cfg.baseShares} onChange={(e) => setNum('baseShares', e.target.value)} />
          </label>
          <label className="t0-field">
            <span>做 T 比例（%）</span>
            <input type="number" min="0" max="100" step="5" value={Math.round(cfg.tRatio * 100)} onChange={(e) => setNum('tRatio', e.target.value, 100)} />
          </label>
          <label className="t0-field">
            <span>佣金（‱）</span>
            <input type="number" min="0" step="0.5" value={Number((cfg.commission * 10000).toFixed(2))} onChange={(e) => setNum('commission', e.target.value, 10000)} />
          </label>
          <label className="t0-field">
            <span>单笔最低佣金（元）</span>
            <input type="number" min="0" step="1" value={cfg.minCommission} onChange={(e) => setNum('minCommission', e.target.value)} />
          </label>
          <label className="t0-field">
            <span>印花税（‰，仅卖出）</span>
            <input type="number" min="0" step="0.1" value={Number((cfg.stampTax * 1000).toFixed(2))} onChange={(e) => setNum('stampTax', e.target.value, 1000)} />
          </label>
          <span className="inst-hint" style={{ paddingBottom: 6 }}>
            过户费率 {cfg.transferFee.toFixed(5)}（双边，沪深统收）
          </span>
        </div>
      </div>

      {!picked && <EmptyTip text="搜索或点击上方热门标的，开始做 T 分析" />}
      {picked && st?.loading && <Loading text={`正在拉取 ${picked.name} 日 K…`} />}
      {picked && st?.failed && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 暂不可达</div>
          <div className="panel-desc">
            {picked.name} 的行情获取失败（{st.attempts?.length ? st.attempts.join(' → ') : '全部可用源'}）。
            本站不用模拟数据冒充真实行情；分时与成本分析仍可查看，但缺少近 20 日振幅基准。
          </div>
        </div>
      )}
      {picked && dayLoading && <Loading text="正在拉取分时数据…" />}
      {picked && !dayLoading && dayErr && <div className="panel notice"><div className="panel-title">⚠️ {dayErr}</div></div>}

      {picked && day && !bars && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 不足 60 根</div>
          <div className="panel-desc">无法计算近 20 日振幅基准，做 T 空间判断不可用。分时走势与成本仍可查看。</div>
        </div>
      )}

      {picked && day && a && (
        <>
          {/* 判定卡 */}
          <div className="panel" style={{ borderWidth: 2, borderColor: verdictColor, background: `color-mix(in srgb, ${verdictColor} 8%, var(--panel))` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 34, fontWeight: 900, color: verdictColor, whiteSpace: 'nowrap' }}>{a.verdict}</div>
              <div>
                <div style={{ fontSize: 15, fontWeight: 700 }}>做 T 适宜度 {a.score} / 100</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>
                  {day.name} · {picked.code} · 分时日期 {day.date.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3')} · 来源：腾讯分时
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 280, fontSize: 13, lineHeight: 1.8 }}>{a.verdictNote}</div>
            </div>
          </div>

          <Panel title="📋 判定依据" icon="📋" desc="先说结论怎么来的：波动空间、成本、方向三件事">
            <div className="news-brief">
              {a.lines.map((l, i) => (
                <p key={i}><span className="nb-dot" />{l}</p>
              ))}
            </div>
            <MetricGrid
              items={[
                { label: '现价', value: a.last.toFixed(2), tone: a.pct > 0 ? 'up' : a.pct < 0 ? 'down' : 'flat', sub: `${a.pct >= 0 ? '+' : ''}${a.pct.toFixed(2)}%` },
                { label: '昨收', value: a.prevClose.toFixed(2) },
                { label: '分时均价 VWAP', value: a.vwap.toFixed(2), sub: `偏离 ${a.vwapDev >= 0 ? '+' : ''}${a.vwapDev.toFixed(2)}%` },
                { label: '日内高 / 低', value: `${a.high.toFixed(2)} / ${a.low.toFixed(2)}` },
                { label: '已走振幅', value: `${a.dayRange.toFixed(2)}%` },
                { label: '20 日均振幅', value: `${a.avgRange20.toFixed(2)}%` },
                { label: '理论剩余空间', value: `${a.remaining.toFixed(2)}%`, tone: a.remaining > a.minSpreadPct * 2 ? 'up' : 'flat' },
                { label: '盈亏平衡价差', value: `${a.minSpreadPct.toFixed(3)}%`, sub: `每股 ${a.costPerShare.toFixed(3)} 元` }
              ]}
            />
          </Panel>

          {/* 两腿计划 */}
          {a.plan ? (
            <Panel title={`${a.plan.direction} 操作计划`} icon="🎯" desc={`做 T 数量 ${a.shares} 股（底仓 ${cfg.baseShares} 股 × ${Math.round(cfg.tRatio * 100)}%，向下取整到 100 股）`}>
              <div className="grid-2">
                <div className="t0-leg">
                  <div className="t0-leg-title">① {a.plan.firstLabel}</div>
                  <div className="t0-leg-price">{a.plan.first[0].toFixed(2)} ~ {a.plan.first[1].toFixed(2)}</div>
                  <div className="inst-hint">价格落进区间再动手；不到位就放弃，不追。</div>
                </div>
                <div className="t0-leg">
                  <div className="t0-leg-title">② {a.plan.secondLabel}</div>
                  <div className="t0-leg-price">{a.plan.second[0].toFixed(2)} ~ {a.plan.second[1].toFixed(2)}</div>
                  <div className="inst-hint">两腿成交后收盘股数不变，才算完成一次做 T。</div>
                </div>
              </div>
              <div className="inst-hint" style={{ marginTop: 10 }}>{a.plan.note}</div>
            </Panel>
          ) : (
            <Panel title="操作计划" icon="🎯" desc="当前判定下不建议动手">
              <EmptyTip text={`${a.verdict}：${a.verdictNote}`} />
            </Panel>
          )}

          {/* 成本表 */}
          <Panel title="💸 交易成本台账" icon="💸" desc="一次完整往返（买 + 卖）按现行费率计算，含最低佣金">
            <div className="tbl-wrap">
              <table className="tbl">
                <tbody>
                  <tr><td style={{ color: 'var(--text-3)', width: 200 }}>佣金（双边）</td><td className="num">2 × max(成交额 × {(cfg.commission * 10000).toFixed(2)}‱, {cfg.minCommission} 元)</td></tr>
                  <tr><td style={{ color: 'var(--text-3)' }}>印花税（卖出）</td><td className="num">成交额 × {(cfg.stampTax * 1000).toFixed(2)}‰</td></tr>
                  <tr><td style={{ color: 'var(--text-3)' }}>过户费（双边）</td><td className="num">成交额 × {(cfg.transferFee * 100).toFixed(3)}% × 2</td></tr>
                  <tr><td style={{ color: 'var(--text-3)' }}>合计费用</td><td className="num"><b>{a.costAmount.toFixed(1)} 元</b>（费率约 {a.minSpreadPct.toFixed(3)}%）</td></tr>
                  <tr><td style={{ color: 'var(--text-3)' }}>每股盈亏平衡价差</td><td className="num"><b>{a.costPerShare.toFixed(3)} 元</b></td></tr>
                  <tr><td style={{ color: 'var(--text-3)' }}>收益量级参考</td><td className="num">毛 {a.expectedGross.toFixed(0)} 元 → 净 {a.expectedNet >= 0 ? '+' : ''}{a.expectedNet.toFixed(0)} 元</td></tr>
                </tbody>
              </table>
            </div>
          </Panel>

          {/* 图表 */}
          <div className="grid-2">
            <Panel title="分时走势与均价线" icon="📈" desc="价格在均价上方偏倒 T、下方偏正 T；偏离越远，回归空间越大">
              {minuteOpt && <EChart option={minuteOpt} height={320} />}
            </Panel>
            <Panel title="近 20 日振幅分布（%）" icon="📊" desc="振幅太小（低于盈亏平衡价差的 2 倍）做 T 就是给券商打工">
              {rangeOpt && <EChart option={rangeOpt} height={320} />}
            </Panel>
          </div>

          <Panel title="⚠️ 规则与风险（务必先读）" icon="⚠️">
            <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li><b>T+1 与底仓</b>：当天买入的股票不能当天卖。正 T 卖的是昨日老仓；倒 T 先卖的也是老仓。没有底仓就无法做 T。</li>
                <li><b>数量约束</b>：两腿必须等量，且 ≤ 底仓；本页自动向下取整到 100 股。做反了会变成真加仓或真减仓。</li>
                <li><b>价差必须覆盖成本</b>：佣金有最低 5 元，小资金做 T 会被最低佣金吃掉利润；本页已按实际金额计算。</li>
                <li><b>分时数据的边界</b>：非交易时段返回最近交易日；腾讯分时覆盖 A 股与港股，美股/日韩暂不支持。</li>
                <li><b>估算 ≠ 可成交</b>：日 K 不含日内路径，本页用「分时均价 + 已实现振幅」做当下判断，不提供历史胜率回测；区间只是参考位，不是一定会到的价格。</li>
                <li><b>单边行情别做 T</b>：大涨容易踏空、大跌容易接飞刀，此时观望往往优于操作。</li>
              </ul>
              <p style={{ marginBottom: 0, marginTop: 10 }}>以上均为规则与测算，<b>不构成投资建议</b>。</p>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
