import { useApp } from '../hooks/AppContext';
import { THEMES } from '../theme';

/** 顶栏三主题切换器：A 暗夜矩阵 / B 赛博红蓝 / C 量子白昼 */
export default function ThemeSwitcher() {
  const { theme, setTheme } = useApp();

  return (
    <div className="theme-switch" role="group" aria-label="界面主题">
      {THEMES.map((t) => {
        const on = t.id === theme;
        return (
          <button
            key={t.id}
            type="button"
            className={on ? 'on' : undefined}
            aria-pressed={on}
            title={`${t.label} · ${t.hint}`}
            onClick={() => setTheme(t.id)}
          >
            <i style={{ background: t.swatch }} aria-hidden="true" />
            <span>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}
