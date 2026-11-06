import { useEffect, useMemo, useState } from 'react';
import EChart from '../components/EChart';
import {
  ControlBar,
  CtrlGroup,
  EmptyTip,
  Loading,
  MathPanel,
  MetricGrid,
  Panel,
  SignalBadge,
  SourcePill,
  fmtPct,
  fmtSigned
} from '../components/ui';
import { C, gaugeOption, lineOption } from '../components/chartOptions';
import { useApp, useKline, useKlines } from '../hooks/AppContext';
import { BOND_ETF, MARKET_LABEL, RP_DEFAULT, SCAN_DEFAULT, bondRefFor, getSymbol } from '../data/symbols';
import { buildStrategy, quickScan, PROFILES, type RiskProfile, type QuickScan } from '../pipelines/strategy';
import { runRpModel } from '../pipelines';
import { sma } from '../math/indicators';

const PROFILE_ORDER: RiskProfile[] = ['conservative', 'balanced', 'aggressive'];

export default function StrategyPage() {
  const { settings, btCfg, extras, ensureExtras } = useApp();
  const bench = useKline(settings.benchmark);
  const bond = useKline(BOND_ETF);
  const [profile, setProfile] = useState<RiskProfile>('balanced');

  const fundFlow = extras[settings.benchmark]?.fundFlow ?? null;
  // 仅 A 股基准使用国债 ETF 作为股债性价比参考；境外基准该因子自动剔除
  const benchSym = getSymbol(settings.benchmark);
  const bondRef = bondRefFor(benchSym?.market ?? 'CN', bond?.bars);
  const ready = bench && !bench.loading && bench.bars.length >= 250 && bond && bond.bars.length > 30;

  // 资金流/估值快照属于副作用，放到 effect 里触发，避免渲染期更新 AppProvider
  useEffect(() => {
    ensureExtras(settings.benchmark);
  }, [ensureExtras, settings.benchmark]);

  const strategy = useMemo(() => {
    if (!ready) return null;
    return buildStrategy(bench.bars, fundFlow, bondRef, btCfg, { profile });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, bench, bond, fundFlow, bondRef, profile, btCfg]);

  // 多市场指数速览（渐进式计算，逐行呈现，避免长时间白屏）
  const scanKlines = useKlines(SCAN_DEFAULT);
  const [scans, setScans] = useState<Record<string, QuickScan>>({});
  useEffect(() => {
    setScans({});
    let cancelled = false;
    const allReady = SCAN_DEFAULT.every((c) => {
      const st = scanKlines[c];
      return st && !st.loading && st.bars.length >= 250;
    });
    if (!allReady) return;
    const run = (i: number) => {
      if (cancelled || i >= SCAN_DEFAULT.length) return;
      const c = SCAN_DEFAULT[i];
      const st = scanKlines[c];
      if (st && !st.loading && st.bars.length >= 250) {
        const ref = bondRefFor(getSymbol(c)?.market ?? 'CN', bond?.bars);
        const q = quickScan(st.bars, null, ref, profile);
        setScans((prev) => ({ ...prev, [c]: { ...q, source: st.source } }));
      }
      setTimeout(() => run(i + 1), 60);
    };
    const t = setTimeout(() => run(0), 80);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanKlines, profile]);

  // 跨资产 ERC 配置
  const rpKlines = useKlines(RP_DEFAULT);
  const rpReady = RP_DEFAULT.every((c) => rpKlines[c] && !rpKlines[c].loading && rpKlines[c].bars.length >= 150);
  const rp = useMemo(() => {
    if (!rpReady) return null;
    const barsMap: Record<string, typeof rpKlines[string]['bars']> = {};
    for (const c of RP_DEFAULT) barsMap[c] = rpKlines[c].bars;
    const names = Object.fromEntries(RP_DEFAULT.map((c) => [c, getSymbol(c)!.name]));
    return runRpModel(barsMap, names, RP_DEFAULT, 120, 20, 'sh510300', btCfg);
  }, [rpReady, rpKlines, btCfg]);

  if (!bench || bench.loading) return <Loading text="正在拉取行情…" />;
  if (!strategy) return <EmptyTip text="行情数据不足（至少需要 250 个交易日）" />;

  const s = strategy;
  const closes = bench.bars.map((b) => b.close);
  const dates = bench.bars.map((b) => b.date);
  const ma20s = sma(closes, 20);
  const ma60s = sma(closes, 60);
  const ma250s = sma(closes, 250);

  const viewItems = [
    { name: 'HMM 状态', v: s.views.hmm },
    { name: '因子投票', v: s.views.factor },
    { name: '波动率', v: s.views.vol },
    { name: 'MLP', v: s.views.ml ?? 0 }
  ];

  return (
    <div>
      <div className="page-title-row">
        <h2>🎯 策略信号 · 买卖操作计划</h2>
        <span className="en">Strategy Signals · Action Plan</span>
      </div>
      <p className="page-lead">
        系统汇总四大模型对 <b>{getSymbol(settings.benchmark)?.name}</b> 的观点，按透明规则合成目标仓位，
        并给出<b>加仓触发、减仓触发、止损价、目标位</b>等具体操作指令。所有规则见页面底部「策略规则」。
      </p>

      <ControlBar>
        <CtrlGroup label="标的">
          <span style={{ fontSize: 13 }}>{getSymbol(settings.benchmark)?.name}</span>
          <SourcePill source={bench.source} loading={bench.loading} />
        </CtrlGroup>
        <CtrlGroup label="风险档位">
          {PROFILE_ORDER.map((p) => (
            <button
              key={p}
              type="button"
              className={'chip-toggle' + (profile === p ? ' on' : '')}
              onClick={() => setProfile(p)}
              title={PROFILES[p].desc}
            >
              {PROFILES[p].label}（上限 {fmtPct(PROFILES[p].maxPos, 0)}）
            </button>
          ))}
        </CtrlGroup>
      </ControlBar>

      <div className="grid-2">
        <Panel title="综合观点与目标仓位" icon="🎚">
          <EChart option={gaugeOption(s.composite, '综合信号')} height={250} />
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, marginTop: -4 }}>
            <SignalBadge
              tone={s.composite > 0.15 ? 'bull' : s.composite < -0.15 ? 'bear' : 'flat'}
              text={s.composite.toFixed(2)}
            />
            <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
              建议仓位 <b style={{ color: 'var(--accent)' }}>{fmtPct(s.targetPosition, 0)}</b>（{s.bucket}）
            </span>
          </div>
          <div style={{ height: 10 }} />
          <MetricGrid
            items={[
              { label: 'HMM 状态', value: s.state.label, sub: `概率 ${fmtPct(s.state.prob, 1)}` },
              { label: '状态观点', value: `${s.state.view > 0 ? '+' : ''}${s.state.view.toFixed(2)}` },
              { label: '因子信号 S', value: `${s.views.factor > 0 ? '+' : ''}${s.views.factor.toFixed(2)}`, tone: s.views.factor > 0 ? 'up' : s.views.factor < 0 ? 'down' : 'flat' },
              { label: '波动率 regime', value: s.volRegime === 'high' ? '上行' : s.volRegime === 'low' ? '回落' : '中性' },
              { label: 'MLP 上涨概率', value: s.proba == null ? '—' : fmtPct(s.proba, 1), sub: s.views.ml == null ? 'AUC<0.5 未采用' : undefined },
              { label: '20 日涨跌', value: fmtSigned(s.rets20), tone: s.rets20 > 0 ? 'up' : 'down' }
            ]}
          />
        </Panel>

        <Panel title="📜 操作计划" icon="🧭" desc={`风险档位：${PROFILES[s.profile].label} · ${PROFILES[s.profile].desc}`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <PlanRow icon="⏺" tone="accent" label="当前动作" text={s.plan.current} />
            <PlanRow icon="⬆️" tone="up" label="加仓触发" text={s.plan.addTrigger} />
            <PlanRow icon="⬇️" tone="down" label="减仓触发" text={s.plan.reduceTrigger} />
            <div className="grid-2" style={{ gap: 10 }}>
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>止损价（收盘跌破清仓）</div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--down)' }}>{s.plan.stopLoss.toFixed(2)}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>距现价 {fmtSigned(s.plan.stopLoss / s.close - 1)}</div>
              </div>
              <div style={{ background: 'var(--panel-2)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>目标位（年线 / 250 日高）</div>
                <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--up)' }}>
                  {s.plan.takeProfit1.toFixed(2)} / {s.plan.takeProfit2.toFixed(2)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                  空间 {fmtSigned(s.plan.takeProfit1 / s.close - 1)} / {fmtSigned(s.plan.takeProfit2 / s.close - 1)}
                </div>
              </div>
            </div>
            {s.notes.length > 0 && (
              <div className="notice">
                {s.notes.map((n, i) => (
                  <div key={i}>⚠️ {n}</div>
                ))}
              </div>
            )}
          </div>
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="关键位与均线体系" icon="📍" desc="止损取 20 日低点与档位止损率的较小者；目标位参考年线与 250 日高点">
          <EChart
            option={lineOption(dates, [
              { name: '收盘价', data: closes, color: C.accent },
              { name: 'MA20', data: ma20s.map((v) => (Number.isNaN(v) ? null : v)), color: C.orange },
              { name: 'MA60', data: ma60s.map((v) => (Number.isNaN(v) ? null : v)), color: C.cyan },
              { name: 'MA250 年线', data: ma250s.map((v) => (Number.isNaN(v) ? null : v)), color: C.purple, dashed: true }
            ])}
            height={300}
          />
        </Panel>
        <Panel title="模型观点分解" icon="🧮" desc="各模型观点 ∈ [-1,+1]；MLP 不采用时显示为 0">
          <EChart
            option={{
              tooltip: { trigger: 'axis' },
              grid: { left: 70, right: 40, top: 20, bottom: 28 },
              xAxis: { type: 'value', min: -1, max: 1, axisLabel: { color: C.text, fontSize: 11 }, splitLine: { lineStyle: { color: C.grid } } },
              yAxis: { type: 'category', data: viewItems.map((i) => i.name), axisLabel: { color: C.text, fontSize: 12 } },
              series: [
                {
                  type: 'bar',
                  barMaxWidth: 22,
                  data: viewItems.map((i) => ({
                    value: Number(i.v.toFixed(3)),
                    itemStyle: { color: i.v > 0.05 ? C.up : i.v < -0.05 ? C.down : C.gray, borderRadius: 3 }
                  })),
                  label: {
                    show: true,
                    position: 'right',
                    fontSize: 11,
                    color: C.text,
                    formatter: (p) => {
                      const v = (p as unknown as { value: number }).value;
                      return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
                    }
                  }
                }
              ]
            }}
            height={300}
          />
          <MetricGrid
            items={s.dims.map((d) => ({
              label: d.dim,
              value: `${d.score > 0 ? '+' : ''}${d.score.toFixed(2)}`,
              tone: d.score > 0.05 ? ('up' as const) : d.score < -0.05 ? ('down' as const) : ('flat' as const)
            }))}
          />
        </Panel>
      </div>

      <Panel
        title="全球市场速览"
        icon="🔭"
        desc="HMM + 因子 + 波动率合成（不含 MLP），应用相同风控规则；逐行计算中"
      >
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>市场</th>
                <th>指数</th>
                <th>数据源</th>
                <th className="num">收盘</th>
                <th className="num">20日</th>
                <th>HMM 状态</th>
                <th className="num">状态观点</th>
                <th className="num">因子 S</th>
                <th>波动率</th>
                <th className="num">综合</th>
                <th className="num">建议仓位</th>
              </tr>
            </thead>
            <tbody>
              {SCAN_DEFAULT.map((c) => {
                const sym = getSymbol(c);
                const q = scans[c];
                if (!q) {
                  return (
                    <tr key={c}>
                      <td>
                        <span className="badge info">{sym ? MARKET_LABEL[sym.market] : '—'}</span>
                      </td>
                      <td>{sym?.name ?? c}</td>
                      <td colSpan={9} style={{ color: 'var(--text-3)' }}>
                        计算中…
                      </td>
                    </tr>
                  );
                }
                return (
                  <tr key={c}>
                    <td>
                      <span className="badge info">{sym ? MARKET_LABEL[sym.market] : '—'}</span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{sym?.name}</td>
                    <td>
                      <span className={`src-pill s-${q.source ?? 'demo'}`} style={{ fontSize: 10.5, padding: '1px 7px' }}>
                        <span className="dot" />
                        {q.source === 'tencent'
                          ? '腾讯'
                          : q.source === 'eastmoney'
                            ? '东财'
                            : q.source === 'naver'
                              ? 'Naver'
                              : q.source === 'sina'
                                ? '新浪'
                                : q.source === 'yahoo'
                                  ? 'Yahoo'
                                  : q.source === 'cache'
                                    ? '缓存'
                                    : 'DEMO'}
                      </span>
                    </td>
                    <td className="num">{q.close.toFixed(2)}</td>
                    <td className="num" style={{ color: q.rets20 > 0 ? 'var(--up)' : 'var(--down)' }}>{fmtSigned(q.rets20)}</td>
                    <td>{q.state}</td>
                    <td className="num" style={{ color: q.view > 0 ? 'var(--up)' : q.view < 0 ? 'var(--down)' : 'var(--text-2)' }}>{q.view > 0 ? '+' : ''}{q.view.toFixed(2)}</td>
                    <td className="num" style={{ color: q.factorSignal > 0 ? 'var(--up)' : 'var(--down)' }}>
                      {q.factorSignal > 0 ? '+' : ''}{q.factorSignal.toFixed(2)}
                    </td>
                    <td>{q.volRegime === 'high' ? '上行' : q.volRegime === 'low' ? '回落' : '中性'}</td>
                    <td className="num" style={{ color: q.composite > 0 ? 'var(--up)' : 'var(--down)', fontWeight: 700 }}>
                      {q.composite > 0 ? '+' : ''}{q.composite.toFixed(2)}
                    </td>
                    <td className="num">{fmtPct(q.targetPosition, 0)}（{q.bucket}）</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 8, lineHeight: 1.7 }}>
          注：跨境指数的资金维度因子暂不可用（主力资金流接口仅覆盖 A 股），已自动剔除；
          估值类因子使用价格相对均线/区间的分位代理。韩国数据来自 Naver（经本地代理或公共 CORS 代理转发），首次加载可能稍慢。
        </div>
      </Panel>

      {rp && (
        <Panel title="跨资产配置（ERC 风险平价）" icon="⚖️" desc="120 日窗口 / 月度再平衡；与股票端观点互为镜像——股票综合转正时可适度降低债券占比">
          <div className="grid-2">
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>资产</th>
                    <th className="num">ERC 权重</th>
                    <th className="num">风险贡献</th>
                    <th className="num">年化波动</th>
                  </tr>
                </thead>
                <tbody>
                  {rp.names.map((n, i) => (
                    <tr key={n}>
                      <td>{n}</td>
                      <td className="num">{fmtPct(rp.weights.erc[i], 1)}</td>
                      <td className="num">{fmtPct(rp.rc[i], 1)}</td>
                      <td className="num">{fmtPct(rp.vols[i], 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <MetricGrid
              items={[
                { label: '组合年化', value: fmtSigned(rp.metrics.erc.cagr), tone: rp.metrics.erc.cagr > 0 ? 'up' : 'down' },
                { label: '夏普', value: rp.metrics.erc.sharpe.toFixed(2) },
                { label: '最大回撤', value: fmtPct(rp.metrics.erc.maxDD) },
                { label: '债券占比', value: fmtPct(rp.weights.erc[RP_DEFAULT.indexOf('sh511010')] ?? 0, 1), sub: '综合观点为负时超配债券' }
              ]}
            />
          </div>
        </Panel>
      )}

      <Panel title="📐 策略规则" icon="">
        <MathPanel>
          <pre>{`观点归一化（各模型 → [-1,+1]）:
  HMM:     2·P(上涨侧状态) − 1
  因子:    综合信号 S（四维 17 因子加权投票）
  波动率:  −clip((GARCH预测 − HV20)/0.1, -1, 1)   （预测波动高 → 看空）
  MLP:     clip((上涨概率 − 0.5)·4, -1, 1)

合成:  综合 = 0.30·HMM + 0.30·因子 + 0.20·波动率 + 0.20·MLP
       （MLP 样本外 AUC<0.5 判定无预测力，剔除后权重重新归一化）

风控叠加（按序生效，全部记入 notes）:
  a. 逆势降档:  综合>+0.1 且 20 日跌幅>8% → 仓位×0.5
  b. 波动率收缩: GARCH 预测>已实现 → 仓位×0.5
  c. 技术分歧:  技术因子<-0.5 且综合偏多 → 仓位封顶 30%
  d. 风险档位:  保守 30% / 稳健 70% / 激进 100%

操作计划:
  止损价 = min(20 日最低价, 现价×(1−档位止损率))
  目标位 = 年线(MA250) / 250 日最高价
  加仓触发 = HMM 进入上涨侧(概率>60%) 且 因子 S 站上 +0.15
  减仓触发 = HMM 切换下跌侧 或 因子 S 跌破 −0.15（减半）；破止损价（清仓）`}</pre>
          <p style={{ color: 'var(--text-3)' }}>
            设计原则：<b>规则先于数值</b>——每个仓位数字都能被追溯到最后一条规则；
            <b>只做多</b>（综合为负时空仓观望，不做裸空）；单标的建议仓位已含风险档位上限，
            实际组合请再按分散度要求折算。
          </p>
        </MathPanel>
      </Panel>
    </div>
  );
}

function PlanRow({ icon, tone, label, text }: { icon: string; tone: 'accent' | 'up' | 'down'; label: string; text: string }) {
  const color = tone === 'up' ? 'var(--up)' : tone === 'down' ? 'var(--down)' : 'var(--accent)';
  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
      <span style={{ fontSize: 15, lineHeight: 1.6 }}>{icon}</span>
      <div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{label}</div>
        <div style={{ fontSize: 12.5, color, lineHeight: 1.7 }}>{text}</div>
      </div>
    </div>
  );
}
