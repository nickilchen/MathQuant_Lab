/**
 * 市场情绪评分（纯函数，无 UI / 网络依赖）
 *
 * 情绪不是一个指标能说清的，所以拆成六个维度各自打分（0~100），再加权合成一个
 * 「市场温度」。每个维度都能单独解释，避免出现「情绪 62 分」但说不出为什么的情况。
 *
 *   广度 Breadth    涨跌家数比、涨跌中位数      —— 赚钱效应的面积
 *   强度 Strength   涨停/跌停/炸板/连板高度      —— 打板资金的胆量
 *   资金 Capital    主力净流入、两融净买入      —— 真金白银的方向
 *   量能 Volume     成交额 / 20 日均额          —— 参与热度
 *   结构 Structure  行业上涨占比、行业涨幅中位  —— 行情是普涨还是独苗
 *   波动 Volatility 20 日波动率 / 60 日基准     —— 恐慌程度（反向计分）
 *
 * 注意：量能、波动不是「越高越好」或「越低越好」，而是偏离常态的程度；
 * 这里统一按「对多头友好程度」折算，量能温和放大加分、剧烈放量或极度缩量减分。
 */

/* ============ 基础工具 ============ */

export const clamp = (x: number, lo = 0, hi = 100): number => (Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : lo);

const tanh = (x: number): number => {
  const e = Math.exp(2 * x);
  return (e - 1) / (e + 1);
};

/* ============ 维度定义 ============ */

export type DimKey = 'breadth' | 'strength' | 'capital' | 'volume' | 'structure' | 'volatility' | 'buzz';

export interface DimMeta {
  label: string;
  icon: string;
  /** 权重（合成时归一化） */
  weight: number;
  /** 该维度回答什么问题 */
  desc: string;
}

export const DIM_META: Record<DimKey, DimMeta> = {
  breadth: { label: '涨跌广度', icon: '📈', weight: 0.2, desc: '多少股票在涨 —— 赚钱效应的面积' },
  strength: { label: '打板强度', icon: '🔥', weight: 0.16, desc: '涨停/跌停/炸板/连板高度 —— 短线资金的胆量' },
  capital: { label: '资金流向', icon: '💰', weight: 0.2, desc: '主力净流入与两融净买入 —— 真金白银的方向' },
  volume: { label: '量能热度', icon: '🔊', weight: 0.1, desc: '成交额相对 20 日均值 —— 参与热度' },
  structure: { label: '结构扩散', icon: '🕸️', weight: 0.12, desc: '上涨行业占比 —— 普涨还是独苗' },
  volatility: { label: '波动恐慌', icon: '🌪️', weight: 0.1, desc: '波动率相对基准（反向计分）—— 恐慌程度' },
  buzz: { label: '全网讨论', icon: '💬', weight: 0.12, desc: '股吧人气榜赚钱效应 + 热帖多空比 —— 散户在聊什么' }
};

export const DIM_ORDER: DimKey[] = ['breadth', 'strength', 'capital', 'volume', 'structure', 'volatility', 'buzz'];

/* ============ 输入 ============ */

export interface BreadthInput {
  total: number;
  up: number;
  down: number;
  flat: number;
  /** 涨停家数（不含 ST 的算法由数据层决定） */
  limitUp: number;
  limitDown: number;
  /** 炸板家数（曾涨停但未封住） */
  broke: number;
  /** 最高连板数 */
  maxBoard: number;
  /** 全市场涨跌幅中位数（%） */
  medianPct: number;
}

export interface FlowInput {
  /** 当日主力净流入（元）；接口不可用时为 null */
  main: number | null;
  /** 与主力净流入同口径的成交额（元）—— 东财给的是上证口径，所以这里是沪市成交额 */
  amount: number;
  /** 近 5 日主力净流入合计（元），仅用于文案，不参与打分 */
  main5: number;
  /** 融资净买入（元） */
  marginNet: number;
  /** 融资余额（元） */
  marginBal: number;
  /** 两融数据日期（交易所盘后披露，通常滞后 1 个交易日） */
  marginDate?: string;
}

export interface StructureInput {
  /** 上涨行业数 */
  upCount: number;
  /** 有数据的行业总数 */
  total: number;
  /** 行业涨幅中位数（%） */
  medianPct: number;
}

export interface VolInput {
  /** 20 日年化波动率（小数，如 0.22） */
  vol20: number;
  /** 60 日年化波动率，作为基准 */
  vol60: number;
  /** 今日成交额 / 20 日均额 */
  amountRatio: number;
}

export interface SentimentInput {
  breadth: BreadthInput;
  flow: FlowInput | null;
  structure: StructureInput | null;
  vol: VolInput | null;
  /** 全网讨论（由 data/buzz 聚合后传入；缺省或 null 表示不可用） */
  buzz?: { score: number; detail: string } | null;
}

/* ============ 单维打分 ============ */

/**
 * 广度：以「上涨占比」为核心，用 tanh 压缩极端值（0.7 的上涨占比不应等于 70 分线性）。
 * 再按全市场涨跌幅中位数做小幅修正：涨得多但只是少数股票涨，说明普涨是假象。
 */
export function breadthScore(b: BreadthInput): number {
  const denom = b.up + b.down + b.flat || 1;
  const upRatio = b.up / denom;
  const base = 100 * (0.5 + 0.5 * tanh(2.2 * (upRatio - 0.5)));
  // 中位数修正：中位数为负说明「指数涨但多数股票跌」，扣分
  const medianAdj = 8 * tanh(b.medianPct / 1.2);
  return clamp(base + medianAdj);
}

/**
 * 强度：涨停/跌停比（40%）+ 封板率（30%）+ 连板高度（30%）。
 * 封板率 = 1 - 炸板 / (涨停 + 炸板)，直接反映「封得住封不住」。
 */
export function strengthScore(b: BreadthInput): number {
  const ratio = b.limitUp / (b.limitUp + b.limitDown + 1);
  const seal = 1 - b.broke / (b.limitUp + b.broke + 1);
  const height = clamp(b.maxBoard / 6, 0, 1);
  return clamp(100 * (0.4 * ratio + 0.3 * seal + 0.3 * height));
}

/**
 * 资金：当日主力净流入占成交额的比例为主，两融净买入占余额的比例为辅。
 *
 * 不用「5 日累计」是因为拿不到历史成交额（腾讯日线只有成交量），
 * 用当日成交额去外推 5 日分母会随当日放量程度漂移，反而引入误差。
 * 当日比值是精确口径，噪声由「广度 / 结构」两个维度互相印证。
 */
export function capitalScore(f: FlowInput): number {
  // 标定：主力净流入占成交额 ±3% 打到 ±50 分；
  // 融资净买入占余额 ±2% 打到 ±50 分（日度通常只有 ±0.5%，±2% 已是显著去杠杆）
  const parts: { w: number; s: number }[] = [];
  if (f.main != null && f.amount > 0) {
    parts.push({ w: 0.72, s: clamp(50 + (f.main / f.amount / 0.03) * 50) });
  }
  if (f.marginBal > 0) {
    parts.push({ w: 0.28, s: clamp(50 + (f.marginNet / f.marginBal / 0.02) * 50) });
  }
  if (!parts.length) return 50;
  // 主力资金流不可用时，只用两融，并在内部重新归一，而不是补 50 分
  const wSum = parts.reduce((a, b) => a + b.w, 0);
  return clamp(parts.reduce((a, b) => a + b.s * b.w, 0) / wSum);
}

/**
 * 量能：成交额 / 20 日均额（盘中需按交易时间进度折算，否则 10 点永远「缩量」）。
 *
 * 用 tanh 做单调饱和：1 倍 = 50 分，1.5 倍 ≈ 71，2 倍 ≈ 86，3 倍 ≈ 97；
 * 缩量 0.6 倍 ≈ 33，0.3 倍 ≈ 26。放量到极端只给到 97 而不是 100，
 * 因为「天量」往往同时意味着分歧，方向交给广度与资金维度判断。
 */
export function volumeScore(amountRatio: number): number {
  if (!Number.isFinite(amountRatio) || amountRatio <= 0) return 50;
  return clamp(50 + 50 * tanh((amountRatio - 1) * 0.9));
}

/**
 * 结构：上涨行业占比（70%）+ 行业涨幅中位数（30%）。
 * 上涨行业多 = 行情有扩散；行业涨幅中位为正 = 扩散的行业是真涨。
 */
export function structureScore(s: StructureInput): number {
  const ratio = s.total > 0 ? s.upCount / s.total : 0.5;
  const base = 100 * (0.5 + 0.5 * tanh(2.6 * (ratio - 0.5)));
  const medianAdj = 10 * tanh(s.medianPct / 0.8);
  return clamp(base + medianAdj);
}

/**
 * 波动（反向）：20 日波动率相对 60 日基准。
 * 波动放大 → 恐慌 → 扣分；波动收敛 → 稳定 → 加分。
 */
export function volatilityScore(v: VolInput): number {
  const base = v.vol60 > 0 ? v.vol20 / v.vol60 : 1;
  return clamp(50 - 45 * (base - 1));
}

/* ============ 合成 ============ */

export interface DimResult {
  key: DimKey;
  label: string;
  icon: string;
  desc: string;
  /** 0~100 */
  score: number;
  /** 实际参与合成的权重（缺失维度会被剔除并重新归一） */
  weight: number;
  /** 对综合分的贡献（score-50）×weight，单位「分」 */
  contribution: number;
  /** 人话描述 */
  detail: string;
  /** 是否可用 */
  available: boolean;
}

export type Weather = 'sunny' | 'cloudy' | 'overcast' | 'rain' | 'storm';

export interface WeatherMeta {
  label: string;
  icon: string;
  /** 图表/徽标主色 */
  color: string;
  note: string;
}

export const WEATHER_META: Record<Weather, WeatherMeta> = {
  sunny: { label: '晴', icon: '☀️', color: '#e04343', note: '赚钱效应强、资金流入、打板积极，适合顺势做多' },
  cloudy: { label: '多云', icon: '⛅', color: '#f59e0b', note: '整体偏暖但分化，结构性机会为主，注意节奏' },
  overcast: { label: '阴', icon: '☁️', color: '#94a3b8', note: '多空胶着、量能平淡，宜降低仓位等信号' },
  rain: { label: '小雨', icon: '🌧️', color: '#3b82f6', note: '亏钱效应扩散、资金流出，防守为主' },
  storm: { label: '暴雨', icon: '⛈️', color: '#6d28d9', note: '情绪冰点、跌停扩散，往往是反转的前夜但不宜抄底过早' }
};

/** 五档阈值（含下界） */
export const WEATHER_THRESHOLDS: { min: number; weather: Weather }[] = [
  { min: 72, weather: 'sunny' },
  { min: 58, weather: 'cloudy' },
  { min: 45, weather: 'overcast' },
  { min: 32, weather: 'rain' },
  { min: 0, weather: 'storm' }
];

export function weatherOf(score: number): Weather {
  return (WEATHER_THRESHOLDS.find((t) => score >= t.min) ?? WEATHER_THRESHOLDS[WEATHER_THRESHOLDS.length - 1]).weather;
}

export interface Alert {
  tone: 'hot' | 'cold' | 'warn' | 'info';
  title: string;
  text: string;
}

export interface SentimentResult {
  /** 0~100 综合温度 */
  score: number;
  weather: Weather;
  /** 是否处于「亢奋」或「冰点」极端区 */
  extreme: 'hot' | 'cold' | null;
  dims: DimResult[];
  /** 加减分理由，按影响大小排序 */
  reasons: { text: string; points: number; tone: 'up' | 'down' | 'flat' }[];
  alerts: Alert[];
  /** 一句话结论 */
  summary: string;
}

const fmtPct1 = (x: number) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`;

/** 主入口：六维 → 综合 */
export function evaluateSentiment(input: SentimentInput): SentimentResult {
  const { breadth: b, flow, structure, vol, buzz = null } = input;

  const raw: { key: DimKey; score: number | null; detail: string }[] = [
    {
      key: 'breadth',
      score: breadthScore(b),
      detail: `涨 ${b.up} / 跌 ${b.down} / 平 ${b.flat}，上涨占比 ${((b.up / (b.up + b.down + b.flat || 1)) * 100).toFixed(1)}%，中位 ${fmtPct1(b.medianPct)}`
    },
    {
      key: 'strength',
      // 非交易时段（周末/节假日）涨停池返回空，此时 0 家涨停不代表情绪冰点，按「不可用」处理
      score: b.limitUp === 0 && b.limitDown === 0 && b.broke === 0 && b.up + b.down > 200 ? null : strengthScore(b),
      detail:
        b.limitUp === 0 && b.limitDown === 0 && b.broke === 0
          ? '非交易时段，打板数据不可用'
          : `涨停 ${b.limitUp} / 跌停 ${b.limitDown} / 炸板 ${b.broke}，封板率 ${(
        (1 - b.broke / (b.limitUp + b.broke + 1)) * 100
      ).toFixed(0)}%，最高 ${b.maxBoard} 连板`
    },
    {
      key: 'capital',
      score: flow ? capitalScore(flow) : null,
      detail: flow
        ? [
            flow.main != null && flow.amount > 0
              ? `主力${flowText(flow.main)}（占沪市成交额 ${((flow.main / flow.amount) * 100).toFixed(2)}%）`
              : '主力资金流不可用',
            flow.main5 ? `5 日累计 ${yiText(flow.main5)}` : '',
            `融资${flowText(flow.marginNet)}${flow.marginDate ? `（${flow.marginDate.slice(5)}）` : ''}`
          ]
            .filter(Boolean)
            .join('，')
        : '资金数据不可用'
    },
    {
      key: 'volume',
      score: vol ? volumeScore(vol.amountRatio) : null,
      detail: vol ? `成交额 ${vol.amountRatio.toFixed(2)} 倍于 20 日均额` : '量能数据不可用'
    },
    {
      key: 'structure',
      score: structure ? structureScore(structure) : null,
      detail: structure
        ? `${structure.upCount}/${structure.total} 个行业上涨（${((structure.upCount / (structure.total || 1)) * 100).toFixed(0)}%），行业涨幅中位 ${fmtPct1(structure.medianPct)}`
        : '行业数据不可用'
    },
    {
      key: 'buzz',
      score: buzz ? clamp(buzz.score) : null,
      detail: buzz ? buzz.detail : '讨论数据不可用'
    },
    {
      key: 'volatility',
      score: vol ? volatilityScore(vol) : null,
      detail: vol
        ? `20 日年化波动 ${(vol.vol20 * 100).toFixed(1)}%，60 日基准 ${(vol.vol60 * 100).toFixed(1)}%（比值 ${(vol.vol20 / (vol.vol60 || 1)).toFixed(2)}）`
        : '波动数据不可用'
    }
  ];

  const avail = raw.filter((r) => r.score != null) as { key: DimKey; score: number; detail: string }[];
  const wSum = avail.reduce((s, r) => s + DIM_META[r.key].weight, 0) || 1;

  const dims: DimResult[] = raw.map((r) => {
    const meta = DIM_META[r.key];
    const available = r.score != null;
    const weight = available ? meta.weight / wSum : 0;
    const score = available ? clamp(r.score as number) : 50;
    return {
      key: r.key,
      label: meta.label,
      icon: meta.icon,
      desc: meta.desc,
      score,
      weight,
      contribution: available ? (score - 50) * weight : 0,
      detail: r.detail,
      available
    };
  });

  const score = clamp(dims.reduce((s, d) => s + (d.available ? d.score * d.weight : 0), 0));
  const weather = weatherOf(score);

  // ---- 极端区判定 ----
  const upRatio = b.up / (b.up + b.down + b.flat || 1);
  let extreme: 'hot' | 'cold' | null = null;
  if (score >= 85 || (upRatio >= 0.85 && b.limitUp >= 60)) extreme = 'hot';
  else if (score <= 15 || upRatio <= 0.1) extreme = 'cold';

  // ---- 可解释理由 ----
  const reasons = dims
    .filter((d) => d.available)
    .map((d) => ({
      text: `${d.label}：${d.detail}`,
      points: d.contribution,
      tone: (d.contribution > 1.5 ? 'up' : d.contribution < -1.5 ? 'down' : 'flat') as 'up' | 'down' | 'flat'
    }))
    .sort((a, z) => Math.abs(z.points) - Math.abs(a.points));

  // ---- 风险提示 ----
  const alerts: Alert[] = [];
  if (extreme === 'hot') {
    alerts.push({
      tone: 'hot',
      title: '情绪亢奋',
      text: '涨跌广度与打板强度同时处于高位，短线过热。历史上这种位置追高的胜率明显下降，更适合兑现而非加仓。'
    });
  }
  if (extreme === 'cold') {
    alerts.push({
      tone: 'cold',
      title: '情绪冰点',
      text: '上涨家数与涨停数同时萎缩到极低水平，亏钱效应充分释放。冰点往往是反转的前夜，但「便宜」不等于「马上涨」，需等量能与涨停结构修复。'
    });
  }
  if (b.limitUp + b.broke > 0 && b.broke / (b.limitUp + b.broke) > 0.45 && b.limitUp >= 20) {
    alerts.push({
      tone: 'warn',
      title: '分歧加大',
      text: `炸板率 ${((b.broke / (b.limitUp + b.broke)) * 100).toFixed(0)}% 偏高，说明封板资金不坚决、次日溢价不稳定，打板需谨慎。`
    });
  }
  if (flow && flow.main != null && flow.amount > 0) {
    const r = flow.main / flow.amount;
    if (r < -0.03) {
      alerts.push({
        tone: 'warn',
        title: '主力大幅流出',
        text: `当日主力净流出 ${yiText(Math.abs(flow.main))}，占沪市成交额 ${(r * 100).toFixed(2)}%，属于显著派发，注意仓位。`
      });
    } else if (r > 0.03) {
      alerts.push({
        tone: 'info',
        title: '主力大幅流入',
        text: `当日主力净流入 ${yiText(flow.main)}，占沪市成交额 ${(r * 100).toFixed(2)}%，资金面强势。`
      });
    }
  }

  // ---- 一句话结论 ----
  const w = WEATHER_META[weather];
  const lead = dims
    .filter((d) => d.available)
    .slice()
    .sort((a, z) => Math.abs(z.contribution) - Math.abs(a.contribution))[0];
  const summary =
    `市场温度 ${score.toFixed(0)} 分，${w.icon} ${w.label}。` +
    (lead
      ? `主要${lead.contribution >= 0 ? '支撑' : '拖累'}来自${lead.label}（${lead.contribution >= 0 ? '+' : ''}${lead.contribution.toFixed(1)} 分）。`
      : '') +
    w.note;

  return { score, weather, extreme, dims, reasons, alerts, summary };
}

/** 「净流入 12 亿 / 净流出 12 亿」——避免出现「净流入 -188 亿」这种双重否定 */
export function flowText(v: number): string {
  return `${v >= 0 ? '净流入' : '净流出'} ${yiText(Math.abs(v))}`;
}

function yiText(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e8) return `${(v / 1e8).toFixed(1)} 亿`;
  if (abs >= 1e4) return `${(v / 1e4).toFixed(0)} 万`;
  return v.toFixed(0);
}

/* ============ 涨跌分布 ============ */

export interface DistBin {
  label: string;
  /** 分箱下界（%） */
  from: number;
  count: number;
  /** 该箱是否属于「上涨」 */
  up: boolean;
}

/** 显式分箱：左闭右开，0 单独一箱（平盘不是「微涨」） */
const DIST_BINS: { label: string; from: number; to: number; up: boolean }[] = [
  { label: '≤-7', from: -Infinity, to: -7, up: false },
  { label: '-7~-5', from: -7, to: -5, up: false },
  { label: '-5~-3', from: -5, to: -3, up: false },
  { label: '-3~-1', from: -3, to: -1, up: false },
  { label: '-1~0', from: -1, to: 0, up: false },
  { label: '0', from: 0, to: 0, up: false },
  { label: '0~1', from: 0, to: 1, up: true },
  { label: '1~3', from: 1, to: 3, up: true },
  { label: '3~5', from: 3, to: 5, up: true },
  { label: '5~7', from: 5, to: 7, up: true },
  { label: '≥7', from: 7, to: Infinity, up: true }
];

/** 把全市场涨跌幅打成分箱（红涨绿跌），0 单独一箱 */
export function distributionOf(pcts: number[]): DistBin[] {
  const bins: DistBin[] = DIST_BINS.map((b) => ({ label: b.label, from: b.from, count: 0, up: b.up }));
  const zeroIdx = 5;

  for (const p of pcts) {
    if (!Number.isFinite(p)) continue;
    if (p === 0) {
      bins[zeroIdx].count += 1;
      continue;
    }
    // 正数从「0~1」开始找，负数跳过 0 箱
    const start = p > 0 ? zeroIdx + 1 : 0;
    let idx = -1;
    for (let i = start; i < DIST_BINS.length; i++) {
      const b = DIST_BINS[i];
      if (p >= b.from && p < b.to) {
        idx = i;
        break;
      }
    }
    if (idx < 0) idx = p > 0 ? DIST_BINS.length - 1 : 0;
    bins[idx].count += 1;
  }
  return bins;
}

/** 涨跌停/炸板/连板统计 */
export interface LimitStat {
  limitUp: number;
  limitDown: number;
  broke: number;
  maxBoard: number;
  /** 封板率 = 涨停 / (涨停 + 炸板) */
  sealRate: number;
  /** 连板梯队：连板数 → 家数 */
  ladder: { level: number; count: number }[];
}

export function limitStat(up: { boardCount: number }[], down: number, broke: number): LimitStat {
  const ladderMap = new Map<number, number>();
  let maxBoard = 0;
  for (const r of up) {
    const lv = Math.max(1, Math.round(r.boardCount || 1));
    ladderMap.set(lv, (ladderMap.get(lv) ?? 0) + 1);
    maxBoard = Math.max(maxBoard, lv);
  }
  const limitUp = up.length;
  return {
    limitUp,
    limitDown: down,
    broke,
    maxBoard,
    sealRate: limitUp + broke > 0 ? limitUp / (limitUp + broke) : 0,
    ladder: [...ladderMap.entries()].map(([level, count]) => ({ level, count })).sort((a, b) => a.level - b.level)
  };
}

/* ============ 历史近似温度 ============ */

export interface KlinePoint {
  date: string;
  close: number;
  amount: number;
}

export interface ApproxPoint {
  date: string;
  score: number;
}

/**
 * 用指数量价回溯「近似温度」。
 *
 * 真实的六维情绪需要历史涨跌家数、历史资金流，这些拿不到长序列；
 * 这里只用指数 K 线的量价特征做近似，因此曲线只用于看趋势与拐点，绝对值不可与当日六维分直接对比。
 *
 *   近似温度 = 0.45 × 动量分 + 0.35 × 量能分 + 0.20 × 波动分
 */
export function approxHistory(kline: KlinePoint[], lookback = 60): ApproxPoint[] {
  const out: ApproxPoint[] = [];
  if (kline.length < 22) return out;
  const rets: number[] = [];
  for (let i = 1; i < kline.length; i++) rets.push(kline[i].close / kline[i - 1].close - 1);

  const start = Math.max(20, kline.length - lookback);
  for (let i = start; i < kline.length; i++) {
    const ret5 = kline[i].close / kline[i - 5].close - 1;
    const momentum = clamp(50 + 50 * tanh(ret5 / 0.06));

    const win = kline.slice(Math.max(0, i - 20), i);
    const avgAmt = win.reduce((s, x) => s + x.amount, 0) / (win.length || 1);
    const vol = volumeScore(avgAmt > 0 ? kline[i].amount / avgAmt : 1);

    const r20 = rets.slice(Math.max(0, i - 21), i);
    const mean = r20.reduce((s, x) => s + x, 0) / (r20.length || 1);
    const sd = Math.sqrt(r20.reduce((s, x) => s + (x - mean) ** 2, 0) / (r20.length || 1));
    const vola = clamp(50 - 45 * ((sd * Math.sqrt(252)) / 0.2 - 1));

    out.push({ date: kline[i].date, score: clamp(0.45 * momentum + 0.35 * vol + 0.2 * vola) });
  }
  return out;
}
