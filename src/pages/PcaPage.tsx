import { useMemo, useState } from 'react';
import EChart from '../components/EChart';
import BacktestPanel from '../components/BacktestPanel';
import { ControlBar, CtrlGroup, ChipMulti, EmptyTip, Loading, MathPanel, Panel, Select, Slider } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { C, heatmapOption, lineOption } from '../components/chartOptions';
import { useApp, useKlines } from '../hooks/AppContext';
import { BASKET_PRESETS, PCA_DEFAULT, PCA_POOL, SYMBOLS } from '../data/symbols';
import { runPcaModel } from '../pipelines';

const POOL = PCA_POOL;

export default function PcaPage() {
  const { btCfg } = useApp();
  const [selected, setSelected] = useState<string[]>(PCA_DEFAULT);
  const [activePreset, setActivePreset] = useState('cn-industry');
  const [K, setK] = useState(3);
  const [window, setWindow] = useState(20);
  const [entry, setEntry] = useState(1.5);
  const [focus, setFocus] = useState(PCA_DEFAULT[0]);

  const klines = useKlines(selected);
  const ready = selected.length >= 3 && selected.every((c) => klines[c] && !klines[c].loading && klines[c].bars.length >= 130);

  // 篮子预设切换（港股龙头 24 只一次性拉取）
  const applyPreset = (key: string) => {
    const preset = BASKET_PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setActivePreset(key);
    setSelected(preset.codes);
    setFocus(preset.codes[0]);
  };

  const run = useMemo(() => {
    if (!ready) return null;
    const barsMap: Record<string, typeof klines[string]['bars']> = {};
    for (const c of selected) barsMap[c] = klines[c].bars;
    const names = Object.fromEntries(SYMBOLS.map((s) => [s.code, s.name]));
    return runPcaModel(barsMap, names, selected, K, window, entry, 0.5, btCfg);
  }, [ready, selected, K, window, entry, klines, btCfg]);

  const toggle = (code: string) => {
    setActivePreset('');
    setSelected((s) => (s.includes(code) ? s.filter((x) => x !== code) : s.length < 24 ? [...s, code] : s));
  };

  const loadingAny = selected.some((c) => klines[c]?.loading);
  const presetDesc = BASKET_PRESETS.find((p) => p.key === activePreset)?.desc;

  return (
    <div>
      <div className="page-title-row">
        <h2>🧬 PCA 因子模型 · 高维统计套利</h2>
        <span className="en">Principal Component Analysis · Residual Arbitrage</span>
      </div>
      <p className="page-lead">
        把整个资产篮子视为高维空间：对标准化收益矩阵做<b>协方差 Jacobi 特征分解</b>，提取前 K 个主成分（市场共同因子），
        剩余<b>残差</b>即特异性收益。对残差 z-score 做均值回归：残差显著高于历史 → 做空，显著低于 → 做多，组合保持市场中性。
        内置六个篮子预设：<b>A股行业</b>（10 行业 ETF）、<b>港股龙头</b>（26 只 × 7 板块）、<b>美股行业</b>（11 只 SPDR 行业 ETF）、
        <b>美股风格</b>（纳指/标普/道指）、<b>韩国龙头</b>（14 只 × 7 板块）、<b>跨市场混合</b>（宏观因子结构）。
      </p>

      <ControlBar>
        <CtrlGroup label="篮子预设">
          {BASKET_PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              className={'chip-toggle' + (activePreset === p.key ? ' on' : '')}
              onClick={() => applyPreset(p.key)}
              title={p.desc}
            >
              {p.label}
            </button>
          ))}
        </CtrlGroup>
        <CtrlGroup label="成分">
          <ChipMulti options={POOL.map((s) => ({ value: s.code, label: s.name }))} selected={selected} onToggle={toggle} />
        </CtrlGroup>
        <CtrlGroup label="模型">
          <Slider label="主成分 K" value={K} min={1} max={5} step={1} onChange={setK} fmt={(v) => `${v}`} />
          <Slider label="回归窗口" value={window} min={10} max={60} step={5} onChange={setWindow} fmt={(v) => `${v}日`} />
          <Slider label="进入阈值 z" value={entry} min={1} max={3} step={0.25} onChange={setEntry} fmt={(v) => v.toFixed(2)} />
        </CtrlGroup>
      </ControlBar>
      {presetDesc && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', margin: '-6px 0 14px', lineHeight: 1.7 }}>📌 {presetDesc}</div>
      )}

      {loadingAny && <Loading text="正在拉取 ETF 行情…" />}
      {!loadingAny && !run && <EmptyTip text="请选择至少 3 个行业 ETF" />}

      {run && (
        <>
          <div className="grid-2">
            <Panel title="Scree 图：特征值与累计解释方差" icon="📊" desc="前 K 个主成分捕获了篮子多少共同波动">
              <EChart
                option={{
                  tooltip: { trigger: 'axis' },
                  legend: { top: 0, textStyle: { color: C.text, fontSize: 11 } },
                  grid: { left: 50, right: 20, top: 32, bottom: 28 },
                  xAxis: { type: 'category', data: run.names, axisLabel: { color: C.text, fontSize: 10, rotate: 32 } },
                  yAxis: [
                    { type: 'value', name: '特征值', axisLabel: { color: C.text, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } } },
                    { type: 'value', name: '累计', axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => `${(v * 100).toFixed(0)}%` }, splitLine: { show: false } }
                  ],
                  series: [
                    { name: '特征值', type: 'bar', data: run.eigenvalues, itemStyle: { color: C.accent, borderRadius: 3 } },
                    {
                      name: '累计解释方差',
                      type: 'line',
                      yAxisIndex: 1,
                      data: run.explained.reduce<number[]>((acc, v) => {
                        acc.push((acc[acc.length - 1] ?? 0) + v);
                        return acc;
                      }, []),
                      itemStyle: { color: C.orange }
                    }
                  ]
                }}
                height={300}
              />
            </Panel>
            <Panel title="因子载荷热力图" icon="🔥" desc="各 ETF 在主成分上的暴露（行=资产，列=因子）">
              <EChart
                option={heatmapOption(
                  Array.from({ length: K }, (_, j) => `PC${j + 1}`),
                  run.names,
                  run.loadings.flatMap((row, i) => row.map((v, j) => [j, i, v] as [number, number, number])),
                  { min: -1, max: 1, name: '载荷', labelFmt: (v) => v.toFixed(2) }
                )}
                height={300}
              />
            </Panel>
          </div>

          <Panel
            title="残差 z-score 时序"
            icon="📉"
            desc={`选定资产残差相对过去 ${window} 日均值的标准化偏离；|z| > ${entry} 触发反向建仓，|z| < 0.5 离场`}
            extra={
              <Select
                label="资产"
                value={focus}
                onChange={setFocus}
                options={selected.map((c) => ({ value: c, label: SYMBOLS.find((s) => s.code === c)?.name ?? c }))}
              />
            }
          >
            <EChart
              option={lineOption(
                run.dates,
                [
                  {
                    name: '残差 z-score',
                    data: run.dates.map((_, t) => run.zscores[t]?.[selected.indexOf(focus)] ?? null),
                    color: C.accent,
                    area: true
                  },
                  { name: `+${entry} 进入`, data: run.dates.map(() => entry), color: C.down, dashed: true },
                  { name: `-${entry} 进入`, data: run.dates.map(() => -entry), color: C.up, dashed: true },
                  { name: '0.5 离场', data: run.dates.map(() => 0.5), color: C.gray, dashed: true },
                  { name: '-0.5 离场', data: run.dates.map(() => -0.5), color: C.gray, dashed: true }
                ],
                { yName: 'z-score' }
              )}
              height={300}
            />
          </Panel>

          <div className="grid-2">
            <Panel title="组合暴露信号" icon="🧭" desc="多头权重合计 − 空头权重合计（全篮子汇总）">
              <EChart
                option={lineOption(
                  run.dates,
                  [{ name: '多空暴露', data: run.composite, color: C.purple, area: true }],
                  { yName: '暴露' }
                )}
                height={240}
              />
            </Panel>
            <Panel title="在仓资产数" icon="🎯" desc="任一时刻持有非零仓位的资产数量">
              <EChart
                option={lineOption(
                  run.dates,
                  [{ name: '在仓资产数', data: run.activeCount, color: C.cyan, area: true }],
                  { yName: '数量' }
                )}
                height={240}
              />
            </Panel>
          </div>

          <BacktestPanel result={{ ...btFromPca(run), dates: run.dates }} benchmarkName="等权篮子" />

          <Panel title="📐 数学原理" icon="">
            <MathPanel>
              <pre>{`1. 标准化:    Z_it = (r_it − μ_i) / σ_i
2. 协方差:    Σ = ZᵀZ / (T−1)          （n×n，n = 资产数）
3. 特征分解:  Σ = V Λ Vᵀ               （Jacobi 循环旋转）
4. 因子得分:  F_t = V_kᵀ·Z_t           （前 K 个主成分）
5. 残差:      e_t = Z_t − V_k·F_t      （剥离市场共同因子）
6. 交易信号:  z_it = (e_it − mean_20(e_i)) / std_20(e_i)
   z > +entry → 做空（相对篮子高估）;  z < −entry → 做多;  |z| < 0.5 → 平仓
7. 组合:      w_t = pos_t / Σ|pos_t|   （多空归一，市场中性）`}</pre>
              <p>
                残差均值回归的直觉：共同因子解释不了的「特异性收益」不应持续偏离，
                偏离越远，回归力量越强。该策略收益来源是<b>截面定价偏差</b>，与大盘方向基本无关（Beta 接近 0）。
              </p>
            </MathPanel>
          </Panel>

          <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页模型指标交给 AI 解读，只读不改任何设置">
            <AiAnalyze
              module="PCA 统计套利"
              note="组合为市场中性残差均值回归；解释度为主成分累计方差占比。"
              facts={[
                { label: '资产数', value: String(run.names.length) },
                { label: '主成分数 K', value: String(run.explained.length) },
                { label: '前 3 主成分解释度', value: run.explained.slice(0, 3).map((v) => (v * 100).toFixed(1) + '%').join(' / ') },
                { label: '当前活跃配对数', value: String(run.activeCount[run.activeCount.length - 1] ?? 0) },
                { label: '策略总收益', value: (run.metrics.totalReturn * 100).toFixed(2) + '%' },
                { label: '夏普', value: run.metrics.sharpe.toFixed(2) },
                { label: '最大回撤', value: (run.metrics.maxDD * 100).toFixed(2) + '%' },
                { label: '基准总收益', value: (run.benchMetrics.totalReturn * 100).toFixed(2) + '%' }
              ]}
            />
          </Panel>
        </>
      )}
    </div>
  );
}

/** 把 PCA 运行结果适配成 BtResult 形状 */
function btFromPca(run: ReturnType<typeof runPcaModel>) {
  return {
    dates: run.dates,
    equity: run.equity,
    benchmark: run.benchEquity,
    positions: new Array(run.equity.length).fill(0),
    rets: run.equity.map((v, i) => (i === 0 ? 0 : v / run.equity[i - 1] - 1)),
    metrics: run.metrics
  };
}
