import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useApp } from '../hooks/AppContext';
import { useMonitor } from '../hooks/MonitorContext';
import { indicesByMarket } from '../data/symbols';
import { SourcePill } from './ui';
import ThemeSwitcher from './ThemeSwitcher';
import CommandPalette from './CommandPalette';

export default function HeaderBar() {
  const { settings, update, klines, registerStock } = useApp();
  const { unread, config } = useMonitor();
  const [open, setOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  const bench = klines[settings.benchmark];

  // 全局快捷键：Ctrl/Cmd + K 打开标的搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <header className="header">
      <h1>数学模型股市分析终端</h1>
      <span className="sub">Market-State Mathematical Models · 纯浏览器端计算</span>
      <div className="header-spacer" />
      <label className="header-field">
        基准
        <select value={settings.benchmark} onChange={(e) => update({ benchmark: e.target.value })}>
          {indicesByMarket().map((g) => (
            <optgroup key={g.market} label={g.label}>
              {g.items.map((s) => (
                <option key={s.code} value={s.code}>
                  {s.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="header-field">
        回看
        <select value={settings.days} onChange={(e) => update({ days: Number(e.target.value) })}>
          <option value={250}>250 日</option>
          <option value={500}>500 日</option>
          <option value={750}>750 日</option>
          <option value={1000}>1000 日</option>
          <option value={1500}>1500 日</option>
          <option value={2000}>2000 日</option>
        </select>
      </label>
      {settings.days >= 1000 && (
        <span style={{ fontSize: 11, color: 'var(--text-3)' }} title="长周期下 HMM/因子/MLP 计算量增加，首次加载约需数秒">⏳ 长周期</span>
      )}
      {bench && <SourcePill source={bench.source} loading={bench.loading} cacheTs={bench.cacheTs} />}
      <button
        type="button"
        className={`gear-btn mon-badge-btn${config.running ? '' : ' mon-off'}`}
        onClick={() => navigate('/monitor')}
        title={config.running ? `实时监控运行中 · ${unread} 条未读` : '实时监控已暂停'}
      >
        🔔 监控{unread > 0 ? <span className="mon-badge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>
      <button type="button" className="gear-btn" onClick={() => setPaletteOpen(true)} title="搜索标的（Ctrl/Cmd + K）">
        🔍 搜索
      </button>
      <button type="button" className="gear-btn" onClick={() => navigate('/ai-settings')} title="AI 设置（配置仅存本机）">
        🤖 AI
      </button>
      <ThemeSwitcher />
      <button type="button" className="gear-btn" onClick={() => setOpen((o) => !o)}>
        ⚙️ 参数
      </button>
      {open && (
        <div className="settings-pop">
          <h3>回测成本与参数</h3>
          <div className="settings-row">
            <span>买入成本（万分之）</span>
            <input
              type="number"
              step="0.5"
              value={settings.buyBps}
              onChange={(e) => update({ buyBps: Number(e.target.value) })}
            />
          </div>
          <div className="settings-row">
            <span>卖出佣金（万分之）</span>
            <input
              type="number"
              step="0.5"
              value={settings.sellBps}
              onChange={(e) => update({ sellBps: Number(e.target.value) })}
            />
          </div>
          <div className="settings-row">
            <span>卖出印花税（万分之）</span>
            <input
              type="number"
              step="1"
              value={settings.stampBps}
              onChange={(e) => update({ stampBps: Number(e.target.value) })}
            />
          </div>
          <div className="settings-note">
            A 股默认：佣金万 2.5（双边）+ 印花税千 1（仅卖出）。修改后所有页面回测即时重算。
          </div>
        </div>
      )}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onPick={(hit) => {
          registerStock(hit);
          navigate('/stock?code=' + encodeURIComponent(hit.code));
        }}
      />
    </header>
  );
}
