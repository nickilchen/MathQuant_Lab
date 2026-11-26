/**
 * 多标的对比：归一化净值、相关性矩阵、相对强弱、同期信号
 * 跨市场交易日不同 → 一律按日期交集对齐后再计算。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import EChart from '../components/EChart';
import { EmptyTip, Loading, MetricGrid, Panel, fmtPct } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { C, lineOption } from '../components/chartOptions';
import { useApp } from '../hooks/AppContext';
import { MARKET_LABEL, SYMBOLS } from '../data/symbols';
import type { SymbolDef } from '../data/types';
import { loadWatchlist } from '../data/watchlist';
import type { StockHit } from '../data/search';
import { alignByDate, correlationMatrix, normalizeToBase, relativeStrength } from '../math/compare';
import { analyzeTrend } from '../pipelines/trend';

const PALETTE = [C.up, C.accent, C.cyan, C.purple, C.orange];
const MAX = 4;

function toHit(s: SymbolDef): StockHit {
  return {
    code: s.code,
    name: s.name,
    market: s.market,
    marketLabel: MARKET_LABEL[s.market],
    secid: s.secid || undefined,
    sina: s.sina,
    naver: s.naver,
    yahoo: s.yahoo
  };
}

function defaultSelection(watch: StockHit[]): string[] {
  if (watch.length >= 2) return watch.slice(0, 3).map((w) => w.code);
  const pref = ['sh000300', 'hkHSI', 'usINX'].filter((c) => SYMBOLS.some((s) => s.code === c));
  if (pref.length >= 2) return pref;
  return SYMBOLS.filter((s) => s.kind === 'index').slice(0, 3).map((s) => s.code);
}

export default function ComparePage() {
  const { klines, ensureKlines, registerStock } = useApp();
  const [selected, setSelected] = useState<string[]>(() => defaultSelection(loadWatchlist()));
  const ensureRef = useRef(ensureKlines);
  ensureRef.current = ensureKlines;

  const pool = useMemo<StockHit[]>(() => {
    const watch = loadWatchlist();
    const seen = new Set(watch.map((w) => w.code));
    const indices = SYMBOLS.filter((s) => s.kind === 'index').map(toHit);
    return [...watch, ...indices.filter((i) => !seen.has(i.code))];
  }, []);

  // 先把自选里的动态个股注册进源链，再延迟取数（等 extraSymbols 提交）
  const selectedKey = selected.join(',');
  useEffect(() => {
    loadWatchlist().forEach(registerStock);
    if (!selectedKey) return;
    const t = setTimeout(() => ensureRef.current(selectedKey.split(','), { allowDemo: true }), 80);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey, registerStock]);

  const toggle = (code: string) => {
    setSelected((cur) => {
      if (cur.includes(code)) return cur.filter((c) => c !== code);
      if (cur.length >= MAX) return cur;
      return [...cur, code];
    });
  };

  const ready = selected
    .map((code) => pool.find((p) => p.code === code))
    .filter((x): x is StockHit => !!x)
    .filter((it) => (klines[it.code]?.bars.length ?? 0) >= 60);

  const loadingAny = selected.some((c) => klines[c]?.loading);
  const failedCodes = selected.filter((c) => klines[c]?.failed);

  const aligned = alignByDate(ready.map((it) => ({ code: it.code, bars: klines[it.code]?.bars ?? [] })));
  const norm = aligned.series.map((s) => normalizeToBase(s.closes));
  const corr = aligned.series.length >= 2 ? correlationMatrix(aligned.series.map((s) => s.closes)) : [];
  const chartSeries = aligned.series.map((s, i) => ({
    name: ready[i]?.name ?? s.code,
    data: norm[i] ?? [],
    color: PALETTE[i % PALETTE.length],
    lineWidth: 2
  }));

  const periodReturn = (i: number): number | null => {
    const s = norm[i];
    return s && s.length > 0 ? s[s.length - 1] - 1 : null;
  };
  const rsLast = (i: number): number | null => {
    if (i === 0 || !aligned.series[i] || !aligned.series[0]) return null;
    const rs = relativeStrength(aligned.series[0].closes, aligned.series[i].closes);
    return rs.length ? rs[rs.length - 1] - 1 : null;
  };

  return (
    <div>
      <div className="page-title-row">
        <h2>🆚 多标的对比</h2>
        <span className="en">Multi-Asset Comparison</span>
      </div>
      <p className="page-lead">
        最多选 <b>{MAX} 个标的</b>，按<b>共同交易日</b>对齐后比较：归一化净值（起点=1）、日收益率相关性矩阵、相对强弱。
        跨市场交易日不同，若按下标硬对齐会把不同日期错配，所以这里一律按日期求交集。
      </p>

      <Panel title="选择标的" icon="🎛" desc={`已选 ${selected.length}/${MAX} · 自选池标的优先，其后是各市场指数`}>
        <div className="cmp-chips">
          {pool.slice(0, 24).map((h) => {
            const on = selected.includes(h.code);
            return (
              <button
                key={h.code}
                type="button"
                className={'chip-toggle' + (on ? ' on' : '')}
                onClick={() => toggle(h.code)}
                title={`${h.name} · ${h.code}`}
              >
                {h.name}
                {on ? ' ✓' : ''}
              </button>
            );
          })}
        </div>
      </Panel>

      {selected.length < 2 && <EmptyTip text="至少选择 2 个标的才能对比" />}
      {selected.length >= 2 && ready.length < 2 && loadingAny && <Loading text="正在拉取所选标的行情…" />}
      {selected.length >= 2 && ready.length < 2 && !loadingAny && (
        <EmptyTip text="所选标的可用行情不足（需至少 60 个交易日），请换一组或先到个股分析确认数据源" />
      )}
      {failedCodes.length > 0 && (
        <div className="panel notice">
          <div className="panel-title">⚠️ 部分标的取数失败</div>
          <div className="panel-desc" style={{ color: 'inherit' }}>
            {failedCodes.join('、')} 的行情暂不可达（个股分析不使用模拟数据），已从对比中排除。
          </div>
        </div>
      )}

      {ready.length >= 2 && aligned.dates.length > 0 && (
        <>
          <Panel
            title="归一化净值对比"
            icon="📈"
            desc={`共同交易日 ${aligned.dates.length} 天 · ${aligned.dates[0]} ~ ${aligned.dates[aligned.dates.length - 1]} · 起点 = 1`}
          >
            <EChart option={lineOption(aligned.dates, chartSeries)} height={340} />
            <div className="cmp-legend">
              {ready.map((it, i) => (
                <span key={it.code}>
                  <i style={{ background: PALETTE[i % PALETTE.length] }} />
                  {it.name} 同期 {periodReturn(i) != null ? fmtPct(periodReturn(i)!) : '—'}
                </span>
              ))}
            </div>
          </Panel>

          <div className="grid-2">
            <Panel title="相关系数矩阵" icon="🧮" desc="基于日收益率（价格水平相关性是伪相关）">
              <div className="tbl-wrap">
                <table className="tbl cmp-matrix">
                  <thead>
                    <tr>
                      <th>—</th>
                      {ready.map((it) => (
                        <th key={it.code}>{it.name}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {ready.map((row, i) => (
                      <tr key={row.code}>
                        <td style={{ fontWeight: 700 }}>{row.name}</td>
                        {ready.map((col, j) => {
                          const v = corr[i]?.[j] ?? 0;
                          return (
                            <td
                              key={col.code}
                              className={i === j ? 'self' : undefined}
                              style={{
                                color: i === j ? 'var(--text-3)' : v >= 0.6 ? 'var(--up)' : v <= -0.3 ? 'var(--down)' : 'var(--text-2)',
                                fontWeight: i === j ? 400 : 700
                              }}
                            >
                              {v.toFixed(2)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel title="相对强弱与同期信号" icon="⚖️" desc={`以 ${ready[0].name} 为基准；RS > 0 表示跑赢`}>
              <MetricGrid
                items={ready.map((it, i) => ({
                  label: it.name,
                  value: periodReturn(i) != null ? fmtPct(periodReturn(i)!) : '—',
                  sub: i === 0 ? '对比基准' : `相对强弱 ${rsLast(i) != null ? fmtPct(rsLast(i)!) : '—'}`,
                  tone: (periodReturn(i) ?? 0) >= 0 ? 'up' : 'down'
                }))}
              />
              <div className="tbl-wrap" style={{ marginTop: 12 }}>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>标的</th>
                      <th className="num">趋势评分</th>
                      <th>操作策略</th>
                      <th className="num">ADX</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ready.map((it) => {
                      const bars = klines[it.code]?.bars ?? [];
                      const t = bars.length >= 60 ? analyzeTrend(bars) : null;
                      return (
                        <tr key={it.code}>
                          <td style={{ fontWeight: 600 }}>{it.name}</td>
                          <td className="num">{t ? t.score : '—'}</td>
                          <td
                            style={{
                              color: t ? (t.strategy.action === 'sell' || t.strategy.action === 'reduce' ? 'var(--down)' : 'var(--up)') : 'var(--text-3)',
                              fontWeight: 700
                            }}
                          >
                            {t ? `${t.strategy.actionIcon} ${t.strategy.actionLabel}` : '—'}
                          </td>
                          <td className="num">{t ? t.adx.toFixed(0) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Panel>
          </div>

          <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页多标的对比结果交给 AI 解读，只读不改任何设置">
            <AiAnalyze
              module="多标的对比"
              note="按共同交易日对齐、起点归一到 1；相对强弱以第一只标的为基准。"
              facts={[
                { label: '对比标的数', value: String(ready.length) },
                { label: '标的列表', value: ready.map((it) => it.name).join('、') },
                { label: '共同交易日', value: aligned.dates.length + ' 天（' + aligned.dates[0] + ' ~ ' + aligned.dates[aligned.dates.length - 1] + '）' },
                ...ready.map((it, i) => ({
                  label: it.name + ' 同期收益',
                  value: periodReturn(i) != null ? (periodReturn(i)! * 100).toFixed(2) + '%' + (i > 0 && rsLast(i) != null ? '（相对强弱 ' + (rsLast(i)! * 100).toFixed(2) + '%）' : '') : '—'
                })),
                ...(corr.length >= 2 ? [{ label: '首两标的收益相关性', value: corr[0]?.[1] != null ? corr[0][1].toFixed(3) : '—' }] : [])
              ]}
            />
          </Panel>
        </>
      )}
    </div>
  );
}
