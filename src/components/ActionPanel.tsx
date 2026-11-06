import type { MomParams, MomReport } from '../math/momentum';
import { buildActionPlan, type ActionTone } from '../math/action';
import { Panel } from './ui';

const TONE_COLOR: Record<ActionTone, string> = {
  hold: 'var(--up)',
  watch: 'var(--accent)',
  avoid: 'var(--down)'
};

const fmt = (v: number | null, d = 2): string => (v == null ? '—' : v.toFixed(d));
const pct = (v: number | null, d = 2): string => (v == null ? '—' : (v * 100).toFixed(d) + '%');

/** 操作策略面板：把信号翻译成可执行的价位与纪律 */
export function ActionPanel({ report, params }: { report: MomReport; params: MomParams }) {
  const plan = buildActionPlan(report, params);
  const color = TONE_COLOR[plan.tone];

  const stats = [
    { label: '建议仓位', value: plan.positionText },
    { label: '最新收盘', value: plan.price.toFixed(2) },
    { label: plan.ma != null ? 'MA' + params.maLen : '年线', value: fmt(plan.ma) },
    { label: '趋势', value: plan.trendOk ? '站上' : '跌破' },
    { label: '区间动量', value: pct(report.raw) },
    { label: '年化波动', value: pct(report.vol, 1) }
  ];

  return (
    <Panel
      title="操作策略"
      icon="🧭"
      desc="按当前参数与最新收盘价直接推导，随参数联动"
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          flexWrap: 'wrap',
          marginBottom: 12
        }}
      >
        <span
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            borderRadius: 999,
            fontSize: 13,
            fontWeight: 600,
            color: color,
            border: '1px solid ' + color,
            background: 'rgba(127,127,127,0.08)',
            whiteSpace: 'nowrap'
          }}
        >
          {plan.headline}
        </span>
        <span style={{ color: 'var(--text-3)', fontSize: 13, lineHeight: 1.7, flex: '1 1 320px' }}>
          {plan.detail}
        </span>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 18,
          flexWrap: 'wrap',
          padding: '10px 12px',
          borderRadius: 8,
          border: '1px solid rgba(127,127,127,0.22)',
          marginBottom: 14
        }}
      >
        {stats.map((s) => (
          <div key={s.label} style={{ minWidth: 86 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 2 }}>{s.label}</div>
            <div style={{ fontSize: 15, fontWeight: 600 }}>{s.value}</div>
          </div>
        ))}
      </div>

      <div className="tbl-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>动作</th>
              <th className="num">触发价</th>
              <th className="num">距现价</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            {plan.triggers.map((t) => {
              const fired = t.action === '清仓' && t.price != null && plan.price < t.price;
              return (
                <tr key={t.action}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {t.action}
                    {fired && (
                      <span style={{ color: 'var(--down)', marginLeft: 6, fontSize: 12 }}>已触发</span>
                    )}
                  </td>
                  <td className="num" style={{ color: t.action === '清仓' ? 'var(--down)' : 'var(--up)' }}>
                    {fmt(t.price)}
                  </td>
                  <td className="num" style={{ color: t.distance == null ? 'var(--text-3)' : t.distance >= 0 ? 'var(--up)' : 'var(--down)' }}>
                    {t.distance == null ? '—' : (t.distance >= 0 ? '+' : '') + pct(t.distance, 1)}
                  </td>
                  <td style={{ color: 'var(--text-3)', fontSize: 12.5 }}>{t.note}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6, color: 'var(--text-3)' }}>执行纪律</div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.9 }}>
          {plan.rules.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ol>
      </div>

      <div style={{ marginTop: 10, fontSize: 11.5, color: 'var(--text-3)' }}>
        当前参数：{plan.params.map((x) => x.label + ' ' + x.value).join(' · ')}
      </div>
    </Panel>
  );
}
