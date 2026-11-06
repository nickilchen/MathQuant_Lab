/**
 * 三主题定义与切换
 * A 暗夜矩阵 matrix / B 赛博红蓝 cyber / C 量子白昼 quantum
 *
 * 真正的颜色值只存在于 styles.css 的 token 块里，这里只管「选哪套」，
 * 以及把选择结果写到 <html data-theme="..."> 上。图表色板由
 * chartOptions.syncPalette() 从同一批 CSS 变量读取，避免两处维护。
 */

export type ThemeId = 'matrix' | 'cyber' | 'quantum';

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  en: string;
  hint: string;
  /** 切换器小圆点（与 CSS token 保持一致） */
  swatch: string;
}

export const THEMES: ThemeMeta[] = [
  {
    id: 'matrix',
    label: '暗夜矩阵',
    en: 'MATRIX',
    hint: '墨黑玻璃 · 青绿粒子 · 低眩光',
    swatch: 'linear-gradient(135deg,#22d3ee,#34d399)'
  },
  {
    id: 'cyber',
    label: '赛博红蓝',
    en: 'CYBER',
    hint: '深海军蓝 · 电光蓝 × 霓虹玫',
    swatch: 'linear-gradient(135deg,#4d8dff,#ff5c8a)'
  },
  {
    id: 'quantum',
    label: '量子白昼',
    en: 'QUANTUM',
    hint: '冷灰白 · 焦橙 × 激光紫（印刷级对比）',
    swatch: 'linear-gradient(135deg,#ad4a0a,#6d4aff)'
  }
];

export const DEFAULT_THEME: ThemeId = 'matrix';
export const THEME_STORAGE_KEY = 'mql-theme';

export function isThemeId(v: unknown): v is ThemeId {
  return v === 'matrix' || v === 'cyber' || v === 'quantum';
}

export function readStoredTheme(): ThemeId {
  try {
    const v = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (isThemeId(v)) return v;
  } catch {
    /* 隐私模式下 localStorage 可能不可用 */
  }
  return DEFAULT_THEME;
}

/** 写入 data-theme；实际配色由 styles.css 的 token 块接管 */
export function applyTheme(id: ThemeId): void {
  document.documentElement.setAttribute('data-theme', id);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, id);
  } catch {
    /* ignore */
  }
}
