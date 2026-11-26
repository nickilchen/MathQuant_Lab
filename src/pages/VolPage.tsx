import { useMemo, useState } from 'react';
import EChart from '../components/EChart';
import BacktestPanel from '../components/BacktestPanel';
import { ControlBar, CtrlGroup, EmptyTip, Loading, MathPanel, MetricGrid, Panel, Slider, fmtPct } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { C, barOption, lineOption } from '../components/chartOptions';
import { useApp, useKline } from '../hooks/AppContext';
import { runVolModel } from '../pipelines';

export default function VolPage() {
  const { settings, btCfg } = useApp();
  const bench = useKline(settings.benchmark);
  const [targetVol, setTargetVol] = useState(0.15);
  const [cap, setCap] = useState(1.2);

  const run = useMemo(() => {
    if (!bench || bench.bars.length < 80) return null;
    return runVolModel(bench.bars, targetVol, cap, btCfg);
  }, [bench, targetVol, cap, btCfg, btCfg]);

  if (!bench || bench.loading) return <Loading text="正在拉取行情…" />;
  if (!run) return <EmptyTip text="行情数据不足" />;

  const { garch, hv20, spread, positions, bt, dates } = run;
  const garchSeries = garch.sigma.map((s) => (Number.isFinite(s) ? s : null));
  const regimeText =
    run.regime === 'high'
      ? '预测波动率 > 已实现波动率：波动率上行 regime，策略降仓防御'
      : run.regime === 'low'
        ? '预测波动率 < 已实现波动率：波动率回落 regime，策略逐步加仓'
        : '预测与已实现波动率接近：中性 regime';

  return (
    <div>
      <div className="page-title-row">
        <h2>🌊 波动率模型 · GARCH 与波动率目标</h2>
        <span className="en">GARCH(1,1) · Volatility Targeting</span>
      </div>
      <p className="page-lead">
        跳出方向性博弈，交易<b>不确定性本身</b>。原始思路是比较期权隐含波动率（IV）与历史波动率（HV）：
        IV 显著高于 HV 时市场过度恐慌、期权定价偏高，应「做空波动率」；反之「做多波动率」。
        在无期权数据的环境下，本站用 <b>GARCH(1,1) 预测波动率</b>作为 IV 的代理，与已实现波动率 HV20 比较，
        并把价差转化为<b>波动率目标仓位</b>（Vol Targeting）：预期波动越高，仓位越低。
      </p>

      <ControlBar>
        <CtrlGroup label="策略">
          <Slider label="目标年化波动" value={targetVol} min={0.05} max={0.4} step={0.01} onChange={setTargetVol} fmt={(v) => `${(v * 100).toFixed(0)}%`} />
          <Slider label="仓位上限" value={cap} min={0.5} max={2} step={0.1} onChange={setCap} fmt={(v) => `${v.toFixed(1)}x`} />
        </CtrlGroup>
        <CtrlGroup label="当前状态">
          <span className={`badge ${run.regime === 'high' ? 'bear' : run.regime === 'low' ? 'bull' : 'flat'}`}>
            {run.regime === 'high' ? '波动率上行' : run.regime === 'low' ? '波动率回落' : '中性'}
          </span>
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>{regimeText}</span>
        </CtrlGroup>
      </ControlBar>

      <Panel title="GARCH 条件波动率 vs 已实现波动率" icon="📉" desc="年化口径；GARCH 曲线为一条件预测，HV20 为 20 日已实现">
        <EChart
          option={lineOption(
            dates,
            [
              { name: 'GARCH(1,1) 预测', data: garchSeries, color: C.accent },
              { name: 'HV20 已实现', data: hv20.map((v) => v ?? null), color: C.orange, dashed: true },
              { name: '目标波动率', data: dates.map(() => targetVol), color: C.gray, dashed: true }
            ],
            { yName: '年化波动率' }
          )}
          height={330}
        />
      </Panel>

      <div className="grid-2">
        <Panel title="IV − HV 价差代理" icon="⚖️" desc="GARCH 预测 − HV20：>0 视为「IV 被高估」">
          <EChart
            option={barOption(
              dates,
              [{ name: '价差', data: spread.map((v) => v ?? 0), color: C.purple }],
              { pct: true }
            )}
            height={260}
          />
          <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.8 }}>
            注：生产环境中该指标可直接用 50ETF 平值期权反解的隐含波动率替换，
            本站以 GARCH 预测作为代理，交易逻辑同构。
          </div>
        </Panel>
        <Panel title="波动率目标仓位" icon="🎚" desc="仓位 = min(上限, 目标波动 / 预测波动)">
          <EChart
            option={lineOption(
              dates,
              [{ name: '仓位', data: positions, color: C.cyan, area: true }],
              { yName: '仓位' }
            )}
            height={260}
          />
        </Panel>
      </div>

      <Panel title="模型估计结果" icon="⚙️">
        <MetricGrid
          items={[
            { label: 'α（ARCH 项）', value: garch.alpha.toFixed(4) },
            { label: 'β（GARCH 项）', value: garch.beta.toFixed(4) },
            { label: '持续性 α+β', value: garch.persistence.toFixed(4), sub: garch.persistence < 1 ? '平稳' : '非平稳' },
            { label: '一步预测波动', value: fmtPct(garch.forecast, 1) },
            { label: '对数似然', value: garch.loglik.toFixed(1) },
            { label: '平均仓位', value: (positions.reduce((a, b) => a + b, 0) / Math.max(positions.length, 1)).toFixed(2) }
          ]}
        />
      </Panel>

      <BacktestPanel result={bt} />

      <Panel title="📐 数学原理" icon="">
        <MathPanel>
          <pre>{`GARCH(1,1):
  σ²_t = ω + α·ε²_{t-1} + β·σ²_{t-1}
  ε_t = σ_t·z_t,  z_t ~ i.i.d. N(0,1)

方差目标法（Variance Targeting）:
  ω = σ̄²·(1 − α − β),   σ̄² = 样本无条件方差
  只需在 (α, β) 二维网格上搜索高斯 QMLE:
  ℓ(α,β) = −½ Σ_t [ log(2πσ²_t) + ε²_t/σ²_t ]

波动率目标（Vol Targeting）:
  w_t = min(cap, σ_target / σ̂_{t+1})
  预期波动越高 → 仓位越低，组合风险被「熨平」到目标水平。`}</pre>
          <p>
            <b>估计流程</b>：24×21 网格粗搜 → 以最优解为中心做 3 轮局部细化。
            α+β 越接近 1，波动率冲击的衰减越慢（波动聚集效应越强）。A 股指数典型估计 α≈0.08、β≈0.88。
          </p>
        </MathPanel>
      </Panel>

      <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页模型指标交给 AI 解读，只读不改任何设置">
        <AiAnalyze
          module="波动率模型 · GARCH"
          note="GARCH 波动率为条件预测；IV−HV 价差在本站用 GARCH 预测−已实现波动代理。"
          facts={[
            { label: '波动状态', value: run.regime === 'high' ? '波动率上行' : run.regime === 'low' ? '波动率回落' : '中性' },
            { label: 'α（ARCH 项）', value: garch.alpha.toFixed(4) },
            { label: 'β（GARCH 项）', value: garch.beta.toFixed(4) },
            { label: '一步预测波动（年化）', value: (garch.forecast * 100).toFixed(2) + '%' },
            { label: '当前目标仓位', value: (positions[positions.length - 1] * 100).toFixed(1) + '%' },
            { label: '策略总收益', value: (bt.metrics.totalReturn * 100).toFixed(2) + '%' },
            { label: '夏普', value: bt.metrics.sharpe.toFixed(2) },
            { label: '最大回撤', value: (bt.metrics.maxDD * 100).toFixed(2) + '%' }
          ]}
        />
      </Panel>
    </div>
  );
}
