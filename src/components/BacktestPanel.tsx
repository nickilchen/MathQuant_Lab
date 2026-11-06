import EChart from './EChart';
import { C, equityOption } from './chartOptions';
import { MetricGrid, Panel } from './ui';
import { fmtPct } from '../math/backtest';
import type { BtResult } from '../math/backtest';

/** 统一回测报告：净值曲线 + 指标卡 */
export default function BacktestPanel({
  result,
  title = '回测报告',
  extraSeries = [],
  benchmarkName = '买入持有基准'
}: {
  result: BtResult;
  title?: string;
  extraSeries?: { name: string; data: number[]; color?: string }[];
  benchmarkName?: string;
}) {
  const m = result.metrics;
  const n = result.equity.length;
  const series = [
    { name: '策略净值', data: result.equity, color: C.accent, area: true },
    { name: benchmarkName, data: result.benchmark, color: C.bench, dashed: true },
    ...extraSeries.map((s) => ({ ...s, dashed: true }))
  ];

  return (
    <Panel title={`${title}（含成本，起点=1）`} icon="📈">
      <EChart option={equityOption(result.dates, series)} height={300} />
      <div style={{ height: 12 }} />
      <MetricGrid
        items={[
          { label: '累计收益', value: fmtPct(m.totalReturn), tone: m.totalReturn > 0 ? 'up' : 'down' },
          { label: '年化收益', value: fmtPct(m.cagr), tone: m.cagr > 0 ? 'up' : 'down' },
          { label: '年化波动', value: fmtPct(m.annVol) },
          { label: '夏普比率', value: m.sharpe.toFixed(2), tone: m.sharpe > 1 ? 'up' : 'flat' },
          { label: '最大回撤', value: fmtPct(m.maxDD), tone: m.maxDD > 0.2 ? 'down' : 'flat' },
          { label: '卡玛比率', value: m.calmar.toFixed(2) },
          { label: '日胜率', value: fmtPct(m.winRate) },
          { label: '信息比 IR', value: m.ir.toFixed(2) },
          { label: 'Beta', value: m.beta.toFixed(2) },
          { label: '累计换手', value: m.turnover.toFixed(0), sub: '单位: 仓位' }
        ]}
      />
      <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8 }}>
        共 {n} 个交易日 · 成本模型：双边佣金 + 卖出印花税（顶栏可调） · 负仓位按可做空处理，未计融券利息
      </div>
    </Panel>
  );
}
