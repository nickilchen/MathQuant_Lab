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
import { canFetchValuation, fetchQuarterReports, valuationMeta, type QuarterReport } from '../data/valuation';
import { DEFAULT_VALUATION_CONFIG, analyzeValuation, type ValuationConfig, type ValuationMethod } from '../math/valuation';

const HOT: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', secid: '1.600519' },
  { code: 'hk00700', name: '腾讯控股', market: 'HK', marketLabel: '港股' },
  { code: 'usAAPL', name: '苹果', market: 'US', marketLabel: '美股' },
  { code: 'usNVDA', name: '英伟达', market: 'US', marketLabel: '美股' },
  { code: 'jp7203', name: '丰田汽车', market: 'JP', marketLabel: '日股' },
  { code: 'kr005930', name: '三星电子', market: 'KR', marketLabel: '韩股' }
];

const METHOD_LABEL: Record<ValuationMethod, string> = { auto: '自动', pe: 'PE', pb: 'PB' };

export default function ValuationPage() {
  const { klines, ensureKlines, registerStock, settings, update } = useApp();
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
  const [cfg, setCfg] = useState<ValuationConfig>(DEFAULT_VALUATION_CONFIG);
  const [reports, setReports] = useState<QuarterReport[]>([]);
  const [repLoading, setRepLoading] = useState(false);
  const [repErr, setRepErr] = useState<string | null>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>();
  /** 程序化填充搜索框（点热门、深链）时不要触发搜索下拉 */
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
      // 同名时把美股排后：SK海力士同时有 usSKHY（ADR）和 kr000660，
      // ADR 的财报用本币、股价用美元，估值本来就不可用，不该排在第一条。
      //
      // 注意不能用 sort 的比较器直接判「同名 → 美股排后」：同名项之间可能隔着
      // 一个不同名的结果（如港股杠杆 ETF），TimSort 不会跨过去比较，顺序不会变。
      // 先按名称分组，再按「组首次出现的位置」重建。
      const groups = new Map<string, StockHit[]>();
      const order: string[] = [];
      for (const h of r) {
        if (!groups.has(h.name)) {
          groups.set(h.name, []);
          order.push(h.name);
        }
        groups.get(h.name)!.push(h);
      }
      const sorted = order.flatMap((name) => {
        const arr = groups.get(name)!;
        return [...arr.filter((x) => !/^us/i.test(x.code)), ...arr.filter((x) => /^us/i.test(x.code))];
      });
      setHits(sorted);
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
    // 清空候选：深链进入时 query 变化会触发一次搜索，
    // 不清空的话下拉会在参数区上方自动展开，挡住内容
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

  useEffect(() => {
    setReports([]);
    setRepErr(null);
    if (!picked) return;
    if (!canFetchValuation(picked.code)) {
      setRepErr('该标的没有季度财报数据（支持 A 股 / 港股 / 美股 / 日股 / 韩股个股；指数与台股不支持）');
      return;
    }
    let alive = true;
    setRepLoading(true);
    fetchQuarterReports(picked.code)
      .then((r) => {
        if (alive) setReports(r);
      })
      .catch((e: unknown) => {
        if (alive) setRepErr(e instanceof Error ? e.message : '财报获取失败');
      })
      .finally(() => {
        if (alive) setRepLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [picked]);

  const st = picked ? klines[picked.code] : undefined;
  const bars = st && !st.loading && !st.failed && st.bars.length >= 60 ? st.bars : null;
  const meta = picked ? valuationMeta(picked.code) : null;
  const cur = meta?.currency ?? '元';
  const curSym = meta?.currencySymbol ?? '¥';
  const a = useMemo(
    () => (bars && reports.length ? analyzeValuation(reports, bars, { ...cfg, currency: cur }) : null),
    [bars, reports, cfg, cur]
  );

  /** 有价格覆盖的季度数（K 线回看长度决定） */
  const covered = a ? a.history.filter((h) => h.priceAtNotice != null).length : 0;

  const trackOpt = useMemo(() => {
    // 币种不一致时 history 里的 fairPrice 是「本币 EPS × 本币 PE」，
    // 画出来是 300 万美元这种假曲线，不如不画
    if (!a || a.unitMismatch) return null;
    const rows = a.history.filter((h) => h.fairPrice != null && h.priceAtNotice != null).slice(-12);
    if (rows.length < 3) return null;
    return lineOption(
      rows.map((h) => h.period.slice(2)),
      [
        { name: '合理价（当季财报重算）', data: rows.map((h) => h.fairPrice), color: C.orange, lineWidth: 2 },
        { name: '公告后股价', data: rows.map((h) => h.priceAtNotice), color: C.accent, lineWidth: 2 }
      ],
      { yName: curSym }
    );
  }, [a]);

  // 币种不一致不是看多/看空，用中性灰，别让人误以为是「低估」信号
  const verdictColor = a?.unitMismatch
    ? 'var(--text-3)'
    : a?.verdict === '明显低估' || a?.verdict === '偏低估'
      ? 'var(--up)'
      : a?.verdict === '明显高估' || a?.verdict === '偏高估'
        ? 'var(--down)'
        : 'var(--amber)';

  /** 三档价格与现价在同一坐标轴上的真实位置（0~100） */
  const bandMarks = useMemo(() => {
    if (!a || a.low == null || a.high == null || a.fair == null) return null;
    const lo = a.low * 0.9;
    const hi = a.high * 1.1;
    // 留 3% 边距：现价越过区间时标签会贴在轨道边缘，被裁掉一半
    const pos = (v: number) => Math.max(3, Math.min(97, ((v - lo) / Math.max(hi - lo, 1e-9)) * 100));
    return { low: pos(a.low), fair: pos(a.fair), high: pos(a.high), now: pos(a.current) };
  }, [a]);

  return (
    <div>
      <div className="page-title-row">
        <h2>💎 价值估值评断</h2>
        <span className="en">Quarterly Fair Value</span>
      </div>
      <p className="page-lead">
        用<b>每季度财报</b>滚动重算估值：<b>TTM EPS（或 BPS）× 该股自己的历史 PE/PB 中枢</b>，
        得出悲观 / 合理 / 乐观三档具体价格，再和现价相减——直接告诉你<b>低估或高估多少、多少个点</b>。
        覆盖 <b>A 股 / 港股 / 美股 / 日股 / 韩股</b>；新财报一到，分子（业绩）与分母（历史分位）都会更新，合理价随之调整。
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
          <CtrlGroup label="估值口径">
            {(['auto', 'pe', 'pb'] as ValuationMethod[]).map((m) => (
              <button key={m} type="button" className={`chip-toggle${cfg.method === m ? ' on' : ''}`} onClick={() => setCfg((c) => ({ ...c, method: m }))}>
                {METHOD_LABEL[m]}
                {/* 自动模式下直接标出实际用了哪个口径，避免「选了自动却不知道在用 PB」 */}
                {m === 'auto' && cfg.method === 'auto' && a ? ` → ${a.method.toUpperCase()}` : ''}
              </button>
            ))}
          </CtrlGroup>
          <CtrlGroup label="分位窗口">
            {[12, 20, 32].map((w) => (
              <button key={w} type="button" className={`chip-toggle${cfg.window === w ? ' on' : ''}`} onClick={() => setCfg((c) => ({ ...c, window: w }))}>
                {w} 季
              </button>
            ))}
          </CtrlGroup>
          <span className="inst-hint" style={{ color: a ? 'var(--text-2)' : undefined }}>
            {a ? a.methodReason : '自动口径：EPS > 0 且有足够 PE 样本时用 PE，否则回退 PB（亏损股）'}
          </span>
          {meta && (
            <span className="inst-hint" style={{ flexBasis: '100%' }}>
              数据源：<b>{meta.source}</b> · {meta.note}
            </span>
          )}
        </div>
      </div>

      {!picked && <EmptyTip text="搜索或点击上方热门标的，开始估值评断" />}
      {picked && st?.loading && <Loading text={`正在拉取 ${picked.name} 日 K…`} />}
      {picked && st?.failed && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 暂不可达</div>
          <div className="panel-desc">无法取现价与历史股价，估值不可用。本站不用模拟数据冒充真实行情。</div>
        </div>
      )}
      {picked && repLoading && <Loading text="正在拉取季度财报…" />}
      {picked && !repLoading && repErr && <div className="panel notice"><div className="panel-title">⚠️ {repErr}</div></div>}

      {picked && !repLoading && !st?.loading && reports.length > 0 && !bars && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 日 K 不足 60 根</div>
          <div className="panel-desc">无法计算现价与历史分位，请把顶部回看周期调大后重试。</div>
        </div>
      )}

      {picked && a && (
        <>
          {/* 大判定卡 */}
          <div className="panel" style={{ borderWidth: 2, borderColor: verdictColor, background: `color-mix(in srgb, ${verdictColor} 8%, var(--panel))` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 22, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 32, fontWeight: 900, color: verdictColor, whiteSpace: 'nowrap' }}>{a.verdict}</div>
              <div>
                <div style={{ fontSize: 26, fontWeight: 800 }} className="num">
                  合理价 {a.fair != null ? a.fair.toFixed(2) : '—'} {cur}
                </div>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 3 }}>
                  现价 {a.current.toFixed(2)} {cur} · 最新财报 {a.latest.period} · {a.method.toUpperCase()} 口径
                  {a.noticeEstimated ? ' · 公告日为估算' : ''}
                </div>
              </div>
              <div style={{ flex: 1, minWidth: 280, fontSize: 14, lineHeight: 1.9 }}>
                <b style={{ color: verdictColor }}>
                  {a.diff != null
                    ? `${a.verdict === '合理' ? '偏离合理价' : a.diff >= 0 ? '低估' : '高估'} ${Math.abs(a.diff).toFixed(2)} ${cur}（${a.diffPct != null ? Math.abs(a.diffPct).toFixed(2) : '—'}%）`
                    : a.unitMismatch
                      ? '币种/单位不一致'
                      : '样本不足'}
                </b>
                <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>{a.verdictNote}</div>
              </div>
            </div>
          </div>

          {/* 三档价格带 */}
          {a.low != null && a.fair != null && a.high != null && bandMarks != null && (
            <Panel title="🎚️ 三档价格带与现价位置" icon="🎚️" desc="历史 PE/PB 的 25/50/75 分位 × 最新财报，得到悲观 / 合理 / 乐观三档具体股价">
              <div className="val-band">
                <div className="vb-track">
                  <div className="vb-fill" style={{ left: `${Math.min(bandMarks.fair, bandMarks.now)}%`, width: `${Math.abs(bandMarks.now - bandMarks.fair)}%` }} />
                  <span className="vb-mark" style={{ left: `${bandMarks.low}%` }}><i />悲观</span>
                  <span className="vb-mark" style={{ left: `${bandMarks.fair}%` }}><i />合理</span>
                  <span className="vb-mark" style={{ left: `${bandMarks.high}%` }}><i />乐观</span>
                  <span className="vb-now" style={{ left: `${bandMarks.now}%` }}>现价</span>
                </div>
              </div>
              <MetricGrid
                items={[
                  { label: '悲观价（25 分位）', value: `${a.low.toFixed(2)} ${cur}`, sub: `${a.method === 'pe' ? a.peStats?.p25.toFixed(1) : a.pbStats?.p25.toFixed(1)} 倍` },
                  { label: '合理价（中位数）', value: `${a.fair.toFixed(2)} ${cur}`, tone: 'flat', sub: `${a.method === 'pe' ? a.peStats?.p50.toFixed(1) : a.pbStats?.p50.toFixed(1)} 倍` },
                  { label: '乐观价（75 分位）', value: `${a.high.toFixed(2)} ${cur}`, sub: `${a.method === 'pe' ? a.peStats?.p75.toFixed(1) : a.pbStats?.p75.toFixed(1)} 倍` },
                  { label: '现价', value: `${a.current.toFixed(2)} ${cur}`, tone: a.diff != null && a.diff > 0 ? 'up' : 'down' }
                ]}
              />
            </Panel>
          )}

          <Panel title="📋 判定依据" icon="📋" desc="每一步的口径与数字都摆出来，不做黑箱">
            <div className="news-brief">
              {a.lines.map((l, i) => (
                <p key={i}><span className="nb-dot" />{l}</p>
              ))}
            </div>
            {covered < 12 && (
              <div className="inst-hint" style={{ color: 'var(--amber)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span>当前回看 {settings.days} 日，只覆盖 {covered} 个季度的股价，分位样本偏少。</span>
                <button type="button" className="gear-btn" onClick={() => update({ days: 1500 })}>
                  一键调大到 1500 日
                </button>
              </div>
            )}
            <MetricGrid
              items={[
                // 币种不一致时 EPS/BPS 的货币无法确认，标出来只会误导，一律显示 —
                { label: 'TTM EPS', value: !a.unitMismatch && a.ttmEps != null ? `${a.ttmEps.toFixed(2)} ${cur}` : '—' },
                { label: '每股净资产 BPS', value: !a.unitMismatch && a.bps > 0 ? `${a.bps.toFixed(2)} ${cur}` : '—' },
                { label: '当前 PE', value: !a.unitMismatch && a.peNow != null ? `${a.peNow.toFixed(1)} 倍` : '—' },
                { label: '当前 PB', value: !a.unitMismatch && a.pbNow != null ? `${a.pbNow.toFixed(2)} 倍` : '—' },
                { label: 'ROE', value: a.latest.roe != null ? `${a.latest.roe.toFixed(2)}%` : '—' },
                {
                  label: '净利同比',
                  value: a.latest.profitYoY != null ? `${a.latest.profitYoY >= 0 ? '+' : ''}${a.latest.profitYoY.toFixed(2)}%` : '—',
                  tone: a.latest.profitYoY == null ? 'flat' : a.latest.profitYoY >= 0 ? 'up' : 'down'
                },
                { label: '营收同比', value: a.latest.revenueYoY != null ? `${a.latest.revenueYoY >= 0 ? '+' : ''}${a.latest.revenueYoY.toFixed(2)}%` : '—' },
                { label: '毛利率', value: a.latest.grossMargin != null ? `${a.latest.grossMargin.toFixed(2)}%` : '—' }
              ]}
            />
          </Panel>

          {/* 估值轨迹 */}
          {trackOpt && (
            <Panel title="📈 每季度重算的合理价 vs 当日股价" icon="📈" desc="最近 12 个季度；扩张窗口算合理价，每个点只用当时已公告的财报与之前的分位，不偷看未来">
              <EChart option={trackOpt} height={340} />
            </Panel>
          )}

          {/* 逐季表格：币种不一致时整张表都是错量级，直接不给 */}
          {!a.unitMismatch && (
          <Panel title="🗓️ 逐季估值台账" icon="🗓️" desc="最近 16 个季度：财报一到，TTM EPS 变、合理价变、与股价的偏离也变">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>报告期</th><th>公告日</th><th>TTM EPS</th><th>当时 PE</th><th>合理价</th><th>公告后股价</th><th>偏离</th>
                  </tr>
                </thead>
                <tbody>
                  {a.history.slice(-16).reverse().map((h) => (
                    <tr key={h.period}>
                      <td>{h.period}</td>
                      <td>{h.noticeDate}{a.noticeEstimated ? <span title="按披露期限估算"> *</span> : null}</td>
                      <td className="num">{h.ttmEps != null ? h.ttmEps.toFixed(2) : '—'}</td>
                      <td className="num">{h.pe != null ? h.pe.toFixed(1) : '—'}</td>
                      <td className="num">{h.fairPrice != null ? h.fairPrice.toFixed(2) : '—'}</td>
                      <td className="num">{h.priceAtNotice != null ? h.priceAtNotice.toFixed(2) : '—'}</td>
                      <td className="num" style={{ color: h.deviation == null ? 'var(--text-3)' : h.deviation > 0 ? 'var(--up)' : 'var(--down)' }}>
                        {h.deviation != null ? `${h.deviation >= 0 ? '+' : ''}${h.deviation.toFixed(1)}%` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>
          )}

          <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页估值指标交给 AI 解读，只读不改任何设置">
            <AiAnalyze
              module="价值估值评断"
              symbol={picked?.name}
              note="本页为相对估值：合理价 = TTM EPS（或 BPS）× 该股自身历史 PE/PB 中枢，非绝对内在价值。"
              facts={[
                { label: '判定', value: a.verdict },
                { label: '估值方法', value: a.method === 'pe' ? 'PE' : a.method === 'pb' ? 'PB' : '自动' + (a.methodReason ? '（' + a.methodReason + '）' : '') },
                { label: '现价', value: a.current.toFixed(2) },
                { label: '合理价', value: a.fair != null ? a.fair.toFixed(2) : '—' },
                { label: '悲观 / 乐观价', value: (a.low != null ? a.low.toFixed(2) : '—') + ' / ' + (a.high != null ? a.high.toFixed(2) : '—') },
                { label: '现价相对合理价偏离', value: a.diffPct != null ? a.diffPct.toFixed(2) + '%' : '—' },
                { label: 'TTM EPS', value: a.ttmEps == null ? '—' : a.ttmEps.toFixed(2) },
                { label: '每股净资产 BPS', value: a.bps > 0 ? a.bps.toFixed(2) : '—' },
                { label: '当前 PE / PB', value: (a.peNow == null ? '—' : a.peNow.toFixed(1)) + ' / ' + (a.pbNow == null ? '—' : a.pbNow.toFixed(1)) },
                ...(a.latest ? [{ label: '最新季 ROE / 净利同比', value: (a.latest.roe == null ? '—' : a.latest.roe.toFixed(1) + '%') + ' / ' + (a.latest.profitYoY == null ? '—' : a.latest.profitYoY.toFixed(1) + '%') }] : [])
              ]}
            />
          </Panel>

          <Panel title="⚠️ 口径与局限（务必先读）" icon="⚠️">
            <div style={{ fontSize: 13, lineHeight: 2.1, color: 'var(--text-2)' }}>
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                <li><b>两种 TTM 口径</b>：A 股财报是年初至今累计，TTM 用「本期 + 上年全年 − 上年同期」差分；港股 / 美股 / 日股 / 韩股的数据源直接给单季值，TTM = 最近 4 季相加。两者不能混用，页面已按市场自动选择。</li>
                <li><b>防前视偏差</b>：历史 PE 用的是<b>公告日之后</b>第一个交易日的收盘价，绝不用还没公布的财报去配当期股价。</li>
                <li><b>「实时」的含义</b>：不是逐笔行情实时，而是<b>每季新财报发布后</b>自动用最新 TTM EPS/BPS 重算合理价；现价随日 K 更新。</li>
                <li><b>分位需要长历史</b>：K 线回看长度决定能覆盖多少个季度。样本少于 12 季时结论可靠性下降，页面会提示调大回看周期。</li>
                <li><b>不适用情形</b>：亏损股自动回退 PB；强周期、金融、资产重组、一次性损益大的公司，历史 PE/PB 中枢本身就会失真。</li>
                <li><b>覆盖市场</b>：A 股（东财）、港股 / 美股 / 日股 / 韩股（StockAnalysis 季度财报）。海外源只提供 EPS 与每股净资产，ROE、同比、毛利率显示「—」；公告日按披露期限保守估算（季报 +60 天、年报 +100 天），表中带 * 号。</li>
                <li><b>货币不同</b>：各市场按本币计算，A 股元、港股港元、美股美元、日股日元、韩股韩元；跨市场比较请先换算汇率。</li>
              </ul>
              <p style={{ marginBottom: 0, marginTop: 10 }}>历史分位不等于内在价值，本页是<b>相对估值</b>工具，不构成投资建议。</p>
            </div>
          </Panel>
        </>
      )}
    </div>
  );
}
