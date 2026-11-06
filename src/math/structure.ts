/**
 * 情绪结构分析（纯函数）
 *
 * 多空比是一个标量，它回答不了三个关键问题：
 *   1. **为什么**看多/看空？（归因 → 主题分类）
 *   2. 88% 到底是高还是低？（阈值 → 分档 + 历史分位）
 *   3. 现在是「一致」还是「分歧」？（结构 → 分歧度、背离、集中度）
 *
 * 这一层就是补这三个问题，把「一堆帖子」变成「有结构的判断」。
 *
 * 注意：主题分类是**关键词优先级匹配**，一条内容只归一个主主题（取优先级最高的）。
 * 这不是语义理解，但比「全都算中性」有用得多，且完全可解释——每条都能说出命中了哪个词。
 */

/* ============ 主题 ============ */

export type Topic =
  | 'event' // 个股事件（减持/回购/重组/立案）
  | 'policy' // 政策监管
  | 'earnings' // 业绩财报
  | 'capital' // 资金面
  | 'industry' // 行业景气（涨价/订单/产能）
  | 'theme' // 题材概念
  | 'technical' // 技术面
  | 'macro' // 宏观外围
  | 'speculation' // 短线打板
  | 'other';

export interface TopicMeta {
  label: string;
  icon: string;
  /** 一句话：这类内容通常在说什么 */
  note: string;
}

export const TOPIC_META: Record<Topic, TopicMeta> = {
  event: { label: '个股事件', icon: '📌', note: '减持、回购、重组、立案等公司层面事件' },
  policy: { label: '政策监管', icon: '🏛️', note: '货币政策、产业政策、监管口径' },
  earnings: { label: '业绩财报', icon: '📊', note: '净利、营收、预告、扭亏' },
  capital: { label: '资金面', icon: '💰', note: '北向、主力、融资、ETF、机构持仓' },
  industry: { label: '行业景气', icon: '🏭', note: '涨价、订单、产能、库存、需求' },
  theme: { label: '题材概念', icon: '🔥', note: 'AI、算力、机器人、固态电池等' },
  technical: { label: '技术面', icon: '📈', note: '均线、突破、支撑压力、量能' },
  macro: { label: '宏观外围', icon: '🌍', note: '美联储、汇率、关税、地缘' },
  speculation: { label: '短线打板', icon: '⚡', note: '连板、首板、炸板、龙头、接力' },
  other: { label: '闲聊无主题', icon: '💬', note: '情绪宣泄、实盘打卡、无法归类的日常发言' }
};

/** 优先级从高到低：越「具体」的越先匹配 */
const TOPIC_RULES: { topic: Topic; re: RegExp }[] = [
  {
    topic: 'event',
    re: /减持|增持|回购|重组|并购|收购|定增|配股|立案|问询|停牌|复牌|解禁|诉讼|分红|送转|退市|易主|股权转让|中标|签约|获批/
  },
  {
    topic: 'policy',
    re: /政策|监管|证监会|央行|降准|降息|国常会|发改委|财政部|工信部|补贴|税率|改革|规划|试点|会议|座谈会|十五五|政治局|部委/
  },
  {
    topic: 'earnings',
    re: /业绩|财报|净利|营收|预告|年报|季报|中报|扭亏|预增|预减|毛利率|净利润|同比增长|亏损|盈利/
  },
  {
    topic: 'capital',
    re: /北向|主力|融资|ETF|增量资金|净流入|净流出|机构|基金|持仓|筹码|杠杆|两融|外资|成交额|量能/
  },
  {
    topic: 'industry',
    re: /涨价|提价|降价|订单|产能|库存|开工|出货|满产|扩产|白酒|医药|券商|银行|地产|汽车|消费|农业|有色|煤炭|钢铁|化工|电力|军工|半导体|光伏|锂电|储能|家电|食品|旅游|零售|建材|机械/
  },
  {
    topic: 'theme',
    re: /AI|算力|机器人|固态电池|芯片|创新药|低空|量子|稀土|核电|光模块|CPO|数据要素|可控核聚变|商业航天|脑机|合成生物|培育钻石|短剧|谷子经济/
  },
  {
    topic: 'technical',
    re: /均线|突破|支撑|压力|放量|缩量|背离|形态|缺口|回踩|金叉|死叉|箱体|中枢|分时|日线|周线/
  },
  {
    topic: 'macro',
    re: /美联储|美股|汇率|关税|地缘|原油|黄金|加息|降息|衰退|外围|非农|CPI|通胀|美元|恒生|纳指|道指|标普|日经|韩股|港股|大盘|指数|收涨|收跌|涨跌家数|人民币/
  },
  {
    topic: 'speculation',
    re: /连板|首板|炸板|龙头|打板|妖股|接力|晋级|分歧转一致|空间板|情绪冰点|退潮|赚钱效应|涨停潮|跌停潮|封板|溢价/
  }
];

/** 单条内容归到一个主主题 */
export function classifyTopic(text: string): Topic {
  const t = String(text ?? '');
  for (const r of TOPIC_RULES) if (r.re.test(t)) return r.topic;
  return 'other';
}

/* ============ 主题统计 ============ */

export interface TonePost {
  text: string;
  tone: 1 | 0 | -1;
  /** 热度，用于排序与加权 */
  heat?: number;
}

export interface TopicStat {
  topic: Topic;
  label: string;
  icon: string;
  total: number;
  bull: number;
  bear: number;
  neutral: number;
  /** 多空比（0~1），无方向样本时为 null */
  ratio: number | null;
  /** 该主题最热的一条标题，用于举例 */
  sample: string;
}

export function topicStats(posts: TonePost[]): TopicStat[] {
  const map = new Map<Topic, TopicStat>();
  for (const p of posts) {
    const topic = classifyTopic(p.text);
    const cur =
      map.get(topic) ??
      ({
        topic,
        label: TOPIC_META[topic].label,
        icon: TOPIC_META[topic].icon,
        total: 0,
        bull: 0,
        bear: 0,
        neutral: 0,
        ratio: null,
        sample: ''
      } as TopicStat);
    cur.total += 1;
    if (p.tone === 1) cur.bull += 1;
    else if (p.tone === -1) cur.bear += 1;
    else cur.neutral += 1;
    if (!cur.sample || (p.heat ?? 0) > 0) cur.sample = cur.sample || p.text;
    map.set(topic, cur);
  }

  const list = [...map.values()];
  for (const s of list) {
    s.ratio = s.bull + s.bear > 0 ? s.bull / (s.bull + s.bear) : null;
  }
  return list.sort((a, b) => b.total - a.total);
}

/** 归因：看多 / 看空各自集中在哪些主题（只统计有方向的） */
export function driversOf(stats: TopicStat[], dir: 1 | -1, topN = 4): { label: string; icon: string; count: number; share: number }[] {
  const rows = stats
    // 「闲聊无主题」没有主题，放进归因会显得莫名其妙
    .filter((s) => s.topic !== 'other')
    .map((s) => ({ label: s.label, icon: s.icon, count: dir === 1 ? s.bull : s.bear }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
  const sum = rows.reduce((s, r) => s + r.count, 0) || 1;
  return rows.map((r) => ({ ...r, share: r.count / sum }));
}

/* ============ 阈值体系 ============ */

export type BandTone = 'cold' | 'cool' | 'flat' | 'warm' | 'hot';

export interface RatioBand {
  min: number;
  max: number;
  label: string;
  tone: BandTone;
  /** 这个区间通常意味着什么 */
  note: string;
}

/**
 * 多空比分档。
 *
 * 阈值不是拍脑袋：以「有方向样本」为分母，55% 大致是 A 股论坛多空比的长期中枢
 * （散户发言天然偏多，纯中性时也多于是略偏多），所以把 45~55 定为分歧区、
 * 75 以上才算「一致看多」。样本少于 20 条时这整套阈值都不可靠，调用方需提示。
 */
export const RATIO_BANDS: RatioBand[] = [
  { min: 0, max: 25, label: '极度悲观', tone: 'cold', note: '几乎只有看空声音，常见于恐慌杀跌末端' },
  { min: 25, max: 45, label: '偏空', tone: 'cool', note: '看空占优，但仍有分歧' },
  { min: 45, max: 55, label: '多空分歧', tone: 'flat', note: '多空力量接近，方向不明' },
  { min: 55, max: 75, label: '偏多', tone: 'warm', note: '看多占优，属于常态偏暖' },
  { min: 75, max: 100, label: '极度乐观', tone: 'hot', note: '看多占绝对多数，常见于题材高潮，需防一致性反转' }
];

export function ratioBand(ratioPct: number): RatioBand {
  const v = Math.max(0, Math.min(100, ratioPct));
  return RATIO_BANDS.find((b) => v >= b.min && v < b.max) ?? RATIO_BANDS[RATIO_BANDS.length - 1];
}

/** 分位（0~1）：value 在 series 中的位置 */
export function percentileOf(value: number, series: number[]): number {
  const arr = series.filter((x) => Number.isFinite(x));
  if (!arr.length) return 0.5;
  const below = arr.filter((x) => x < value).length;
  return below / arr.length;
}

export type Level = 'ice' | 'cold' | 'normal' | 'warm' | 'fever';

export interface LevelMeta {
  label: string;
  tone: BandTone;
  note: string;
}

export const LEVEL_META: Record<Level, LevelMeta> = {
  ice: { label: '情绪冰点', tone: 'cold', note: '历史低分位，亏钱效应充分释放，往往是反转前夜但不宜抄底过早' },
  cold: { label: '偏冷', tone: 'cool', note: '低于中枢，参与度不足' },
  normal: { label: '常态', tone: 'flat', note: '处于历史中间区间' },
  warm: { label: '偏热', tone: 'warm', note: '高于中枢，赚钱效应扩散' },
  fever: { label: '异常高涨', tone: 'hot', note: '历史高分位，追高胜率下降，注意兑现' }
};

/**
 * 情绪温度分档。
 *
 * **用绝对阈值，不用历史分位**：能拿到的长序列只有「量价近似温度」（由指数 K 线派生），
 * 它的刻度与七维综合分不是一回事（综合分还含资金/讨论/打板）。拿近似序列的分位去衡量
 * 综合分，会得出「100% 分位 = 异常高涨」这种看起来精确、其实口径错配的结论。
 *
 * 阈值依据（与天气五档对齐，并补出极端区）：
 *   0~15   冰点      —— 六维里至少四维同时趴下才可能到这里
 *   15~32  偏冷
 *   32~45  偏弱
 *   45~58  常态
 *   58~72  偏热
 *   72~85  过热
 *   85~100 异常高涨  —— 需要广度/强度/资金同时极值
 */
export function levelOf(score: number): { level: Level; band: string } {
  if (score <= 15) return { level: 'ice', band: '0~15 冰点' };
  if (score <= 32) return { level: 'cold', band: '15~32 偏冷' };
  if (score <= 45) return { level: 'cold', band: '32~45 偏弱' };
  if (score < 58) return { level: 'normal', band: '45~58 常态' };
  if (score < 72) return { level: 'warm', band: '58~72 偏热' };
  if (score < 85) return { level: 'warm', band: '72~85 过热' };
  return { level: 'fever', band: '85~100 异常高涨' };
}

/* ============ 结构指标 ============ */

export interface StructureMetrics {
  /** 分歧度 0~100：多空比越接近 50 越高 */
  divergence: number;
  /** 一致性 0~100 = 100 - 分歧度 */
  consensus: number;
  /** 讨论量（帖子 + 快讯条数） */
  volume: number;
  /** 主题集中度：TOP1 主题占比（0~1），越高说明讨论越聚焦 */
  focus: number;
  /** 信息含量（0~1）：非「闲聊无主题」的占比，越高说明讨论越有实质内容 */
  substance: number;
  /** 消息面多空比 − 论坛多空比（百分点），正值=消息比讨论更乐观 */
  newsGap: number | null;
  /** 量价背离：讨论热但价格跌 = 顶部特征；讨论冷但价格涨 = 底部特征 */
  priceGap: 'top' | 'bottom' | 'none';
}

export function structureMetrics(args: {
  ratio: number | null;
  volume: number;
  topics: TopicStat[];
  newsRatio: number | null;
  forumRatio: number | null;
  medianPct: number;
  volumeBaseline: number;
}): StructureMetrics {
  const r = args.ratio ?? 0.5;
  const divergence = Math.round((1 - Math.abs(2 * r - 1)) * 100);
  const otherTotal = args.topics.find((t) => t.topic === 'other')?.total ?? 0;
  const total = args.topics.reduce((s, t) => s + t.total, 0) || 1;
  // 集中度只看「有主题」的内容，否则闲聊会把分母撑大、把集中度压平
  const top = args.topics.filter((t) => t.topic !== 'other')[0]?.total ?? 0;
  const focus = total - otherTotal > 0 ? top / (total - otherTotal) : 0;

  const newsGap =
    args.newsRatio != null && args.forumRatio != null ? Math.round((args.newsRatio - args.forumRatio) * 100) : null;

  // 讨论量相对基准的冷热（基准用快讯条数 + 帖子条数的经验值，或调用方给的均值）
  const hot = args.volume > args.volumeBaseline * 1.15;
  const cold = args.volume < args.volumeBaseline * 0.75;
  let priceGap: StructureMetrics['priceGap'] = 'none';
  if (hot && args.medianPct < -0.3) priceGap = 'top';
  else if (cold && args.medianPct > 0.3) priceGap = 'bottom';

  const substance = total > 0 ? 1 - otherTotal / total : 0;

  return { divergence, consensus: 100 - divergence, volume: args.volume, focus, substance, newsGap, priceGap };
}

/* ============ 个股提及 ============ */

/**
 * 从标题里抽股票名。
 *
 * 做法：对标题做 2~5 字滑窗，查「名称 → 代码」索引。
 * 5576 只股票 × 每条 30 字 ≈ 每条 120 次查表，100 条也就 1.2 万次，开销可忽略。
 * 只收长度 ≥3 的名称，避免「中国」「东方」这类通用词误命中。
 */
/**
 * 通用词黑名单：这些词既可能是股票简称，也是题材/地域/行业通用词。
 * 不过滤的话，「机器人」会命中 300024（新松机器人），但标题里九成是在说题材，
 * 会把个股榜刷成噪声。宁可漏掉几只，也不要满屏误报。
 */
const GENERIC_NAMES = new Set([
  '机器人', '中国', '东方', '海南', '上海', '北京', '深圳', '广州', '天津', '重庆',
  '新疆', '西藏', '云南', '贵州', '四川', '湖南', '湖北', '河南', '河北', '山东',
  '山西', '陕西', '安徽', '福建', '江西', '浙江', '江苏', '广东', '广西', '辽宁',
  '吉林', '内蒙', '宁夏', '甘肃', '青海', '科技', '电力', '银行', '证券', '保险',
  '医药', '汽车', '钢铁', '煤炭', '有色', '化工', '地产', '传媒', '环保', '军工',
  '航空', '港口', '高速', '水务', '燃气', '水泥', '玻璃', '纸业', '纺织', '食品',
  '农业', '种业', '渔业', '林业', '旅游', '酒店', '零售', '超市', '百货', '家电',
  '家具', '建材', '装饰', '工程', '建设', '发展', '国际', '股份', '集团', '控股',
  '实业', '投资', '资本', '能源', '资源', '新材', '智能', '数字', '网络', '软件',
  '数据', '安全', '信息', '通信', '电子', '光电', '激光', '精密', '重工', '机械',
  '装备', '材料', '生物', '健康', '医疗', '制药', '药业', '饮料', '酒业', '乳业',
  '黄金', '稀土', '锂电', '光伏', '芯片', '半导', '算力', '证券', '基金'
]);

export function extractStocks(text: string, index: Map<string, string>, max = 3): { code: string; name: string }[] {
  const t = String(text ?? '');
  const out: { code: string; name: string }[] = [];
  const seen = new Set<string>();
  // 长名优先，避免「中国平安」被「中国」截胡
  for (let len = 6; len >= 3; len--) {
    for (let i = 0; i + len <= t.length; i++) {
      const sub = t.slice(i, i + len);
      if (GENERIC_NAMES.has(sub)) continue;
      const code = index.get(sub);
      if (code && !seen.has(code)) {
        seen.add(code);
        out.push({ code, name: sub });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

export interface StockMention {
  code: string;
  name: string;
  count: number;
  bull: number;
  bear: number;
  tone: 1 | 0 | -1;
}

export function stockMentions(posts: TonePost[], index: Map<string, string>, topN = 10): StockMention[] {
  const map = new Map<string, StockMention>();
  for (const p of posts) {
    for (const s of extractStocks(p.text, index)) {
      const cur = map.get(s.code) ?? { code: s.code, name: s.name, count: 0, bull: 0, bear: 0, tone: 0 as const };
      cur.count += 1;
      if (p.tone === 1) cur.bull += 1;
      else if (p.tone === -1) cur.bear += 1;
      map.set(s.code, cur);
    }
  }
  return [...map.values()]
    .map((m) => ({ ...m, tone: (m.bull > m.bear ? 1 : m.bear > m.bull ? -1 : 0) as 1 | 0 | -1 }))
    .filter((m) => m.count >= 2) // 只提一次的多半是误命中
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/* ============ 结论生成 ============ */

export interface StructureSummaryInput {
  ratio: number | null;
  sample: number;
  band: RatioBand;
  level: Level;
  /** 温度所处区间文字，如「58~72 偏热」 */
  tempBand: string;
  metrics: StructureMetrics;
  bullDrivers: { label: string; count: number }[];
  bearDrivers: { label: string; count: number }[];
  topStocks: StockMention[];
}

/** 把结构指标翻译成人话，避免用户自己拼结论 */
export function summarizeStructure(s: StructureSummaryInput): string[] {
  const lines: string[] = [];

  // 1. 多空与样本
  if (s.ratio == null) {
    lines.push('今日没有足够的带方向样本，多空比不成立。');
  } else {
    const pctText = `${(s.ratio * 100).toFixed(0)}%`;
    lines.push(
      `带方向样本 ${s.sample} 条，看多占比 ${pctText}，落在「${s.band.label}」区间——${s.band.note}。` +
        (s.sample < 20 ? '样本偏少，这个比例只能当参考。' : '')
    );
  }

  // 2. 归因
  if (s.bullDrivers.length || s.bearDrivers.length) {
    const b = s.bullDrivers.map((d) => `${d.label}(${d.count})`).join('、') || '无';
    const e = s.bearDrivers.map((d) => `${d.label}(${d.count})`).join('、') || '无';
    lines.push(`看多主要集中在 ${b}；看空集中在 ${e}。`);
  }

  // 3. 分歧
  const d = s.metrics.divergence;
  if (d >= 60) {
    lines.push(`分歧度 ${d}（偏高），多空观点尖锐对立，这种结构常见于变盘前。`);
  } else if (d >= 40) {
    lines.push(`分歧度 ${d}，仍有明显分歧，但方向已偏向一方。`);
  } else if (d >= 25) {
    lines.push(`分歧度 ${d}（偏低），观点较为一致，一致性行情往往已走到中后段。`);
  } else {
    lines.push(`分歧度 ${d}（很低），几乎没有反向声音，属于极端一致，警惕反转。`);
  }

  // 4. 背离
  if (s.metrics.priceGap === 'top') {
    lines.push('⚠️ 讨论热度高于常态但指数在跌，属于典型的「顶部特征」——人多的地方要小心。');
  } else if (s.metrics.priceGap === 'bottom') {
    lines.push('讨论冷清但指数在涨，属于「底部特征」——分歧中上涨，往往更健康。');
  }
  if (s.metrics.newsGap != null && Math.abs(s.metrics.newsGap) >= 20) {
    lines.push(
      s.metrics.newsGap > 0
        ? `消息面比论坛乐观 ${s.metrics.newsGap}pp：利好没被散户认可，可能存在预期差。`
        : `论坛比消息面乐观 ${Math.abs(s.metrics.newsGap)}pp：散户情绪跑在消息前面，注意透支。`
    );
  }

  // 5. 信息含量
  if (s.metrics.substance < 0.6) {
    lines.push(
      `讨论的信息含量只有 ${(s.metrics.substance * 100).toFixed(0)}%，` +
        `其余是实盘打卡、喊单和情绪宣泄——这类内容方向性最纯粹，但也最容易被带节奏。`
    );
  } else {
    lines.push(`讨论的信息含量 ${(s.metrics.substance * 100).toFixed(0)}%，多数发言能落到具体主题上。`);
  }

  // 6. 温度区间
  lines.push(`综合温度落在「${s.tempBand}」区间（${LEVEL_META[s.level].label}）。`);

  // 7. 个股
  if (s.topStocks.length) {
    const t = s.topStocks
      .slice(0, 3)
      .map((x) => `${x.name}(${x.count} 次)`)
      .join('、');
    lines.push(`被提及最多的个股是 ${t}。`);
  }

  return lines;
}
