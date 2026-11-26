import { useEffect, useMemo, useState } from 'react';
import EChart from '../components/EChart';
import BacktestPanel from '../components/BacktestPanel';
import { ControlBar, CtrlGroup, EmptyTip, Loading, MathPanel, MetricGrid, Panel, Slider } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { C, gaugeOption, lineOption, radarOption } from '../components/chartOptions';
import { useApp, useKline } from '../hooks/AppContext';
import { BOND_ETF, bondRefFor, getSymbol } from '../data/symbols';
import { runFactorModel } from '../pipelines';
import type { Dim } from '../math/factors';

/** 维度→颜色：读取时取值，避免模块加载时把旧主题色固化下来 */
const dimColor = (d: Dim) => ({ 估值: C.purple, 情绪: C.amber, 资金: C.cyan, 技术: C.accent }[d]);
const DIMS: Dim[] = ['估值', '情绪', '资金', '技术'];

export default function FactorPage() {
  const { settings, btCfg, extras, ensureExtras } = useApp();
  const bench = useKline(settings.benchmark);
  const bond = useKline(BOND_ETF);
  const [weights, setWeights] = useState<Record<Dim, number>>({ 估值: 0.25, 情绪: 0.25, 资金: 0.25, 技术: 0.25 });
  const [threshold, setThreshold] = useState(0.15);

  const fundFlow = extras[settings.benchmark]?.fundFlow ?? null;
  const extrasLoading = extras[settings.benchmark]?.loading ?? false;
  // 仅 A 股基准使用国债 ETF 作为股债性价比参考；境外基准该因子自动剔除
  const bondRef = bondRefFor(getSymbol(settings.benchmark)?.market ?? 'CN', bond?.bars);
  const isCN = getSymbol(settings.benchmark)?.market === 'CN';

  // 资金流/估值快照属于副作用，放到 effect 里触发，避免渲染期更新 AppProvider
  useEffect(() => {
    ensureExtras(settings.benchmark);
  }, [ensureExtras, settings.benchmark]);

  const run = useMemo(() => {
    if (!bench || bench.bars.length < 120) return null;
    return runFactorModel(bench.bars, fundFlow, bondRef, weights, threshold, btCfg);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bench, bond, fundFlow, bondRef, weights, threshold, btCfg]);

  if (!bench || bench.loading) return <Loading text="正在拉取行情…" />;
  if (!run) return <EmptyTip text="行情数据不足（至少需要 120 个交易日）" />;

  const { report, signal, signalHistory, bt, dates, closes } = run;

  return (
    <div>
      <div className="page-title-row">
        <h2>🗳️ 多维度因子投票 · 市场择时</h2>
        <span className="en">Multi-Dimensional Factor Voting</span>
      </div>
      <p className="page-lead">
        从<b>估值、情绪、资金、技术</b>四个维度构建 {report.values.length > 0 ? report.values.length : 16} 个底层因子，
        每个因子按「历史分位 / z 分数」映射为 [-1, +1] 的投票，先合成子维度得分，再加权合成为统一的多空信号 S。
        S &gt; 阈值做多，S &lt; −阈值做空，中间空仓。
      </p>

      <ControlBar>
        <CtrlGroup label="维度权重">
          {DIMS.map((d) => (
            <Slider
              key={d}
              label={d}
              value={weights[d]}
              min={0}
              max={0.6}
              step={0.05}
              onChange={(v) => setWeights((w) => ({ ...w, [d]: v }))}
              fmt={(v) => v.toFixed(2)}
            />
          ))}
        </CtrlGroup>
        <CtrlGroup label="信号">
          <Slider label="开仓阈值" value={threshold} min={0.05} max={0.4} step={0.05} onChange={setThreshold} fmt={(v) => v.toFixed(2)} />
          <span style={{ fontSize: 13 }}>
            当前信号：<b style={{ color: signal > 0 ? 'var(--up)' : signal < 0 ? 'var(--down)' : 'var(--text-2)' }}>
              {signal > 0 ? '+' : ''}{signal.toFixed(3)}
            </b>
          </span>
        </CtrlGroup>
      </ControlBar>

      <div className="grid-2">
        <Panel title="四维得分雷达" icon="🕸" desc="子维度得分 ∈ [-1, +1]">
          <EChart
            option={radarOption(
              DIMS.map((d) => ({ name: d, max: 1 })),
              [{ name: '维度得分', value: DIMS.map((d) => report.dims.find((x) => x.dim === d)?.score ?? 0), color: C.accent }]
            )}
            height={300}
          />
          <MetricGrid
            items={DIMS.map((d) => {
              const ds = report.dims.find((x) => x.dim === d);
              return {
                label: d,
                value: (ds?.score ?? 0).toFixed(3),
                sub: `${ds?.count ?? 0} 个因子`,
                tone: (ds?.score ?? 0) > 0.05 ? ('up' as const) : (ds?.score ?? 0) < -0.05 ? ('down' as const) : ('flat' as const)
              };
            })}
          />
        </Panel>
        <Panel title="综合信号 S ∈ [-1, +1]" icon="🎚" desc="加权合成后的市场多空观点">
          <EChart option={gaugeOption(signal, '综合信号')} height={280} />
          <div style={{ textAlign: 'center', fontSize: 12, color: 'var(--text-2)', marginTop: -6 }}>
            {signal > threshold ? '看多' : signal < -threshold ? '看空' : '中性 / 空仓'} ·
            开仓阈值 ±{threshold.toFixed(2)}
          </div>
        </Panel>
      </div>

      <Panel title="信号时序与指数走势" icon="📈" desc="信号为每 5 日用当时可见数据重算（无未来函数）">
        <EChart
          option={lineOption(
            dates,
            [
              { name: '综合信号', data: signalHistory, color: C.accent, area: true, yAxisIndex: 0 },
              { name: '基准指数', data: closes, color: C.gray, yAxisIndex: 1 }
            ],
            { yName: '信号', rightName: '指数' }
          )}
          height={300}
        />
      </Panel>

      <Panel
        title="因子明细"
        icon="🔬"
        desc={
          isCN
            ? fundFlow
              ? '资金维度使用东财主力资金流数据'
              : '资金维度暂不可用（资金流接口未返回），已自动剔除'
            : '境外市场：主力资金流与国债参考不可用，已自动剔除；部分指数无成交量数据时，量价类因子同样自动剔除'
        }
        extra={extrasLoading ? <span style={{ fontSize: 11, color: 'var(--text-3)' }}>资金流加载中…</span> : undefined}
      >
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>维度</th>
                <th>因子</th>
                <th className="num">当前值</th>
                <th className="num">历史位置</th>
                <th className="num">投票</th>
                <th>说明</th>
              </tr>
            </thead>
            <tbody>
              {report.values.map((v) => (
                <tr key={v.def.id}>
                  <td>
                    <span style={{ color: dimColor(v.def.dim), fontWeight: 600 }}>{v.def.dim}</span>
                  </td>
                  <td>{v.def.name}</td>
                  <td className="num">{v.raw.toFixed(3)}</td>
                  <td className="num">{v.def.mode === 'pct' ? `P${(v.stat * 100).toFixed(0)}` : `z=${v.stat.toFixed(2)}`}</td>
                  <td>
                    <span className={`vote-chip ${v.vote > 0.05 ? 'pos' : v.vote < -0.05 ? 'neg' : 'zero'}`}>
                      {v.vote > 0 ? '+' : ''}{v.vote.toFixed(2)}
                    </span>
                  </td>
                  <td style={{ color: 'var(--text-3)', whiteSpace: 'normal', minWidth: 200 }}>{v.def.desc}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <BacktestPanel result={bt} />

      <Panel title="📐 数学原理" icon="">
        <MathPanel>
          <p>
            <b>投票映射</b>：对每个因子计算当前值与其历史序列的关系——
          </p>
          <pre>{`分位数模式:  vote = dir · (2·pct − 1),   pct = rank(当前值, 历史)
z 分数模式:  vote = dir · tanh(z / 1.5),  z = (当前值 − 均值) / 标准差

子维度得分:  d_k = mean( vote_j ),  j ∈ 维度 k
综合信号:    S = Σ_k w_k · d_k / Σ_k w_k   ∈ [-1, +1]
仓位映射:    pos = sign(S) · min(1, (|S| − θ) / 0.35),  |S| ≤ θ 时空仓`}</pre>
          <p>
            <b>方向系数 dir</b>：+1 表示指标越高越看多（如动量、资金流入），−1 表示逆向（如估值分位、成交额过热）。
            tanh 压缩保证极端 z 分数不会让投票越界。所有因子仅用截至当日的数据计算，<b>不存在未来函数</b>。
          </p>
        </MathPanel>
      </Panel>

      <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页模型指标交给 AI 解读，只读不改任何设置">
        <AiAnalyze
          module="多维度因子投票择时"
          note="信号 S 由估值/情绪/资金/技术四维因子投票加权合成，取值 [-1,+1]。"
          facts={[
            { label: '因子数量', value: String(report.values.length) },
            { label: '综合信号 S', value: signal.toFixed(3) },
            { label: '各维度得分', value: report.dims.map((d) => d.dim + ' ' + d.score.toFixed(3)).join('，') },
            { label: '策略总收益', value: (bt.metrics.totalReturn * 100).toFixed(2) + '%' },
            { label: '夏普', value: bt.metrics.sharpe.toFixed(2) },
            { label: '最大回撤', value: (bt.metrics.maxDD * 100).toFixed(2) + '%' },
            { label: '胜率', value: (bt.metrics.winRate * 100).toFixed(2) + '%' }
          ]}
        />
      </Panel>
    </div>
  );
}
