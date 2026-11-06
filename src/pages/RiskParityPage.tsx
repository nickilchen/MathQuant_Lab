import { useMemo, useState } from 'react';
import EChart from '../components/EChart';
import { ControlBar, CtrlGroup, ChipMulti, EmptyTip, Loading, MathPanel, MetricGrid, Panel, Select, Slider, fmtPct } from '../components/ui';
import { C, barOption, equityOption, pieOption } from '../components/chartOptions';
import { useApp, useKlines } from '../hooks/AppContext';
import { RP_DEFAULT, SYMBOLS } from '../data/symbols';
import { runRpModel, type RpMethod } from '../pipelines';

const METHOD_ORDER: RpMethod[] = ['erc', 'hrp', 'iv', 'eq'];
const METHOD_NAME: Record<RpMethod, string> = {
  erc: 'ERC 等风险贡献',
  hrp: 'HRP 层次风险平价',
  iv: 'inverse-vol 逆波动',
  eq: '等权重'
};
/** 读取时再取色，跟随主题切换 */
const methodColor = (m: RpMethod) => ({ erc: C.accent, hrp: C.purple, iv: C.cyan, eq: C.gray }[m]);

const POOL = SYMBOLS.filter((s) => ['etf', 'bond', 'gold', 'overseas', 'commodity'].includes(s.kind));

export default function RiskParityPage() {
  const { btCfg } = useApp();
  const [selected, setSelected] = useState<string[]>(RP_DEFAULT);
  const [window, setWindow] = useState(120);
  const [freq, setFreq] = useState(20);

  const klines = useKlines(selected);
  const ready = selected.every((c) => klines[c] && !klines[c].loading && klines[c].bars.length >= window + 30);

  const run = useMemo(() => {
    if (!ready) return null;
    const barsMap: Record<string, typeof klines[string]['bars']> = {};
    for (const c of selected) barsMap[c] = klines[c].bars;
    const names = Object.fromEntries(SYMBOLS.map((s) => [s.code, s.name]));
    return runRpModel(barsMap, names, selected, window, freq, 'sh510300', btCfg);
  }, [ready, selected, window, freq, klines, btCfg]);

  const toggle = (code: string) =>
    setSelected((s) => (s.includes(code) ? s.filter((x) => x !== code) : s.length < 10 ? [...s, code] : s));

  const loadingAny = selected.some((c) => klines[c]?.loading);

  return (
    <div>
      <div className="page-title-row">
        <h2>⚖️ 风险平价 · 多空风险预算</h2>
        <span className="en">Risk Parity · ERC / HRP</span>
      </div>
      <p className="page-lead">
        不预测方向，解决「<b>应该下多少注</b>」。摒弃等金额分配，让每个资产对组合风险的贡献相等（ERC），
        或用层次聚类递归二分（HRP）。协方差经<b>对角收缩</b>（Ledoit-Wolf 风格）稳定后再求解。
      </p>

      <ControlBar>
        <CtrlGroup label="资产池">
          <ChipMulti
            options={POOL.map((s) => ({ value: s.code, label: s.name }))}
            selected={selected}
            onToggle={toggle}
          />
        </CtrlGroup>
        <CtrlGroup label="再平衡">
          <Slider label="协方差窗口" value={window} min={60} max={250} step={10} onChange={setWindow} fmt={(v) => `${v}日`} />
          <Select
            label="频率"
            value={freq}
            onChange={setFreq}
            options={[
              { value: 5, label: '每周' },
              { value: 20, label: '每月' },
              { value: 60, label: '每季' }
            ]}
          />
        </CtrlGroup>
      </ControlBar>

      {loadingAny && <Loading text="正在拉取资产行情…" />}
      {!loadingAny && !run && <EmptyTip text="请选择至少 2 个资产，且行情数据需覆盖窗口+30 日" />}

      {run && (
        <>
          <Panel title="权重对比：等权 vs 逆波动 vs ERC vs HRP" icon="📊" desc="基于最新一期协方差估计（年化口径）">
            <EChart
              option={barOption(
                run.names,
                (['eq', 'iv', 'erc', 'hrp'] as RpMethod[]).map((m) => ({
                  name: METHOD_NAME[m],
                  data: run.weights[m],
                  color: methodColor(m)
                })),
                { pct: true }
              )}
              height={320}
            />
          </Panel>

          <div className="grid-2">
            <Panel title="ERC：资本贡献 vs 风险贡献" icon="⚖️" desc="风险平价的目标是让右侧各扇区完全相等">
              <EChart
                option={pieOption([
                  ...run.names.map((nm, i) => ({ name: `${nm}·风险`, value: run.rc[i], color: [C.accent, C.purple, C.cyan, C.amber, C.up, C.down, C.orange, C.bench, C.gray, C.accent][i % 10] })),
                  ...run.names.map((nm, i) => ({ name: `${nm}·资本`, value: run.weights.erc[i], color: C.panel2 }))
                ])}
                height={320}
              />
            </Panel>
            <Panel title="组合净值曲线" icon="📈" desc={`窗口 ${window} 日 · 每 ${freq} 日再平衡 · 起点=1`}>
              <EChart
                option={equityOption(
                  run.dates,
                  [
                    ...METHOD_ORDER.map((m) => ({
                      name: METHOD_NAME[m],
                      data: run.curves[m],
                      color: methodColor(m)
                    })),
                    { name: '沪深300ETF', data: run.benchCurve, color: C.bench, dashed: true }
                  ]
                )}
                height={320}
              />
            </Panel>
          </div>

          <Panel title="绩效对比" icon="🏁">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>方法</th>
                    <th className="num">年化收益</th>
                    <th className="num">年化波动</th>
                    <th className="num">夏普</th>
                    <th className="num">最大回撤</th>
                    <th className="num">卡玛</th>
                    <th className="num">IR</th>
                  </tr>
                </thead>
                <tbody>
                  {METHOD_ORDER.map((m) => {
                    const mm = run.metrics[m];
                    return (
                      <tr key={m}>
                        <td style={{ color: methodColor(m), fontWeight: 600 }}>{METHOD_NAME[m]}</td>
                        <td className="num" style={{ color: mm.cagr > 0 ? 'var(--up)' : 'var(--down)' }}>{fmtPct(mm.cagr)}</td>
                        <td className="num">{fmtPct(mm.annVol)}</td>
                        <td className="num">{mm.sharpe.toFixed(2)}</td>
                        <td className="num">{fmtPct(mm.maxDD)}</td>
                        <td className="num">{mm.calmar.toFixed(2)}</td>
                        <td className="num">{mm.ir.toFixed(2)}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={{ color: C.bench, fontWeight: 600 }}>沪深300ETF（买入持有）</td>
                    <td className="num">{fmtPct(run.metrics.erc.beta ? 0 : 0)}</td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                    <td className="num">—</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div style={{ height: 10 }} />
            <MetricGrid
              items={[
                { label: 'ERC 组合年化波动', value: fmtPct(run.portVols.erc) },
                { label: 'HRP 组合年化波动', value: fmtPct(run.portVols.hrp) },
                { label: '等权组合年化波动', value: fmtPct(run.portVols.eq) },
                { label: '最高单资产波动', value: fmtPct(Math.max(...run.vols)) }
              ]}
            />
          </Panel>

          <Panel title="📐 数学原理" icon="">
            <MathPanel>
              <pre>{`风险贡献:  RC_i = w_i·(Σw)_i / (wᵀΣw)      （归一化后 ΣRC_i = 1）
ERC 目标:  RC_i = 1/n  ∀i

循环坐标下降（CCD）更新:
  w_i ← sqrt( w_i · RC* / (Σw)_i ),   RC* = 1/n
  迭代至各资产风险贡献差异 < 1e-12。

对角收缩协方差（Ledoit-Wolf 风格）:
  Σ_shrunk[i][j] = Σ[i][j]·(1 − δ),  i ≠ j;   δ = 0.2
  压缩样本噪声导致的虚假低相关，稳定 ERC 求解。

HRP（层次风险平价）:
  1. 相关距离 d_ij = sqrt((1 − ρ_ij)/2)
  2. 平均连接层次聚类 → 准对角化排序
  3. 递归二分：α = 1 − σ²_left/(σ²_left + σ²_right)
     左子树权重 × α，右子树 × (1 − α)，簇内方差按逆方差加权`}</pre>
              <p>
                ERC 让「低波资产多配、高波资产少配」自动发生；HRP 则额外考虑资产间的相关结构，
                对相关性突变更稳健。两者都不预测方向，只分配风险预算。
              </p>
            </MathPanel>
          </Panel>
        </>
      )}
    </div>
  );
}
