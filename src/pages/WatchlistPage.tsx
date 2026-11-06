/**
 * 自选池 · 批量体检
 * 一次性对自选标的跑趋势法评分，按行动分档展示；个股严格禁止模拟数据。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CtrlGroup, EmptyTip, Panel, SourcePill, fmtPct } from '../components/ui';
import { useApp } from '../hooks/AppContext';
import { searchStocks, type StockHit } from '../data/search';
import { addWatchlist, loadWatchlist, MAX_WATCH, removeWatchlist, saveWatchlist } from '../data/watchlist';
import { analyzeTrend } from '../pipelines/trend';

const PRESETS: StockHit[] = [
  { code: 'sh600519', name: '贵州茅台', market: 'CN', marketLabel: 'A股', tencent: 'sh600519', sina: 'sh600519', secid: '1.600519' },
  { code: 'hk00700', name: '腾讯控股', market: 'HK', marketLabel: '港股', tencent: 'hk00700' },
  { code: 'usAAPL', name: '苹果', market: 'US', marketLabel: '美股', sina: 'AAPL', yahoo: 'AAPL' },
  { code: 'usNVDA', name: '英伟达', market: 'US', marketLabel: '美股', sina: 'NVDA', yahoo: 'NVDA' },
  { code: 'kr005930', name: '三星电子', market: 'KR', marketLabel: '韩股', naver: '005930' }
];

const ACTION_COLOR: Record<string, string> = {
  buy: 'var(--up)',
  hold: 'var(--up)',
  wait: 'var(--amber)',
  reduce: 'var(--orange)',
  sell: 'var(--down)'
};

const STARS = (n: number) => {
  const v = Math.max(0, Math.min(5, Math.round(n)));
  return '★'.repeat(v) + '☆'.repeat(5 - v);
};

export default function WatchlistPage() {
  const navigate = useNavigate();
  const { klines, ensureKlines, invalidateKline, registerStock } = useApp();
  const [items, setItems] = useState<StockHit[]>(() => loadWatchlist());
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [showDrop, setShowDrop] = useState(false);
  const [ing, setIng] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout>>();

  // 始终指向最新的取数函数：setTimeout 里用旧闭包会拿不到刚注册的个股
  const ensureRef = useRef(ensureKlines);
  ensureRef.current = ensureKlines;

  const itemsKey = items.map((i) => i.code).join(',');

  useEffect(() => {
    saveWatchlist(items);
    items.forEach(registerStock);
    if (!itemsKey) return;
    const t = setTimeout(() => ensureRef.current(itemsKey.split(','), { allowDemo: false }), 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey]);

  // 搜索添加
  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (!q.trim()) {
      setHits([]);
      return;
    }
    setIng(true);
    debounce.current = setTimeout(async () => {
      const r = await searchStocks(q, 12);
      setHits(r);
      setIng(false);
      setShowDrop(true);
    }, 300);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [q]);

  const add = (hit: StockHit) => {
    registerStock(hit);
    setItems((list) => addWatchlist(list, hit));
    setQ('');
    setShowDrop(false);
  };

  const rows = useMemo(
    () =>
      items.map((it) => {
        const st = klines[it.code];
        const bars = st && !st.loading && !st.failed && st.bars.length >= 60 ? st.bars : null;
        const trend = bars ? analyzeTrend(bars) : null;
        const last = st?.bars[st.bars.length - 1];
        const prev = st?.bars[st.bars.length - 2];
        return {
          hit: it,
          st,
          trend,
          price: last?.close ?? null,
          chg: last && prev ? last.close / prev.close - 1 : null
        };
      }),
    [items, klines]
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { buy: 0, hold: 0, wait: 0, reduce: 0, sell: 0 };
    for (const r of rows) if (r.trend) c[r.trend.strategy.action] = (c[r.trend.strategy.action] ?? 0) + 1;
    return c;
  }, [rows]);

  const rerunAll = () => {
    const codes = items.map((i) => i.code);
    if (!codes.length) return;
    codes.forEach(invalidateKline);
    setTimeout(() => ensureRef.current(codes, { allowDemo: false }), 80);
  };

  return (
    <div>
      <div className="page-title-row">
        <h2>⭐ 自选池 · 批量体检</h2>
        <span className="en">Watchlist · Batch Checkup</span>
      </div>
      <p className="page-lead">
        把关注的标的放进自选池，<b>一次性跑完趋势法五维评分</b>，按「买入 / 持股 / 观望 / 减持 / 卖出」分档排列。
        个股行情<b>只用真实数据</b>：任一标的取数失败会单独标记，可用重试按钮恢复。
      </p>

      <div className="control-bar" style={{ alignItems: 'flex-start' }}>
        <div className="watch-add">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onFocus={() => hits.length > 0 && setShowDrop(true)}
            onBlur={() => setTimeout(() => setShowDrop(false), 200)}
            placeholder={`搜索并加入自选（最多 ${MAX_WATCH} 只），如：茅台 / 00700 / AAPL`}
            style={{
              border: '1px solid var(--border-strong)',
              borderRadius: 8,
              padding: '9px 12px',
              fontSize: 13.5,
              outline: 'none',
              background: 'var(--panel-2)',
              color: 'var(--text)'
            }}
          />
          {ing && <span style={{ position: 'absolute', right: 12, top: 10, fontSize: 12, color: 'var(--text-3)' }}>搜索中…</span>}
          {showDrop && hits.length > 0 && (
            <div className="search-pop">
              {hits.map((h) => (
                <div key={h.code} className="search-item" onMouseDown={() => add(h)}>
                  <span className="badge info">{h.marketLabel}</span>
                  <b>{h.name}</b>
                  <span className="code">{h.code}</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <CtrlGroup label="快捷加入">
          {PRESETS.map((h) => (
            <button key={h.code} type="button" className="chip-toggle" onClick={() => add(h)}>
              {h.name}
            </button>
          ))}
        </CtrlGroup>
        <div className="watch-actions">
          <button type="button" className="gear-btn" onClick={rerunAll}>
            🔄 全部重跑
          </button>
          <button type="button" className="gear-btn" onClick={() => setItems([])}>
            🗑 清空
          </button>
        </div>
      </div>

      {items.length === 0 && <EmptyTip text="自选池还是空的：搜索个股，或点上方快捷按钮加入" />}

      {items.length > 0 && (
        <Panel
          title="自选体检表"
          icon="📋"
          desc={`共 ${items.length} 只 · 买入 ${counts.buy ?? 0} · 持股 ${counts.hold ?? 0} · 观望 ${counts.wait ?? 0} · 减持 ${counts.reduce ?? 0} · 卖出 ${counts.sell ?? 0}`}
        >
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>市场</th>
                  <th className="num">现价</th>
                  <th className="num">日涨跌</th>
                  <th className="num">趋势评分</th>
                  <th>操作策略</th>
                  <th>信号强度</th>
                  <th>数据源</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const action = r.trend?.strategy.action;
                  return (
                    <tr
                      key={r.hit.code}
                      className="watch-row"
                      onClick={() => navigate('/stock?code=' + encodeURIComponent(r.hit.code))}
                    >
                      <td>
                        <b>{r.hit.name}</b>
                        <span style={{ color: 'var(--text-3)', fontSize: 11.5, marginLeft: 6 }}>{r.hit.code}</span>
                      </td>
                      <td>
                        <span className="badge info">{r.hit.marketLabel}</span>
                      </td>
                      <td className="num">{r.price != null ? r.price.toFixed(2) : '—'}</td>
                      <td className="num" style={{ color: r.chg == null ? 'var(--text-3)' : r.chg >= 0 ? 'var(--up)' : 'var(--down)' }}>
                        {r.chg != null ? fmtPct(r.chg) : '—'}
                      </td>
                      <td className="num">
                        {r.trend ? (
                          <span
                            className="watch-score"
                            style={{ color: r.trend.score >= 58 ? 'var(--up)' : r.trend.score <= 42 ? 'var(--down)' : 'var(--text-2)' }}
                          >
                            {r.trend.score}
                          </span>
                        ) : r.st?.failed ? (
                          <span style={{ color: 'var(--down)', fontSize: 12 }}>取数失败</span>
                        ) : (
                          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>加载中…</span>
                        )}
                      </td>
                      <td style={{ color: action ? ACTION_COLOR[action] : 'var(--text-3)', fontWeight: 700 }}>
                        {r.trend ? `${r.trend.strategy.actionIcon} ${r.trend.strategy.actionLabel}` : '—'}
                      </td>
                      <td style={{ color: 'var(--text-2)', fontSize: 12 }}>{r.trend ? STARS(r.trend.strategy.stars) : '—'}</td>
                      <td>
                        {r.st && !r.st.loading ? (
                          <SourcePill source={r.st.source} cacheTs={r.st.cacheTs} />
                        ) : (
                          <span style={{ color: 'var(--text-3)', fontSize: 12 }}>…</span>
                        )}
                      </td>
                      <td onClick={(e) => e.stopPropagation()}>
                        <button
                          type="button"
                          className="gear-btn"
                          style={{ marginRight: 6, padding: '2px 8px' }}
                          onClick={() => navigate('/stock?code=' + encodeURIComponent(r.hit.code))}
                        >
                          分析
                        </button>
                        {r.st?.failed && (
                          <button
                            type="button"
                            className="gear-btn"
                            style={{ marginRight: 6, padding: '2px 8px' }}
                            onClick={() => {
                              invalidateKline(r.hit.code);
                              setTimeout(() => ensureRef.current([r.hit.code], { allowDemo: false }), 80);
                            }}
                          >
                            重试
                          </button>
                        )}
                        <button
                          type="button"
                          className="gear-btn"
                          style={{ padding: '2px 8px' }}
                          onClick={() => setItems((list) => removeWatchlist(list, r.hit.code))}
                        >
                          移除
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Panel>
      )}
    </div>
  );
}
