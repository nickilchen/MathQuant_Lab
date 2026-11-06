import type { EChartsOption } from 'echarts';

/** 当前主题图表色板（由 syncPalette() 从 CSS 变量刷新，涨红跌绿遵循 A 股惯例） */
export const C = {
  up: '#e04343',
  down: '#0e9f6e',
  accent: '#2563eb',
  orange: '#f08c3c',
  purple: '#8b5cf6',
  cyan: '#06b6d4',
  amber: '#f59e0b',
  gray: '#94a3b8',
  grid: '#edf0f6',
  text: '#5b6675',
  axis: '#c9d2e0',
  bench: '#94a3b8',
  panel: '#ffffff',
  panel2: '#f8fafc',
  border: '#e5e9f2',
  track: '#edf0f6',
  tipBg: 'rgba(255,255,255,0.98)',
  tipBd: '#e5e9f2',
  hm: ['#0e9f6e', '#f5f7fa', '#e04343'],
  hmText: '#1e2733',
  states: ['#d43030', '#f08c3c', '#2fa36b', '#0b7a43']
};

/**
 * 把 CSS token 同步进图表色板。
 * 主题切换时由 ThemeProvider/header 调用一次，之后所有 option 构造都用新值。
 */
export function syncPalette(): void {
  if (typeof window === 'undefined' || !document.documentElement) return;
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback;

  C.up = v('--up', C.up);
  C.down = v('--down', C.down);
  C.accent = v('--chart-accent', C.accent);
  C.orange = v('--chart-orange', C.orange);
  C.purple = v('--chart-purple', C.purple);
  C.cyan = v('--chart-cyan', C.cyan);
  C.amber = v('--chart-amber', C.amber);
  C.gray = v('--chart-gray', C.gray);
  C.bench = C.gray;
  C.grid = v('--grid-c', C.grid);
  C.text = v('--text-3', C.text);
  C.axis = v('--axis', C.axis);
  C.panel = v('--panel', C.panel);
  C.panel2 = v('--panel-2', C.panel2);
  C.border = v('--border-strong', C.border);
  C.track = v('--track', C.track);
  C.tipBg = v('--tip-bg', C.tipBg);
  C.tipBd = v('--tip-bd', C.tipBd);
  C.hm = [v('--hm-lo', C.hm[0]), v('--hm-mid', C.hm[1]), v('--hm-hi', C.hm[2])];
  C.hmText = v('--hm-text', C.hmText);
  C.states = [
    v('--state-1', C.states[0]),
    v('--state-2', C.states[1]),
    v('--state-3', C.states[2]),
    v('--state-4', C.states[3])
  ];
}

/** 四状态配色按标签取色（颜色跟随语义，不跟随排名） */
const STATE_INDEX: Record<string, number> = {
  趋势上涨: 0,
  上涨: 0,
  极端上涨: 0,
  震荡上涨: 1,
  震荡下跌: 2,
  下跌: 2,
  趋势下跌: 3,
  极端下跌: 3
};

export function stateColorOf(label: string, rank = 0): string {
  if (label === '震荡') return C.gray;
  const i = STATE_INDEX[label];
  return C.states[(i ?? rank) % C.states.length] ?? C.accent;
}

/** 兼容旧引用：颜色在 syncPalette 后仍然有效 */
export function stateColors(): string[] {
  return C.states;
}

function tooltipBase() {
  return {
    trigger: 'axis' as const,
    axisPointer: {
      type: 'cross' as const,
      label: { backgroundColor: C.panel2, color: C.text, borderColor: C.border, borderWidth: 1 }
    },
    backgroundColor: C.tipBg,
    borderColor: C.tipBd,
    borderWidth: 1,
    textStyle: { color: C.text, fontSize: 12 },
    extraCssText: 'box-shadow: 0 10px 28px -16px rgba(0,0,0,.55); border-radius: 8px;'
  };
}

const baseGrid = { left: 56, right: 20, top: 32, bottom: 28 };

export function pctAxis(name = '收益率') {
  return {
    type: 'value' as const,
    name,
    axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
    splitLine: { lineStyle: { color: C.grid } }
  };
}

export function numAxis(name = '') {
  return {
    type: 'value' as const,
    name,
    axisLabel: { color: C.text, fontSize: 11 },
    splitLine: { lineStyle: { color: C.grid } }
  };
}

function catAxis(dates: string[]) {
  return {
    type: 'category' as const,
    data: dates,
    axisLabel: { color: C.text, fontSize: 10 },
    axisLine: { lineStyle: { color: C.axis } }
  };
}

export interface LineSeries {
  name: string;
  data: (number | null)[];
  color?: string;
  area?: boolean;
  dashed?: boolean;
  yAxisIndex?: number;
  stack?: string;
  smooth?: boolean;
  lineWidth?: number;
}

export function lineOption(
  dates: string[],
  series: LineSeries[],
  opts: { yName?: string; pct?: boolean; rightName?: string } = {}
): EChartsOption {
  const hasDual = series.some((s) => s.yAxisIndex === 1);
  const left = opts.pct ? pctAxis(opts.yName ?? '') : numAxis(opts.yName ?? '');
  const right = { ...numAxis(opts.rightName ?? ''), position: 'right' as const, splitLine: { show: false } };
  return {
    tooltip: tooltipBase(),
    legend: { top: 0, textStyle: { color: C.text, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: baseGrid,
    xAxis: catAxis(dates),
    yAxis: hasDual ? [left, right] : left,
    dataZoom: dates.length > 260 ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4 }] : [],
    series: series.map((s) => ({
      name: s.name,
      type: 'line',
      data: s.data,
      showSymbol: false,
      smooth: s.smooth ?? false,
      lineStyle: { width: s.lineWidth ?? 1.6, color: s.color ?? C.accent, type: s.dashed ? 'dashed' : 'solid' },
      itemStyle: { color: s.color ?? C.accent },
      areaStyle: s.area ? { color: s.color ?? C.accent, opacity: 0.12 } : undefined,
      yAxisIndex: s.yAxisIndex,
      stack: s.stack,
      connectNulls: false
    }))
  };
}

/**
 * 占比堆叠面积（100% 口径）
 * 用于机构类型持仓占比这类「各分量之和恒为 100%」的结构演化图。
 */
export function stackedAreaOption(
  dates: string[],
  series: { name: string; data: (number | null)[]; color?: string }[],
  opts: { yName?: string; max?: number } = {}
): EChartsOption {
  return {
    tooltip: {
      ...tooltipBase(),
      valueFormatter: (v) => (v == null ? '-' : `${Number(v).toFixed(2)}%`)
    },
    legend: { top: 0, textStyle: { color: C.text, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: baseGrid,
    xAxis: catAxis(dates),
    yAxis: {
      type: 'value',
      name: opts.yName ?? '占比',
      min: 0,
      // 不传 max 时按数据自适应（用于「各类占比之和 = 机构总占比」的绝对口径）
      max: opts.max,
      axisLabel: { color: C.text, fontSize: 11, formatter: (v: number) => `${v.toFixed(0)}%` },
      splitLine: { lineStyle: { color: C.grid } }
    },
    series: series.map((s) => ({
      name: s.name,
      type: 'line',
      data: s.data,
      showSymbol: false,
      stack: 'ratio',
      lineStyle: { width: 0, color: s.color ?? C.accent },
      itemStyle: { color: s.color ?? C.accent },
      areaStyle: { color: s.color ?? C.accent, opacity: 0.75 },
      emphasis: { focus: 'series' }
    }))
  };
}

/**
 * 带正负色的横向条形（涨红跌绿）
 * 用于「各类型环比增减仓」这类一正一负的对比。
 */
export function signedBarOption(
  categories: string[],
  values: number[],
  opts: { unit?: string; name?: string; inverse?: boolean; vertical?: boolean } = {}
): EChartsOption {
  const unit = opts.unit ?? 'pp';

  // 竖向模式用于「按日期排列的资金净流入」：类目多、标签长，横条会挤成一团
  if (opts.vertical) {
    return {
      tooltip: {
        ...tooltipBase(),
        valueFormatter: (v) => (v == null ? '-' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}${unit}`)
      },
      grid: { left: 54, right: 14, top: 26, bottom: 46 },
      xAxis: {
        type: 'category',
        data: categories,
        axisLabel: { color: C.text, fontSize: 9.5, rotate: 45, interval: 0, margin: 8 },
        axisLine: { lineStyle: { color: C.axis } },
        axisTick: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: C.text, fontSize: 10, formatter: (v: number) => `${v.toFixed(0)}${unit}` },
        splitLine: { lineStyle: { color: C.grid } }
      },
      series: [
        {
          type: 'bar',
          name: opts.name ?? '净流入',
          barMaxWidth: 16,
          data: values.map((v) => ({
            value: Number(v.toFixed(3)),
            itemStyle: {
              color: v >= 0 ? C.up : C.down,
              borderRadius: v >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3]
            },
            label: {
              show: true,
              position: v >= 0 ? 'top' : 'bottom',
              fontSize: 8.5,
              color: C.text,
              formatter: `${v > 0 ? '+' : ''}${v.toFixed(0)}`
            }
          }))
        }
      ]
    };
  }

  return {
    tooltip: {
      ...tooltipBase(),
      valueFormatter: (v) => (v == null ? '-' : `${Number(v) > 0 ? '+' : ''}${Number(v).toFixed(2)}${unit}`)
    },
    grid: { left: 78, right: 34, top: 12, bottom: 24 },
    xAxis: {
      type: 'value',
      axisLabel: { color: C.text, fontSize: 10, formatter: (v: number) => `${v.toFixed(1)}${unit}` },
      splitLine: { lineStyle: { color: C.grid } }
    },
    yAxis: {
      type: 'category',
      data: categories,
      // ECharts 默认把第一个类目放在最下方；排行类图表需要「第一名在上」
      inverse: opts.inverse ?? false,
      axisLabel: { color: C.text, fontSize: 11 },
      axisLine: { lineStyle: { color: C.axis } },
      splitLine: { show: false }
    },
    series: [
      {
        type: 'bar',
        name: opts.name ?? '环比',
        barMaxWidth: 18,
        data: values.map((v) => ({
          value: Number(v.toFixed(3)),
          itemStyle: { color: v >= 0 ? C.up : C.down, borderRadius: 3 }
        })),
        label: {
          show: true,
          position: 'right',
          fontSize: 10,
          color: C.text,
          formatter: (p) => {
            const v = Number((p as unknown as { value: number }).value);
            return `${v > 0 ? '+' : ''}${v.toFixed(2)}`;
          }
        }
      }
    ]
  };
}

/**
 * 横向条形 + 单项高亮（用于「同行业对比」里突出当前标的）
 */
export function highlightBarOption(
  categories: string[],
  values: number[],
  highlightIndex: number,
  opts: { unit?: string; name?: string } = {}
): EChartsOption {
  const unit = opts.unit ?? '%';
  return {
    tooltip: {
      ...tooltipBase(),
      valueFormatter: (v) => (v == null ? '-' : `${Number(v).toFixed(2)}${unit}`)
    },
    grid: { left: 92, right: 46, top: 10, bottom: 24 },
    xAxis: {
      type: 'value',
      axisLabel: { color: C.text, fontSize: 10, formatter: (v: number) => `${v.toFixed(0)}${unit}` },
      splitLine: { lineStyle: { color: C.grid } }
    },
    yAxis: {
      type: 'category',
      data: categories,
      inverse: true,
      axisLabel: { color: C.text, fontSize: 10.5 },
      axisLine: { lineStyle: { color: C.axis } },
      splitLine: { show: false }
    },
    series: [
      {
        type: 'bar',
        name: opts.name ?? '机构持股',
        barMaxWidth: 14,
        data: values.map((v, i) => ({
          // 不预先截断精度，否则标签四舍五入会与面板里的数值差 0.01
          value: v,
          itemStyle: {
            color: i === highlightIndex ? C.up : C.accent,
            opacity: i === highlightIndex ? 1 : 0.55,
            borderRadius: 3
          }
        })),
        label: {
          show: true,
          position: 'right',
          fontSize: 10,
          color: C.text,
          formatter: (p) => `${Number((p as unknown as { value: number }).value).toFixed(2)}`
        }
      }
    ]
  };
}

/**
 * 分布直方图：高亮某一箱（当前标的所在区间），并用标线标出均值/中位。
 */
export function histogramOption(
  labels: string[],
  counts: number[],
  opts: { highlightBin?: number; lineBins?: { name: string; bin: number }[]; yName?: string } = {}
): EChartsOption {
  const marks = (opts.lineBins ?? [])
    .filter((l) => l.bin >= 0 && l.bin < labels.length)
    .map((l) => ({ name: l.name, xAxis: labels[l.bin] }));
  return {
    tooltip: {
      ...tooltipBase(),
      formatter: (p) => {
        const it = (p as unknown as { name: string; value: number }[])[0];
        return `${it.name}%<br/>成分股 ${it.value} 家`;
      }
    },
    grid: { left: 44, right: 18, top: 26, bottom: 46 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: C.text, fontSize: 10, rotate: 34 },
      axisLine: { lineStyle: { color: C.axis } }
    },
    yAxis: { ...numAxis(opts.yName ?? '家数'), minInterval: 1 },
    series: [
      {
        type: 'bar',
        barMaxWidth: 30,
        data: counts.map((c, i) => ({
          value: c,
          itemStyle: {
            color: i === opts.highlightBin ? C.up : C.accent,
            opacity: i === opts.highlightBin ? 1 : 0.5,
            borderRadius: 3
          }
        })),
        markLine: marks.length
          ? {
              silent: true,
              symbol: 'none',
              lineStyle: { type: 'dashed', width: 1 },
              label: { color: C.text, fontSize: 10, formatter: '{b}' },
              data: marks.map((m) => ({ name: m.name, xAxis: m.xAxis }))
            }
          : undefined
      }
    ]
  };
}

/** 净值曲线（多策略 + 基准） */
export function equityOption(dates: string[], series: LineSeries[]): EChartsOption {
  return {
    tooltip: { ...tooltipBase(), valueFormatter: (v) => (v == null ? '-' : Number(v).toFixed(3)) },
    legend: { top: 0, textStyle: { color: C.text, fontSize: 11 }, itemWidth: 14, itemHeight: 8 },
    grid: baseGrid,
    xAxis: catAxis(dates),
    yAxis: {
      type: 'value',
      name: '净值',
      axisLabel: { color: C.text, fontSize: 11 },
      splitLine: { lineStyle: { color: C.grid } }
    },
    dataZoom: dates.length > 260 ? [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 4 }] : [],
    series: series.map((s) => ({
      name: s.name,
      type: 'line',
      data: s.data,
      showSymbol: false,
      lineStyle: { width: s.lineWidth ?? 1.8, color: s.color ?? C.accent, type: s.dashed ? 'dashed' : 'solid' },
      itemStyle: { color: s.color ?? C.accent },
      areaStyle: s.area ? { color: s.color ?? C.accent, opacity: 0.1 } : undefined
    }))
  };
}

export function barOption(
  categories: string[],
  series: { name: string; data: number[]; color?: string; colors?: string[] }[],
  opts: { horizontal?: boolean; pct?: boolean; labels?: boolean; unit?: string; digits?: number } = {}
): EChartsOption {
  return {
    tooltip: tooltipBase(),
    legend: series.length > 1 ? { top: 0, textStyle: { color: C.text, fontSize: 11 } } : undefined,
    // 横向条形开了数值标签时，右侧要留出标签宽度，否则「3 条」会被裁掉
    grid: { left: 60, right: opts.labels && opts.horizontal ? 52 : 20, top: opts.labels && !opts.horizontal ? 40 : 30, bottom: 28 },
    xAxis: opts.horizontal ? numAxis() : { ...catAxis(categories), axisLabel: { color: C.text, fontSize: 10, rotate: categories.length > 8 ? 32 : 0 } },
    yAxis: opts.horizontal
      ? { ...catAxis(categories), splitLine: { show: false } }
      : opts.pct
        ? pctAxis()
        : numAxis(),
    series: series.map((s) => ({
      name: s.name,
      type: 'bar',
      // 逐项配色：连板梯队、涨跌分箱这类「同一指标不同档位」需要按档位区分颜色
      data: s.colors
        ? s.data.map((v, i) => ({ value: v, itemStyle: { color: s.colors?.[i] ?? s.color ?? C.accent, borderRadius: 3 } }))
        : s.data,
      itemStyle: { color: s.color ?? C.accent, borderRadius: 3 },
      barMaxWidth: 34,
      // 小类目柱子几乎贴地时，数值标签是唯一能读出差异的方式
      label: opts.labels
        ? {
            show: true,
            position: opts.horizontal ? 'right' : 'top',
            fontSize: 9.5,
            color: C.text,
            formatter: (p) => {
              const v = Number((p as unknown as { value: number }).value);
              return v === 0 ? '' : `${v.toFixed(opts.digits ?? 2)}${opts.unit ?? ''}`;
            }
          }
        : undefined
    }))
  };
}

export function heatmapOption(
  xCategories: string[],
  yCategories: string[],
  data: [number, number, number][],
  opts: { min?: number; max?: number; name?: string; labelFmt?: (v: number) => string } = {}
): EChartsOption {
  return {
    tooltip: {
      ...tooltipBase(),
      formatter: (p) => {
        const d = (p as unknown as { data: [number, number, number] }[])[0].data;
        return `${yCategories[d[1]]} × ${xCategories[d[0]]}<br/>${opts.name ?? '值'}: ${opts.labelFmt ? opts.labelFmt(d[2]) : d[2].toFixed(3)}`;
      }
    },
    grid: { left: 90, right: 20, top: 16, bottom: 60 },
    xAxis: { type: 'category', data: xCategories, axisLabel: { color: C.text, fontSize: 10, rotate: 30 }, splitArea: { show: true } },
    yAxis: { type: 'category', data: yCategories, axisLabel: { color: C.text, fontSize: 10 }, splitArea: { show: true } },
    visualMap: {
      min: opts.min ?? -1,
      max: opts.max ?? 1,
      calculable: true,
      orient: 'horizontal',
      left: 'center',
      bottom: 0,
      textStyle: { color: C.text, fontSize: 10 },
      inRange: { color: C.hm }
    },
    series: [
      {
        type: 'heatmap',
        data,
        label: {
          show: true,
          fontSize: 10,
          color: C.hmText,
          formatter: (p) => {
            const d = p.data as [number, number, number];
            return opts.labelFmt ? opts.labelFmt(d[2]) : d[2].toFixed(2);
          }
        },
        itemStyle: { borderColor: C.panel, borderWidth: 1 }
      }
    ]
  };
}

export function gaugeOption(
  value: number,
  name: string,
  opts: { min?: number; max?: number; unit?: string } = {}
): EChartsOption {
  const min = opts.min ?? -1;
  const max = opts.max ?? 1;
  const pct = ((value - min) / (max - min)) * 100;
  const color = value > 0.15 ? C.up : value < -0.15 ? C.down : C.gray;
  return {
    series: [
      {
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min,
        max,
        radius: '92%',
        center: ['50%', '58%'],
        progress: { show: true, width: 14, itemStyle: { color } },
        axisLine: { lineStyle: { width: 14, color: [[1, C.track]] } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: { show: false },
        pointer: { show: false },
        title: { show: true, offsetCenter: [0, '-28%'], color: C.text, fontSize: 12 },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '2%'],
          fontSize: 26,
          fontWeight: 700,
          color,
          formatter: (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(2)}${opts.unit ?? ''}`
        },
        data: [{ value, name }]
      },
      {
        // 底部刻度文字
        type: 'gauge',
        startAngle: 210,
        endAngle: -30,
        min,
        max,
        radius: '70%',
        center: ['50%', '58%'],
        axisLine: { show: false },
        axisLabel: {
          color: C.text,
          fontSize: 10,
          distance: -6,
          formatter: (v: number) => (Math.abs(v - min) < 1e-6 || Math.abs(v - max) < 1e-6 || Math.abs(v) < 1e-6 ? v.toFixed(1) : '')
        },
        axisTick: { show: false },
        splitLine: { show: false },
        pointer: { show: false },
        detail: { show: false },
        data: [{ value: pct }]
      }
    ]
  };
}

export function radarOption(
  indicators: { name: string; max: number }[],
  values: { name: string; value: number[]; color: string }[]
): EChartsOption {
  return {
    tooltip: tooltipBase(),
    legend: { bottom: 0, textStyle: { color: C.text, fontSize: 11 } },
    radar: {
      indicator: indicators,
      radius: '66%',
      center: ['50%', '48%'],
      axisName: { color: C.text, fontSize: 11 },
      splitLine: { lineStyle: { color: C.grid } },
      splitArea: { areaStyle: { color: [C.panel, C.panel2] } },
      axisLine: { lineStyle: { color: C.grid } }
    },
    series: [
      {
        type: 'radar',
        data: values.map((v) => ({
          name: v.name,
          value: v.value,
          lineStyle: { color: v.color, width: 2 },
          itemStyle: { color: v.color },
          areaStyle: { color: v.color, opacity: 0.15 }
        }))
      }
    ]
  };
}

export function pieOption(data: { name: string; value: number; color?: string }[]): EChartsOption {
  return {
    tooltip: {
      trigger: 'item',
      backgroundColor: C.tipBg,
      borderColor: C.tipBd,
      borderWidth: 1,
      textStyle: { color: C.text, fontSize: 12 },
      extraCssText: 'box-shadow: 0 10px 28px -16px rgba(0,0,0,.55); border-radius: 8px;',
      formatter: (p) => {
        const it = p as unknown as { name: string; value: number; percent: number };
        return `${it.name}: ${(it.value * 100).toFixed(1)}%（${it.percent}%）`;
      }
    },
    legend: { bottom: 0, textStyle: { color: C.text, fontSize: 11 }, type: 'scroll' },
    series: [
      {
        type: 'pie',
        radius: ['42%', '68%'],
        center: ['50%', '46%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 6, borderColor: C.panel, borderWidth: 2 },
        label: { show: true, fontSize: 11, color: C.text, formatter: '{b}\n{d}%' },
        // ECharts 不认 data[].color，必须落到 itemStyle.color；不传时沿用默认色板
        data: data.map((d) => ({
          name: d.name,
          value: d.value,
          itemStyle: d.color ? { color: d.color } : undefined
        }))
      }
    ]
  };
}

export const chartFont = { fontFamily: 'inherit' };

/* ============ 情绪晴雨表 ============ */

/** 五档天气配色（与 math/sentiment.ts 的 WEATHER_META 保持一致） */
export const WEATHER_COLORS: Record<string, string> = {
  storm: '#6d28d9',
  rain: '#3b82f6',
  overcast: '#94a3b8',
  cloudy: '#f59e0b',
  sunny: '#e04343'
};

/**
 * 情绪温度计：0~100 五档色带 + 指针 + 中心读数。
 * 与通用 gaugeOption 的区别：那条是「涨跌幅」正负双色，这条是「温度」连续分档。
 */
export function thermometerOption(
  value: number,
  opts: { label: string; color: string; min?: number; max?: number; sub?: string }
): EChartsOption {
  const min = opts.min ?? 0;
  const max = opts.max ?? 100;
  const v = Math.min(max, Math.max(min, value));
  // ECharts 的 axisLine 色带要求 [比例(0~1), 颜色]，直接写分值会被当成 1 而整条同色
  const span = max - min || 1;
  const raw: { r: number; c: string }[] = [
    { r: (32 - min) / span, c: WEATHER_COLORS.storm },
    { r: (45 - min) / span, c: WEATHER_COLORS.rain },
    { r: (58 - min) / span, c: WEATHER_COLORS.overcast },
    { r: (72 - min) / span, c: WEATHER_COLORS.cloudy },
    { r: 1, c: WEATHER_COLORS.sunny }
  ];
  const bands: [number, string][] = raw.filter((x) => x.r > 0 && x.r <= 1).map((x) => [x.r, x.c]);
  return {
    animationDuration: 700,
    series: [
      {
        type: 'gauge',
        startAngle: 205,
        endAngle: -25,
        min,
        max,
        radius: '96%',
        center: ['50%', '62%'],
        splitNumber: 10,
        axisLine: { lineStyle: { width: 16, color: bands } },
        pointer: {
          icon: 'path://M2,0 L-2,0 L-1,-70 L1,-70 Z',
          // 指针只走半径的一半：读数放在圆心下方，指针过长会横穿数字造成「重叠」
          length: '56%',
          width: 5,
          offsetCenter: [0, '0%'],
          itemStyle: { color: opts.color, shadowColor: opts.color, shadowBlur: 8 }
        },
        anchor: { show: true, size: 12, itemStyle: { color: opts.color, borderColor: C.panel, borderWidth: 2 } },
        axisTick: { distance: -16, length: 4, lineStyle: { color: C.panel, width: 1 } },
        splitLine: { distance: -16, length: 12, lineStyle: { color: C.panel, width: 2 } },
        axisLabel: { distance: -30, color: C.text, fontSize: 10 },
        // 读数与天气名整体下移到圆心以下，和指针彻底分层
        title: { offsetCenter: [0, '52%'], color: opts.color, fontSize: 14, fontWeight: 700 },
        detail: {
          valueAnimation: true,
          offsetCenter: [0, '26%'],
          fontSize: 34,
          fontWeight: 800,
          color: opts.color,
          formatter: (x: number) => x.toFixed(0)
        },
        data: [{ value: v, name: opts.label }]
      }
    ]
  };
}

/** 涨跌分布：按箱体涨跌分色（红涨绿跌），0 用灰 */
export function distBarOption(labels: string[], counts: number[], upFlags: boolean[]): EChartsOption {
  const base = tooltipBase();
  return {
    // 柱状分箱必须用 item 触发：tooltipBase 默认是 axis，formatter 收到的会是数组
    tooltip: {
      ...base,
      trigger: 'item',
      axisPointer: undefined,
      formatter: (p) => {
        const it = p as unknown as { name: string; value: number };
        return `${it.name}%：${Number(it.value).toLocaleString()} 只`;
      }
    },
    grid: { left: 52, right: 14, top: 26, bottom: 50 },
    xAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: C.text, fontSize: 9.5, interval: 0, rotate: 42, margin: 8 },
      axisLine: { lineStyle: { color: C.axis } }
    },
    yAxis: {
      type: 'value',
      name: '家数',
      nameTextStyle: { color: C.text, fontSize: 10 },
      axisLabel: { color: C.text, fontSize: 10 },
      splitLine: { lineStyle: { color: C.grid } }
    },
    series: [
      {
        type: 'bar',
        data: counts.map((v, i) => ({
          value: v,
          itemStyle: {
            color: labels[i] === '0' ? C.gray : upFlags[i] ? C.up : C.down,
            borderRadius: [3, 3, 0, 0],
            opacity: v === 0 ? 0.35 : 1
          }
        })),
        barMaxWidth: 30
      }
    ]
  };
}
