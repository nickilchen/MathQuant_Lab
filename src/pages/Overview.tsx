import { useEffect, useMemo } from 'react';
import EChart from '../components/EChart';
import { ControlBar, CtrlGroup, EmptyTip, Loading, MathPanel, Panel, SignalBadge, SourcePill, fmtPct } from '../components/ui';
import { AiAnalyze } from '../components/AiAnalyze';
import { C, equityOption, gaugeOption } from '../components/chartOptions';
import { useApp, useKline } from '../hooks/AppContext';
import { BOND_ETF, MARKET_LABEL, bondRefFor, getSymbol } from '../data/symbols';
import { runFactorModel, runHmmModel, runMlModel, runVolModel } from '../pipelines';
import { hmmView as hmmViewOf } from '../math/hmm';

export default function Overview() {
  const { settings, btCfg, extras, ensureExtras } = useApp();
  const bench = useKline(settings.benchmark);
  const bond = useKline(BOND_ETF);

  const fundFlow = extras[settings.benchmark]?.fundFlow ?? null;
  // 仅 A 股基准使用国债 ETF 作为股债性价比参考；境外基准该因子自动剔除
  const bondRef = bondRefFor(getSymbol(settings.benchmark)?.market ?? 'CN', bond?.bars);

  // 资金流/估值快照属于副作用，放到 effect 里触发，避免渲染期更新 AppProvider
  useEffect(() => {
    ensureExtras(settings.benchmark);
  }, [ensureExtras, settings.benchmark]);

  const models = useMemo(() => {
    if (!bench || bench.bars.length < 150) return null;
    const hmm = runHmmModel(bench.bars, 4, 0.15, btCfg);
    const fac = runFactorModel(
      bench.bars,
      fundFlow,
      bondRef,
      { 估值: 0.25, 情绪: 0.25, 资金: 0.25, 技术: 0.25 },
      0.15,
      btCfg
    );
    const vol = runVolModel(bench.bars, 0.15, 1.2, btCfg);
    const ml = runMlModel(bench.bars, 'mlp', 150, btCfg);
    return { hmm, fac, vol, ml };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bench, bond, fundFlow, bondRef, btCfg]);

  if (!bench || bench.loading) return <Loading text="正在初始化各模型…" />;
  if (!models) return <EmptyTip text="行情数据不足（至少 150 个交易日）" />;

  const { hmm, fac, vol, ml } = models;
  const sym = getSymbol(settings.benchmark);

  // 各模型归一化到 [-1,1] 的当前观点
  // HMM 观点：滤波概率加权的期望状态漂移（不受窗口整体涨跌扭曲）
  const hmmView = hmmViewOf(hmm.output.filtered, hmm.output.model.mu);
  const mostLikely = hmm.currentProbs.indexOf(Math.max(...hmm.currentProbs));
  const facView = fac.signal;
  const volView = -Math.max(-1, Math.min(1, (vol.garch.forecast - (vol.hv20.filter((v) => v !== null).slice(-1)[0] ?? 0.15)) / 0.1));
  const mlView = Math.max(-1, Math.min(1, (ml.lastProba - 0.5) * 4));
  const composite = (hmmView + facView + volView + mlView) / 4;
  // 汇总净值曲线（对齐到最短长度）
  const curves = [
    { name: 'HMM 状态策略', data: hmm.bt.equity, color: C.up },
    { name: '因子投票策略', data: fac.bt.equity, color: C.accent },
    { name: '波动率目标策略', data: vol.bt.equity, color: C.cyan },
    { name: 'MLP 方向策略', data: ml.bt.equity, color: C.purple }
  ];
  const minLen = Math.min(...curves.map((c) => c.data.length));
  const dates = hmm.bt.dates.slice(hmm.bt.dates.length - minLen);

  const cards = [
    {
      icon: '🧠',
      name: 'HMM 市场状态',
      view: hmmView,
      big: hmm.output.labels[mostLikely],
      desc: `最可能状态「${hmm.output.labels[mostLikely]}」（概率 ${((hmm.currentProbs[mostLikely] ?? 0) * 100).toFixed(0)}%），状态观点 ${hmmView > 0 ? '+' : ''}${hmmView.toFixed(2)}`
    },
    {
      icon: '🗳️',
      name: '因子投票信号',
      view: facView,
      big: `${facView > 0 ? '+' : ''}${facView.toFixed(3)}`,
      desc:
        `四维得分：${fac.report.dims.map((d) => `${d.dim} ${d.score >= 0 ? '+' : ''}${d.score.toFixed(2)}`).join(' · ')}` +
        (sym && sym.market !== 'CN' ? '（境外市场：资金流/国债参考不可用，已自动剔除）' : '')
    },
    {
      icon: '🌊',
      name: '波动率 Regime',
      view: volView,
      big: vol.regime === 'high' ? '波动率上行' : vol.regime === 'low' ? '波动率回落' : '中性',
      desc: `GARCH 预测 ${fmtPct(vol.garch.forecast, 1)}，一步预测 HV 差 ${(
        (vol.garch.forecast - (vol.hv20.filter((v) => v !== null).slice(-1)[0] ?? 0)) * 100
      ).toFixed(1)}pct`
    },
    {
      icon: '🤖',
      name: 'MLP 方向概率',
      view: mlView,
      big: `${(ml.lastProba * 100).toFixed(1)}%`,
      desc: `样本外准确率 ${fmtPct(ml.accTest, 1)}（基准 ${fmtPct(ml.baseRate, 1)}），AUC ${ml.auc.toFixed(2)}`
    }
  ];

  return (
    <div>
      <div className="page-title-row">
        <h2>📊 市场体检总览</h2>
        <span className="en">Market Regime Dashboard</span>
      </div>
      <p className="page-lead">
        四大数学模型对 <b>
          <span className="badge info" style={{ marginRight: 6 }}>{sym ? MARKET_LABEL[sym.market] : ''}</span>
          {sym?.name ?? settings.benchmark}
        </b> 的当前判断一目了然：HMM 回答「市场是什么状态」，
        因子投票回答「为什么是这个状态」，波动率模型刻画「不确定性水平」，MLP 给出「次日方向的概率观点」。
        所有计算均在浏览器端完成，数据源与状态见顶栏。
      </p>

      <ControlBar>
        <CtrlGroup label="数据">
          <SourcePill source={bench.source} loading={bench.loading} />
          <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
            {bench.bars.length} 个交易日 · {bench.bars[0]?.date} ~ {bench.bars[bench.bars.length - 1]?.date}
          </span>
        </CtrlGroup>
      </ControlBar>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, marginBottom: 16 }}>
        {cards.map((c) => (
          <div className="signal-card" key={c.name}>
            <div className="sc-head">
              <span className="sc-name">
                {c.icon} {c.name}
              </span>
              <SignalBadge tone={c.view > 0.15 ? 'bull' : c.view < -0.15 ? 'bear' : 'flat'} text={c.view.toFixed(2)} />
            </div>
            <div className="sc-body">
              <span className="sc-big" style={{ color: c.view > 0.15 ? 'var(--up)' : c.view < -0.15 ? 'var(--down)' : 'var(--text-2)' }}>
                {c.big}
              </span>
            </div>
            <div className="sc-desc">{c.desc}</div>
          </div>
        ))}
      </div>

      <div className="grid-2">
        <Panel title="四模型综合观点" icon="🎚" desc="各模型观点归一化后的等权平均 ∈ [-1, +1]">
          <EChart option={gaugeOption(composite, '综合信号')} height={280} />
          <div style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--text-2)', marginTop: -8 }}>
            {composite > 0.2 ? '四模型整体偏多' : composite < -0.2 ? '四模型整体偏空' : '四模型分歧 / 中性'}
            （{-composite > 0 ? '' : ''}
            {composite > 0 ? '+' : ''}
            {composite.toFixed(3)}）
          </div>
          {hmmView * facView < -0.09 && (
            <div className="notice" style={{ marginTop: 10 }}>
              ⚠️ <b>模型分歧</b>：HMM 观点 {hmmView.toFixed(2)} 与因子投票 {facView.toFixed(2)} 方向相反。
              历史统计上分歧期单独跟随任一模型胜率都会下降，建议降低仓位、等信号一致再行动。
            </div>
          )}
        </Panel>
        <Panel title="策略净值对比" icon="📈" desc="均为含成本回测，起点=1；点击图例可显隐">
          <EChart option={equityOption(dates, curves)} height={280} />
        </Panel>
      </div>

      <Panel title="各模型样本外绩效" icon="🏁" desc="同一基准、同一成本参数下的横向对比">
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>模型</th>
                <th className="num">年化收益</th>
                <th className="num">夏普</th>
                <th className="num">最大回撤</th>
                <th className="num">日胜率</th>
                <th className="num">Beta</th>
              </tr>
            </thead>
            <tbody>
              {[
                { name: 'HMM 状态策略', m: hmm.bt.metrics },
                { name: '因子投票策略', m: fac.bt.metrics },
                { name: '波动率目标策略', m: vol.bt.metrics },
                { name: 'MLP 方向策略', m: ml.bt.metrics },
                { name: '基准买入持有', m: hmm.bt.metrics, isBench: true }
              ].map((row) => (
                <tr key={row.name}>
                  <td style={{ fontWeight: 600 }}>{row.name}</td>
                  <td className="num" style={{ color: row.m.cagr > 0 ? 'var(--up)' : 'var(--down)' }}>
                    {row.isBench ? fmtPct(hmm.bt.benchmark[hmm.bt.benchmark.length - 1] ** (252 / hmm.bt.benchmark.length) - 1) : fmtPct(row.m.cagr)}
                  </td>
                  <td className="num">{row.isBench ? '—' : row.m.sharpe.toFixed(2)}</td>
                  <td className="num">{row.isBench ? '—' : fmtPct(row.m.maxDD)}</td>
                  <td className="num">{row.isBench ? '—' : fmtPct(row.m.winRate)}</td>
                  <td className="num">{row.isBench ? '—' : row.m.beta.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title="📐 模型地图" icon="">
        <MathPanel>
          <ul>
            <li>
              <b>HMM 市场状态</b>（/hmm）：隐马尔可夫模型识别趋势/震荡状态 → 方向。Baum-Welch 训练 + Viterbi 解码。
            </li>
            <li>
              <b>因子投票择时</b>（/factors）：估值/情绪/资金/技术四维 16 因子投票 → 综合信号 S ∈ [-1, +1]。
            </li>
            <li>
              <b>波动率模型</b>（/vol）：GARCH(1,1) 预测 vs 已实现波动率 → 波动率目标仓位。
            </li>
            <li>
              <b>风险平价</b>（/riskparity）：ERC 等风险贡献 + HRP 层次风险平价 → 仓位配置。
            </li>
            <li>
              <b>PCA 统计套利</b>（/pca）：主成分剥离共同因子，残差 z-score 均值回归 → 市场中性组合。
            </li>
            <li>
              <b>机器学习</b>（/ml）：MLP 反向传播预测次日方向 → 概率化多空信号。
            </li>
          </ul>
          <p style={{ color: 'var(--text-3)' }}>
            上述模型回答的是不同问题：方向（HMM/投票/MLP）、维度（波动率）、仓位（风险平价）、结构（PCA）。
            没有任何单一模型能持续盈利，组合使用 + 严格成本控制才是关键。
          </p>
        </MathPanel>
      </Panel>

      <Panel title="🤖 AI 指标解读" icon="🤖" desc="把四模型综合观点交给 AI 解读，只读不改任何设置">
        <AiAnalyze
          module="市场体检总览 · 四模型合成"
          symbol={getSymbol(settings.benchmark)?.name}
          note="综合观点为 HMM / 因子投票 / 波动率 / MLP 四路观点等权平均，各路口径不同，互相印证更可靠。"
          facts={[
            { label: '基准', value: getSymbol(settings.benchmark)?.name ?? settings.benchmark },
            { label: '综合信号', value: composite.toFixed(3) + '（-1 看空 ~ +1 看多）' },
            { label: 'HMM 观点', value: hmmView.toFixed(3) + ' · 最可能状态 ' + hmm.output.labels[hmm.currentProbs.indexOf(Math.max(...hmm.currentProbs))] },
            { label: '因子投票信号', value: facView.toFixed(3) },
            { label: '波动率观点', value: volView.toFixed(3) + ' · 状态 ' + vol.regime },
            { label: 'MLP 观点', value: mlView.toFixed(3) + ' · 上涨概率 ' + (ml.lastProba * 100).toFixed(1) + '%' },
            { label: 'HMM 回测夏普 / 回撤', value: hmm.bt.metrics.sharpe.toFixed(2) + ' / ' + (hmm.bt.metrics.maxDD * 100).toFixed(2) + '%' },
            { label: '因子回测夏普 / 回撤', value: fac.bt.metrics.sharpe.toFixed(2) + ' / ' + (fac.bt.metrics.maxDD * 100).toFixed(2) + '%' },
            { label: 'MLP 测试准确率 / AUC', value: (ml.accTest * 100).toFixed(2) + '% / ' + ml.auc.toFixed(3) }
          ]}
        />
      </Panel>
    </div>
  );
}
