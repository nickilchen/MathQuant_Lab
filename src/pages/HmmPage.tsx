import { useMemo, useState } from 'react';
import EChart from '../components/EChart';
import BacktestPanel from '../components/BacktestPanel';
import { ControlBar, CtrlGroup, EmptyTip, Loading, MathPanel, MetricGrid, Panel, Select, Slider, fmtPct } from '../components/ui';
import { heatmapOption, lineOption, stateColorOf } from '../components/chartOptions';
import { hmmView } from '../math/hmm';
import { useApp, useKline } from '../hooks/AppContext';
import { runHmmModel } from '../pipelines';
import type { LineSeries } from '../components/chartOptions';

/** 把 Viterbi 路径切成连续状态段，每段一条同色折线 */
function stateSegments(dates: string[], closes: number[], path: number[], labels: string[]): LineSeries[] {
  const series: LineSeries[] = [];
  let t = 0;
  while (t < path.length) {
    const s = path[t];
    let end = t;
    while (end + 1 < path.length && path[end + 1] === s) end++;
    const data: (number | null)[] = new Array(path.length).fill(null);
    for (let k = t; k <= end; k++) data[k] = closes[k];
    series.push({ name: labels[s], data, color: stateColorOf(labels[s]), lineWidth: 1.8 });
    t = end + 1;
  }
  return series;
}

export default function HmmPage() {
  const { settings, btCfg } = useApp();
  const bench = useKline(settings.benchmark);
  const [K, setK] = useState(4);
  const [deadzone, setDeadzone] = useState(0.15);

  const run = useMemo(() => {
    if (!bench || bench.bars.length < 80) return null;
    return runHmmModel(bench.bars, K, deadzone, btCfg);
  }, [bench, K, deadzone, btCfg]);

  if (!bench || bench.loading) return <Loading text="正在拉取行情…" />;
  if (!run) return <EmptyTip text="行情数据不足（至少需要 80 个交易日）" />;

  const { output, dates, closes, positions, bt, stats, currentProbs } = run;
  const labels = output.labels;

  // 最可能状态 = 概率最大的状态（不是平均收益最高的状态）
  const mostLikelyIdx = currentProbs.indexOf(Math.max(...currentProbs));
  // 状态观点 = 滤波概率加权的期望状态漂移（hmmView），比"上涨侧概率"更稳健
  const view = hmmView(output.filtered, output.model.mu);

  // 转移矩阵（按排名重排）
  const transData: [number, number, number][] = [];
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      transData.push([i, j, output.model.A[output.order[i]][output.order[j]]]);
    }
  }

  return (
    <div>
      <div className="page-title-row">
        <h2>🧠 HMM 隐马尔可夫模型 · 市场状态识别</h2>
        <span className="en">Hidden Markov Model · Regime Detection</span>
      </div>
      <p className="page-lead">
        市场存在若干不可直接观测的「隐藏状态」（趋势上涨 / 震荡上涨 / 震荡下跌 / 趋势下跌 / 高波动…），驱动我们观测到的收益率与波动率。
        模型用 <b>Baum-Welch（EM）</b> 反解状态参数，用 <b>Viterbi</b> 解码最可能路径，用<b>前向滤波</b>输出当前处于各状态的概率，
        再将「概率加权的期望状态漂移」映射为仓位。
      </p>

      <ControlBar>
        <CtrlGroup label="模型">
          <Select label="状态数 K" value={K} onChange={setK} options={[2, 3, 4, 5].map((k) => ({ value: k, label: `${k} 状态` }))} />
          <Slider label="死区" value={deadzone} min={0} max={0.4} step={0.05} onChange={setDeadzone} fmt={(v) => v.toFixed(2)} />
        </CtrlGroup>
        <CtrlGroup label="当前判断">
          <span style={{ fontSize: 13 }}>
            最可能状态：<b style={{ color: stateColorOf(labels[mostLikelyIdx]) }}>{labels[mostLikelyIdx]}</b>
            （概率 {((currentProbs[mostLikelyIdx] ?? 0) * 100).toFixed(1)}%）· 状态观点 {view > 0 ? '+' : ''}{view.toFixed(2)}
          </span>
        </CtrlGroup>
      </ControlBar>

      <Panel title="指数走势按市场状态着色" icon="🎨" desc={`${settings.benchmark === 'sh000300' ? '沪深300' : '基准指数'} · Viterbi 解码路径`}>
        <EChart
          option={lineOption(dates, stateSegments(dates, closes, output.path, labels))}
          height={360}
        />
      </Panel>

      <div className="grid-2">
        <Panel title="状态滤波概率（前向算法）" icon="📊" desc="每日收盘时对各状态的后验概率">
          <EChart
            option={lineOption(
              dates,
              output.order.map((stateIdx, rank) => ({
                name: labels[stateIdx],
                data: output.filtered.map((row) => row[stateIdx]),
                stack: 'prob',
                area: true,
                color: stateColorOf(labels[stateIdx])
              })),
              { yName: '概率' }
            )}
            height={300}
          />
        </Panel>
        <Panel title="状态转移矩阵" icon="🔀" desc="A[i][j] = 从状态 i 一步转移到状态 j 的概率">
          <EChart
            option={heatmapOption(labels, labels, transData, { min: 0, max: 1, name: '转移概率', labelFmt: (v) => v.toFixed(2) })}
            height={300}
          />
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="状态画像" icon="🧬" desc="各状态的平均日收益、年化波动与平均持续期">
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>状态</th>
                  <th className="num">出现天数</th>
                  <th className="num">平均日收益</th>
                  <th className="num">年化波动</th>
                  <th className="num">平均持续(日)</th>
                  <th className="num">当前概率</th>
                </tr>
              </thead>
              <tbody>
                {stats
                  .slice()
                  .sort((a, b) => output.order.indexOf(a.state) - output.order.indexOf(b.state))
                  .map((s) => (
                    <tr key={s.state}>
                      <td>
                        <span style={{ color: stateColorOf(s.label), fontWeight: 700 }}>●</span> {s.label}
                      </td>
                      <td className="num">{s.days}</td>
                      <td className="num" style={{ color: s.avgDailyRet > 0 ? 'var(--up)' : 'var(--down)' }}>
                        {fmtPct(s.avgDailyRet, 3)}
                      </td>
                      <td className="num">{fmtPct(s.annVol, 1)}</td>
                      <td className="num">{s.avgDuration.toFixed(1)}</td>
                      <td className="num">{((currentProbs[s.state] ?? 0) * 100).toFixed(1)}%</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Panel>
        <Panel title="模型参数" icon="⚙️" desc="发射分布为各维独立高斯（标准化空间）">
          <MetricGrid
            items={[
              { label: '对数似然', value: output.loglik.toFixed(1) },
              { label: '初始分布 π', value: output.model.pi.map((p) => p.toFixed(2)).join(' / ') },
              { label: '自转移概率', value: output.model.A.map((row, i) => row[i].toFixed(2)).join(' / ') },
              { label: '持仓天数占比', value: fmtPct(positions.filter((p) => p !== 0).length / Math.max(positions.length, 1), 1) }
            ]}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 10, lineHeight: 1.8 }}>
            观测向量 o_t = [对数收益率, 20 日已实现波动率]，两维均做标准化；
            发射概率 b_i(o) = N(o; μ_i, diag(σ²_i))。参数由 EM 迭代至对数似然收敛。
          </div>
        </Panel>
      </div>

      <BacktestPanel result={bt} benchmarkName="基准买入持有" />

      <Panel title="📐 数学原理" icon="">
        <MathPanel>
          <p>
            <b>HMM 五元组</b> λ = (π, A, B)：π 为初始状态分布，A 为转移矩阵，B 为发射概率。
            市场状态 q_t 不可观测，我们只能看到收益率与波动率构成的观测 o_t。
          </p>
          <pre>{`前向变量:  α_t(i) = P(o_1,…,o_t, q_t = i | λ)
递推:      α_t(j) = [ Σ_i α_{t-1}(i)·a_ij ] · b_j(o_t)

Baum-Welch（EM）参数更新:
  π_i     = γ_1(i)
  a_ij    = Σ_t ξ_t(i,j) / Σ_t γ_t(i)
  μ_i     = Σ_t γ_t(i)·o_t / Σ_t γ_t(i)
  σ²_i    = Σ_t γ_t(i)·(o_t − μ_i)² / Σ_t γ_t(i)

其中 γ_t(i) = P(q_t = i | o_1..o_T)，ξ_t(i,j) = P(q_t = i, q_{t+1} = j | o_1..o_T)。
为防数值下溢，前后向算法均按 Rabiner 缩放因子实现。`}</pre>
          <p>
            <b>状态观点与仓位</b>：观点 = Σ_i P(状态_i) · μ_i（滤波概率加权的期望状态漂移，
            按各状态 μ 极差归一化到 [-1,1]）；|观点| 超过死区后作为目标仓位。
            相比「上涨侧概率 − 下跌侧概率」，该口径不受窗口整体涨跌扭曲——
            长牛窗口里排名靠后的状态 μ 也可能接近 0，按概率差换算会给出虚假的极值。
          </p>
          <p style={{ color: 'var(--text-3)' }}>
            <b>状态命名口径</b>：方向带 θ = 0.25×各状态 μ 极差——|μ| ≤ θ 的状态方向不明，
            按波动命名为「高波动 / 窄幅震荡」，而**不**强行叫上涨/下跌
            （典型即高波动状态：μ 接近 0 但波动极大，历史上多伴随急跌急涨）；
            波动带 φ = 0.5×最大状态波动，≥ φ 为高波动。
            各状态的<b>平均日收益与年化波动绝对值</b>见上方「状态画像」表。
          </p>
        </MathPanel>
      </Panel>
    </div>
  );
}
