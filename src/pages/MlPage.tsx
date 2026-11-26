import { useMemo, useState } from 'react';
import EChart from '../components/EChart';
import BacktestPanel from '../components/BacktestPanel';
import { ControlBar, CtrlGroup, EmptyTip, Loading, MathPanel, MetricGrid, Panel, Select, Slider, fmtPct } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { C, barOption, lineOption } from '../components/chartOptions';
import { useApp, useKline } from '../hooks/AppContext';
import { runMlModel, type MlModelType } from '../pipelines';

export default function MlPage() {
  const { settings, btCfg } = useApp();
  const bench = useKline(settings.benchmark);
  const [modelType, setModelType] = useState<MlModelType>('mlp');
  const [epochs, setEpochs] = useState(150);

  const run = useMemo(() => {
    if (!bench || bench.bars.length < 150) return null;
    return runMlModel(bench.bars, modelType, epochs, btCfg);
  }, [bench, modelType, epochs, btCfg]);

  if (!bench || bench.loading) return <Loading text="正在拉取行情…" />;
  if (!run) return <EmptyTip text="行情数据不足（至少 150 个交易日）" />;

  const impSorted = run.importance
    .map((v, i) => ({ name: run.importanceNames[i], v }))
    .sort((a, b) => b.v - a.v);
  const maxImp = Math.max(...impSorted.map((x) => x.v), 1e-9);

  return (
    <div>
      <div className="page-title-row">
        <h2>🤖 机器学习 · MLP 方向预测</h2>
        <span className="en">Neural Network · Next-Day Direction</span>
      </div>
      <p className="page-lead">
        用 10 维技术特征（收益率、动量、波动率、RSI、MACD、均线偏离、量能、布林位置）预测次日涨跌方向。
        模型为纯 TypeScript 实现的<b>单隐层 MLP</b>（tanh 隐层 + sigmoid 输出，反向传播 + Adam），
        逻辑回归作为基线。按 70% / 30% 时间顺序切分训练/测试集，回测仅在<b>样本外</b>区间进行。
      </p>

      <ControlBar>
        <CtrlGroup label="模型">
          <Select
            label="算法"
            value={modelType}
            onChange={setModelType}
            options={[
              { value: 'mlp', label: 'MLP 神经网络' },
              { value: 'logreg', label: '逻辑回归（基线）' }
            ]}
          />
          {modelType === 'mlp' && (
            <Slider label="训练轮数" value={epochs} min={30} max={400} step={10} onChange={setEpochs} fmt={(v) => `${v}`} />
          )}
        </CtrlGroup>
        <CtrlGroup label="样本">
          <span style={{ fontSize: 12.5 }}>
            训练 {run.trainSize} 条 / 测试 {run.testSize} 条（时序划分）· 基准上涨率 {(run.baseRate * 100).toFixed(1)}%
          </span>
        </CtrlGroup>
      </ControlBar>

      <div className="grid-2">
        <Panel title="训练损失曲线（BCE）" icon="📉" desc="二元交叉熵，Mini-batch + Adam 优化">
          <EChart
            option={lineOption(
              run.lossHistory.map((_, i) => `${i + 1}`),
              [{ name: 'loss', data: run.lossHistory, color: C.accent, area: true }],
              { yName: 'loss' }
            )}
            height={260}
          />
        </Panel>
        <Panel title="特征重要性" icon="🔍" desc={modelType === 'mlp' ? '第一层权重绝对值之和' : '逻辑回归 |w|'}>
          <EChart
            option={barOption(
              impSorted.map((x) => x.name),
              [{ name: '重要性', data: impSorted.map((x) => x.v / maxImp), color: C.purple }]
            )}
            height={260}
          />
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="样本外预测概率" icon="🎯" desc="测试期每日「次日上涨」概率，>0.55 做多 / <0.45 做空">
          <EChart
            option={lineOption(
              run.testDates,
              [
                { name: '上涨概率', data: run.testProba, color: C.accent, area: true },
                { name: '0.55', data: run.testDates.map(() => 0.55), color: C.up, dashed: true },
                { name: '0.45', data: run.testDates.map(() => 0.45), color: C.down, dashed: true }
              ],
              { yName: '概率' }
            )}
            height={260}
          />
        </Panel>
        <Panel title="模型评估" icon="🏁">
          <MetricGrid
            items={[
              { label: '训练准确率', value: fmtPct(run.accTrain, 1) },
              { label: '测试准确率', value: fmtPct(run.accTest, 1), tone: run.accTest > run.baseRate ? 'up' : 'flat', sub: `基准 ${fmtPct(run.baseRate, 1)}` },
              { label: 'AUC', value: run.auc.toFixed(3), tone: run.auc > 0.55 ? 'up' : 'flat' },
              { label: '最新概率', value: run.lastProba.toFixed(3), sub: run.lastProba > 0.55 ? '偏多' : run.lastProba < 0.45 ? '偏空' : '中性' }
            ]}
          />
          <div style={{ height: 12 }} />
          <div className="tbl-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th colSpan={2}>混淆矩阵（测试集）</th>
                  <th className="num">预测跌</th>
                  <th className="num">预测涨</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td rowSpan={2} style={{ verticalAlign: 'middle', fontWeight: 600 }}>实际</td>
                  <td style={{ fontWeight: 600 }}>跌</td>
                  <td className="num">{run.cm.tn}</td>
                  <td className="num">{run.cm.fp}</td>
                </tr>
                <tr>
                  <td style={{ fontWeight: 600 }}>涨</td>
                  <td className="num">{run.cm.fn}</td>
                  <td className="num">{run.cm.tp}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      <BacktestPanel result={run.bt} title="样本外回测" />

      <Panel title="📐 数学原理" icon="">
        <MathPanel>
          <pre>{`网络结构:  输入 10 → 隐层 8 (tanh) → 输出 1 (sigmoid)
前向:      h = tanh(W1·x + b1),  p = sigmoid(W2·h + b2)
损失:      L = −[ y·log(p) + (1−y)·log(1−p) ] + λ‖W‖²      （BCE + L2）
反向:      δ_out = p − y
           δ_hidden = (W2ᵀ·δ_out) ⊙ (1 − h²)
           ∂L/∂W2 = δ_out·hᵀ,  ∂L/∂b2 = δ_out
           ∂L/∂W1 = δ_hidden·xᵀ, ∂L/∂b1 = δ_hidden
优化:      Mini-batch(32) SGD + Adam
           m ← β1·m + (1−β1)·g,  v ← β2·v + (1−β2)·g²
           w ← w − lr·(m̂/(√v̂ + ε))`}</pre>
          <p>
            <b>为什么用时序切分</b>：随机打乱会让训练集「看到」未来的市场环境，导致准确率虚高。
            70/30 时序划分下，测试集是完全未知的样本外区间，指标更可信。
            金融信噪比极低，测试准确率 52–55% 已具备实战意义，但仍需结合成本与容量评估。
          </p>
        </MathPanel>
      </Panel>

      <Panel title="🤖 AI 指标解读" icon="🤖" desc="把本页模型指标交给 AI 解读，只读不改任何设置">
        <AiAnalyze
          module="机器学习方向预测"
          note="按 70/30 时序切分，回测仅在样本外区间；基准上涨率用于判断模型是否跑赢「永远猜涨」。"
          facts={[
            { label: '模型', value: run.modelType === 'mlp' ? 'MLP 神经网络' : '逻辑回归' },
            { label: '训练 / 测试样本', value: run.trainSize + ' / ' + run.testSize },
            { label: '训练集准确率', value: (run.accTrain * 100).toFixed(2) + '%' },
            { label: '测试集准确率', value: (run.accTest * 100).toFixed(2) + '%' },
            { label: '基准上涨率', value: (run.baseRate * 100).toFixed(2) + '%' },
            { label: 'AUC', value: run.auc.toFixed(3) },
            { label: '最新预测概率', value: (run.lastProba * 100).toFixed(1) + '%' },
            { label: '策略总收益', value: (run.bt.metrics.totalReturn * 100).toFixed(2) + '%' },
            { label: '夏普', value: run.bt.metrics.sharpe.toFixed(2) },
            { label: '最大回撤', value: (run.bt.metrics.maxDD * 100).toFixed(2) + '%' }
          ]}
        />
      </Panel>
    </div>
  );
}
