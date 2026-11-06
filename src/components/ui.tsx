import type { ReactNode } from 'react';
import type { DataSource } from '../data/types';

/* ============ 面板 ============ */
export function Panel({
  title,
  icon,
  desc,
  extra,
  children,
  style
}: {
  title?: string;
  icon?: string;
  desc?: string;
  extra?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <section className="panel" style={style}>
      {(title || extra) && (
        <div className="panel-head">
          <div>
            {title && (
              <div className="panel-title">
                {icon && <span className="ico">{icon}</span>}
                {title}
              </div>
            )}
            {desc && <div className="panel-desc">{desc}</div>}
          </div>
          {extra && <div className="panel-extra">{extra}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

/* ============ 指标卡 ============ */
export function MetricGrid({ items }: { items: { label: string; value: string; sub?: string; tone?: 'up' | 'down' | 'flat' }[] }) {
  return (
    <div className="metric-grid">
      {items.map((m) => (
        <div className="metric" key={m.label}>
          <div className="m-label">{m.label}</div>
          <div className={'m-value ' + (m.tone ?? '')}>{m.value}</div>
          {m.sub && <div className="m-sub">{m.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/* ============ 数学原理折叠面板 ============ */
export function MathPanel({ children }: { children: ReactNode }) {
  return (
    <details className="math-panel">
      <summary>📐 数学原理与公式推导</summary>
      <div className="math-body">{children}</div>
    </details>
  );
}

/* ============ 控制栏 ============ */
export function ControlBar({ children }: { children: ReactNode }) {
  return <div className="control-bar">{children}</div>;
}

export function CtrlGroup({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="ctrl-group">
      {label && <span className="g-label">{label}</span>}
      {children}
    </div>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt?: (v: number) => string;
}) {
  return (
    <label className="ctrl">
      {label}
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="val">{fmt ? fmt(value) : value}</span>
    </label>
  );
}

export function Select<T extends string | number>({
  label,
  value,
  options,
  onChange
}: {
  label?: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <label className="ctrl">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((o) => (
          <option key={String(o.value)} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/* ============ 数据源徽标 ============ */
const SRC_TEXT: Record<DataSource, string> = {
  tencent: '腾讯行情',
  eastmoney: '东方财富',
  naver: 'Naver（韩国）',
  sina: '新浪财经',
  yahoo: 'Yahoo',
  'yahoo-jp': 'Yahoo!ファイナンス',
  cache: '本地缓存',
  demo: '模拟数据 DEMO'
};

/** 缓存年龄的人话描述 */
function cacheAgeText(ts: number): string {
  const h = (Date.now() - ts) / 36e5;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}分钟前`;
  if (h < 48) return `${Math.round(h)}小时前`;
  return `${Math.round(h / 24)}天前`;
}

export function SourcePill({
  source,
  loading,
  cacheTs
}: {
  source: DataSource;
  loading?: boolean;
  cacheTs?: number;
}) {
  const text =
    source === 'cache' && cacheTs
      ? `缓存·${cacheAgeText(cacheTs)}`
      : SRC_TEXT[source];
  return (
    <span className={`src-pill s-${source}${loading ? ' loading' : ''}`} title={source === 'cache' ? '实时源暂不可达，正在后台尝试刷新；网络恢复后自动更新' : undefined}>
      <span className="dot" />
      {loading ? '加载中' : text}
    </span>
  );
}

/* ============ 方向徽章 ============ */
export function SignalBadge({ tone, text }: { tone: 'bull' | 'bear' | 'flat' | 'info'; text: string }) {
  const label = tone === 'bull' ? '看多' : tone === 'bear' ? '看空' : tone === 'flat' ? '中性' : '提示';
  return <span className={`badge ${tone}`}>{label === '提示' ? text : `${label} · ${text}`}</span>;
}

/* ============ 加载 / 空态 ============ */
export function Loading({ text = '模型计算中' }: { text?: string }) {
  return (
    <div className="loading-box">
      <span className="spinner" />
      {text}
    </div>
  );
}

export function EmptyTip({ text }: { text: string }) {
  return <div className="empty-tip">{text}</div>;
}

/* ============ 多选筹码 ============ */
export function ChipMulti({
  options,
  selected,
  onToggle
}: {
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (v: string) => void;
}) {
  return (
    <div className="chip-multi">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={'chip-toggle' + (selected.includes(o.value) ? ' on' : '')}
          onClick={() => onToggle(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ============ 数字格式 ============ */
export const fmtPct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
export const fmtNum = (x: number, d = 2) => x.toFixed(d);
export const fmtSigned = (x: number, d = 2) => `${x > 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
