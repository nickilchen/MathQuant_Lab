/**
 * 消息面「重点区分」（纯函数）
 *
 * 财联社电报的问题不是「没有数据」，而是**所有快讯长得一样**：
 * 一条「央行降准 0.5 个百分点」和一条「某公司中标 300 万」并排出现，
 * 只按时间倒序排列，读者得自己从 40 条里挑重点。
 *
 * 这一层做四件事：
 *   1. **分级** —— 综合官方重要度、政策/事件关键词、金额体量、阅读量，算出 0~100 影响力，分 S/A/B/C 四档；
 *   2. **分主题** —— 政策、公司事件、业绩、行业景气……并统计每个主题的条数与影响力占比；
 *   3. **分强弱** —— 多空不只 ±1，还看措辞强度（「暴跌」比「回落」重）；
 *   4. **算加权多空比** —— 用影响力当权重，而不是一条算一票。
 *
 * 为什么加权重要：40 条里 30 条中性小公告 + 1 条央行降准，
 * 条数比会说「多空 50%」，加权比才会告诉你「方向其实由那一条决定」。
 *
 * 打分是**规则 + 可解释**的，每条都能列出命中了哪些词、加了哪些分，
 * 不做黑箱模型——错的时候用户能一眼看出为什么错。
 */
import { scoreTitle } from './buzz';
import { TOPIC_META, type Topic } from './structure';

/* ============ 输入 ============ */

/** 与 data/cls.ts 的 NewsFlash 结构兼容，但不反向依赖 data 层 */
export interface NewsLike {
  id: string;
  text: string;
  /** 财联社官方重要度：A / B / C */
  level: string;
  read: number;
  time: string;
  subjects: string[];
}

/* ============ 档位 ============ */

export type NewsTier = 'S' | 'A' | 'B' | 'C';

export interface TierMeta {
  label: string;
  /** 一句话解释这一档是什么 */
  note: string;
  color: string;
}

export const TIER_META: Record<NewsTier, TierMeta> = {
  S: { label: 'S 级', note: '政策级 / 大额实质事件，足以改变当天主线', color: '#b45309' },
  A: { label: 'A 级', note: '有明确主体的实质消息（获批、中标、立案、业绩）', color: '#ea580c' },
  B: { label: 'B 级', note: '一般行业或公司动态，影响局部', color: '#2563eb' },
  C: { label: 'C 级', note: '例行播报 / 无实质信息，可略过', color: '#64748b' }
};

/* ============ 关键词表 ============ */

/** 政策级：命中即具备 S 级潜力，市场会按「全市场」而非「单只票」定价 */
const POLICY_RE =
  /央行|人民银行|证监会|国务院|国常会|财政部|发改委|工信部|商务部|金融监管总局|统计局|政治局|中央经济工作会议|降准|降息|LPR|MLF|逆回购|再贷款|印花税|IPO|注册制|退市制度|平准基金|汇金|国家队|窗口指导|监管约谈|专项行动|指导意见|实施方案|试点城市/;

/** 硬事件：有明确主体和动作，比「看好/关注」这类表态实在 */
const HARD_EVENT_RE =
  /获批|批准|中标|签订|签署|收购|并购|重组|定增|回购|减持|增持|立案|处罚|问询|停产|复产|涨价|提价|降价|投产|扩产|签约|订单|解禁|停牌|复牌|预增|预减|扭亏|亏损|分红|送转|易主|股权转让|战略合作|中标金额|合同金额/;

/** 例行播报：每天同一时间、同一句式，信息含量低，默认沉底 */
const ROUTINE_RE =
  /两市|沪深两市|今日共有|收盘播报|开盘播报|盘前必读|隔夜要闻|早间要闻|午间要闻|融资余额|北向资金|南向资金|主力资金|龙虎榜|沪指|深成指|创业板指|科创50|沪深300指数|恒生指数|美股收盘|港股收盘|欧股收盘|新股申购|新股上市|新股定位|申购指南|股东大会|限售股解禁|投资日历|财经日历|会议提醒|KOSPI|台交所加权|A50指数|指数期货|指数开盘|指数跌幅|指数涨幅|指数上涨|指数下跌|指数现报/;

/**
 * 合集型：一条快讯里塞了十条新闻（「早间新闻精选」「盘前速览」「一周盘点」）。
 *
 * 这类不能按单条打分：它天然包含大量政策词和金额，会把影响力堆到 S 级，
 * 但读者从里面拿不到「今天最重要的是什么」。所以打折、不打多空、不进焦点。
 */
const DIGEST_RE = /精选|汇总|盘点|一览|速览|日历|大事提醒|要闻|早报|晚报|早餐|复盘|十大|一周回顾|周末重磅/;

/** 金额要跟着「事件」才有意义：投资日历里也会出现「4120 亿」，那是背景数据不是事件体量 */
const AMOUNT_EVENT_RE =
  /中标|签约|签订|签署|收购|并购|回购|增持|减持|定增|募资|发行|合同|订单|投资\s*\d|总投资|降准|降息|投放|释放|再贷款|逆回购|补贴|减税|专项资金|罚款|处罚/;

/** 表态型（「看好/建议关注/预计」）：不算硬事件，避免被当成重大消息 */
const SOFT_RE = /看好|建议关注|预计|有望|或将|分析师|研报|机构调研|评级/;

/**
 * 政策方向词。
 *
 * 情绪词典解决不了「央行降准 0.5 个百分点」——这句话里没有任何多空词，
 * 按词典只会记中性，而它恰恰是当天最强的利好。所以政策类单独判方向。
 */
const EASY_RE = /降准|降息|下调.{0,14}(准备金率|LPR|利率|税率)|降印花税|净投放|再贷款|宽松|放松|支持|鼓励|补贴|减税|降费|稳增长|扩大内需|提振|平准基金/;
const TIGHT_RE = /上调.{0,14}(准备金率|LPR|利率|税率)|加息|收紧|严监管|去杠杆|限制|规范|暂停|净回笼|回笼资金|正回购/;

/* ============ 金额 ============ */

const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(万亿|亿|千万|万)\s*元?/g;

/** 从文本里抽最大的金额，统一折算成「亿」 */
export function maxAmountYi(text: string): number {
  const t = String(text ?? '');
  let best = 0;
  AMOUNT_RE.lastIndex = 0;
  for (;;) {
    const m = AMOUNT_RE.exec(t);
    if (!m) break;
    const v = Number(m[1]);
    if (!Number.isFinite(v)) continue;
    const unit = m[2];
    const yi = unit === '万亿' ? v * 10000 : unit === '亿' ? v : unit === '千万' ? v / 10 : v / 10000;
    if (yi > best) best = yi;
  }
  return best;
}

/* ============ 主题 ============ */

/** 消息面的主题规则：比论坛更偏「新闻体裁」，政策优先于宏观 */
const NEWS_TOPIC_RULES: { topic: Topic; re: RegExp }[] = [
  {
    topic: 'policy',
    re: /央行|人民银行|证监会|国务院|国常会|财政部|发改委|工信部|商务部|金融监管总局|统计局|政治局|降准|降息|LPR|MLF|逆回购|再贷款|印花税|政策|监管|规划|试点|补贴|关税|条例|办法|征求意见/
  },
  {
    topic: 'macro',
    re: /美联储|美股|纳指|道指|标普|欧股|日经|韩股|原油|黄金|汇率|美元指数|美元兑|美元走强|美元走弱|人民币|非农|CPI|PPI|通胀|衰退|地缘|加息|国债收益率|伊朗|以色列|俄罗斯|乌克兰|袭击|冲突|战争|导弹|制裁|空袭|停火|军方|爆炸|KOSPI|台交所|加权指数|A50|富时|韩国|日本|东京|外盘|指数期货|隔夜/
  },
  {
    topic: 'earnings',
    re: /业绩|净利|营收|预告|年报|季报|中报|扭亏|预增|预减|毛利率|净利润|同比增长|亏损|盈利/
  },
  {
    topic: 'event',
    re: /减持|增持|回购|重组|并购|收购|定增|配股|立案|问询|停牌|复牌|解禁|诉讼|分红|送转|退市|易主|股权转让|中标|签约|签订|获批|股东|董事会|公告|申购|新股|招股|过会|上市辅导|裁员|回购注销/
  },
  {
    topic: 'industry',
    re: /涨价|提价|降价|订单|产能|库存|开工|出货|扩产|投产|满产|销量|渗透率|需求|供给|价格|白酒|医药|券商|银行|地产|汽车|消费|农业|有色|煤炭|钢铁|化工|电力|军工|半导体|光伏|锂电|储能|家电|食品|旅游|建材|机械/
  },
  {
    topic: 'theme',
    re: /AI|算力|机器人|固态电池|芯片|创新药|低空|量子|稀土|核电|光模块|CPO|数据要素|可控核聚变|商业航天|航天|卫星|火箭|低轨|亚轨道|脑机|合成生物|培育钻石/
  },
  {
    topic: 'capital',
    re: /北向|南向|融资|两融|ETF|主力|净流入|净流出|基金|保险|社保|外资|成交额|量能|杠杆/
  }
];

/** 消息面主题分类：先按新闻体裁规则，再回落到通用主题 */
export function classifyNewsTopic(text: string): Topic {
  const t = String(text ?? '');
  for (const r of NEWS_TOPIC_RULES) if (r.re.test(t)) return r.topic;
  return 'other';
}

/** 消息面主题的展示名：'other' 在论坛里叫「闲聊无主题」，在快讯里叫「未归类」更准确 */
export function newsTopicLabel(t: Topic): string {
  return t === 'other' ? '未归类' : TOPIC_META[t].label;
}

export function newsTopicIcon(t: Topic): string {
  return t === 'other' ? '🗂️' : TOPIC_META[t].icon;
}

/* ============ 单条打分 ============ */

export interface NewsItem extends NewsLike {
  /** 快讯自带的小标题（【…】里的内容），没有则为空 */
  title: string;
  /** 去掉小标题后的正文 */
  body: string;
  tone: 1 | 0 | -1;
  /** 多空强度：0 中性 / 1 弱措辞 / 2 强措辞 */
  strength: 0 | 1 | 2;
  topic: Topic;
  topicLabel: string;
  topicIcon: string;
  tier: NewsTier;
  /** 0~100 影响力 */
  impact: number;
  /** 命中理由，用于 tooltip 与自证 */
  reasons: string[];
  /** 例行播报（收盘统计、融资余额之类） */
  routine: boolean;
  /** 合集型（早间精选、盘前速览）：一条里塞十条新闻，不参与焦点与方向统计 */
  digest: boolean;
  /** 多空加权用的权重 */
  weight: number;
}

/** 拆出「【标题】正文」，标题是财联社最凝练的信息，列表里优先展示 */
export function splitFlash(text: string): { title: string; body: string } {
  const t = String(text ?? '').trim();
  const m = /^【([^】]{2,60})】\s*([\s\S]*)$/.exec(t);
  if (m) return { title: m[1].trim(), body: m[2].trim() };
  return { title: '', body: t };
}

/** 合集判定：标题命中摘要词，或正文出现 ≥3 个编号条目 */
export function isDigest(text: string): boolean {
  const t = String(text ?? '');
  const { title, body } = splitFlash(t);
  if (DIGEST_RE.test(title)) return true;
  // 没有标题时只看开头 40 字，避免正文里偶然出现「一览」就误判
  if (!title && DIGEST_RE.test(t.slice(0, 40))) return true;
  // 编号条目既可能换行，也可能用分号串在同一行
  const numbered = (body.match(/(^|[；;。\n])\s*\d{1,2}[、.．]/g) || []).length;
  return numbered >= 3;
}

const LEVEL_BASE: Record<string, number> = { A: 42, B: 26, C: 14, D: 10 };

/**
 * 给一条快讯算影响力与档位。
 *
 * 分数构成（上限 100）：
 *   官方重要度 14~42 + 政策级 26 + 硬事件 12 + 金额 6/14/18 + 阅读 3/6/10 + 多板块 4
 *
 * 三个降权口子，都是实测踩出来的：
 *  - 例行播报（沪指收涨、融资余额）压到 C 档；
 *  - 合集型（早间精选、投资日历）打 0.55 折——它天然包含一堆政策词和金额，不折会直接冲到 S；
 *  - 金额只在有事件动词时才算体量，「投资日历」里的 4120 亿是背景数据。
 */
export function scoreNews(n: NewsLike): NewsItem {
  const text = String(n.text ?? '');
  const { title, body } = splitFlash(text);
  const level = String(n.level ?? 'C').toUpperCase();
  const reasons: string[] = [];

  let impact = LEVEL_BASE[level] ?? 14;
  if (level === 'A') reasons.push('官方标 A');

  const policy = POLICY_RE.test(text);
  const hard = HARD_EVENT_RE.test(text);

  if (policy) {
    impact += 26;
    reasons.push('政策级');
  }
  if (hard) {
    impact += 12;
    reasons.push('实质事件');
  }
  // 表态型措辞降权，避免「机构看好」被算成重大消息
  if (SOFT_RE.test(text) && !hard) {
    impact -= 8;
    reasons.push('表态型');
  }

  // 金额必须挂在事件上才有意义
  if (AMOUNT_EVENT_RE.test(text)) {
    const yi = maxAmountYi(text);
    if (yi >= 100) {
      impact += 18;
      reasons.push(`${yi >= 10000 ? `${(yi / 10000).toFixed(1)} 万亿` : `${yi.toFixed(0)} 亿`}体量`);
    } else if (yi >= 10) {
      impact += 14;
      reasons.push(`${yi.toFixed(0)} 亿体量`);
    } else if (yi >= 1) {
      impact += 6;
      reasons.push('亿元级');
    }
  }

  const read = Number(n.read ?? 0);
  if (read >= 100000) {
    impact += 10;
    reasons.push('阅读 10 万+');
  } else if (read >= 50000) {
    impact += 6;
    reasons.push('阅读 5 万+');
  } else if (read >= 10000) {
    impact += 3;
    reasons.push('阅读过万');
  }

  const subj = n.subjects?.length ?? 0;
  if (subj >= 2) {
    impact += 4;
    reasons.push(`覆盖 ${subj} 个板块`);
  }

  const digest = isDigest(text);
  const routine = !digest && ROUTINE_RE.test(text) && !policy && !hard;

  if (routine) {
    impact = Math.min(impact, 18);
    reasons.push('例行播报');
  } else if (digest) {
    impact = Math.round(impact * 0.55);
    reasons.push('合集摘要');
  }

  impact = Math.max(0, Math.min(100, Math.round(impact)));

  const tier: NewsTier = routine ? 'C' : impact >= 72 ? 'S' : impact >= 52 ? 'A' : impact >= 32 ? 'B' : 'C';

  // 快讯是公告体，不能套论坛那层「陈述型 → 中性」过滤
  const s = scoreTitle(text, { skipCommentary: true });
  let tone: 1 | 0 | -1 = s.tone;
  let strength: 0 | 1 | 2 = s.tone === 0 ? 0 : Math.abs(s.raw) >= 3 ? 2 : 1;

  // 词典没命中时，用政策方向兜底（降准/降息这类句子里没有情绪词）
  if (tone === 0) {
    if (EASY_RE.test(text)) {
      tone = 1;
      strength = 2;
      reasons.push('政策宽松');
    } else if (TIGHT_RE.test(text)) {
      tone = -1;
      strength = 2;
      reasons.push('政策收紧');
    }
  }

  // 合集里多空混杂，单条方向没有意义
  if (digest) {
    tone = 0;
    strength = 0;
  }

  const topic = classifyNewsTopic(text);
  const weight = routine ? 0.25 : digest ? 0.4 : 1 + impact / 40;

  return {
    ...n,
    title,
    body,
    tone,
    strength,
    topic,
    topicLabel: newsTopicLabel(topic),
    topicIcon: newsTopicIcon(topic),
    tier,
    impact,
    reasons,
    routine,
    digest,
    weight
  };
}

/* ============ 聚合 ============ */

export interface NewsTopicStat {
  topic: Topic;
  label: string;
  icon: string;
  total: number;
  bull: number;
  bear: number;
  neutral: number;
  /** 影响力合计 */
  impactSum: number;
  /** 该主题内影响力最高的一条 */
  top: NewsItem | null;
  /** 条数占比 0~1 */
  share: number;
  /** 影响力占比 0~1 */
  impactShare: number;
  /** 主题内条数多空比 */
  ratio: number | null;
  /** 主题内影响力加权多空比 */
  weightedRatio: number | null;
  /** 内部累加：多头/空头权重合计 */
  wBull: number;
  wBear: number;
}

export interface NewsAnalysis {
  /** 按影响力降序（同级内按时间新→旧） */
  items: NewsItem[];
  /** 焦点：S/A 级，最多 6 条；没有 S/A 时退化为影响力 TOP5 */
  focus: NewsItem[];
  total: number;
  tierCount: Record<NewsTier, number>;
  bull: number;
  bear: number;
  neutral: number;
  /** 条数口径多空比 */
  ratio: number | null;
  /** 影响力加权多空比 */
  weightedRatio: number | null;
  topics: NewsTopicStat[];
  /** 影响力占比最高的主题 */
  dominant: NewsTopicStat | null;
  /** 加权比 - 条数比（百分点）：>0 说明少数重磅偏多 */
  gap: number | null;
  routineCount: number;
  /** 合集型条数（早间精选、投资日历等） */
  digestCount: number;
  /** S/A 级贡献的影响力占比 0~1 */
  focusImpactShare: number;
  /** 自动结论 */
  lines: string[];
}

const pct1 = (v: number) => `${(v * 100).toFixed(1)}%`;

/** 展示用标题：优先快讯小标题，没有就取正文开头 */
export function headline(it: { title?: string; text?: string; body?: string }, n = 30): string {
  const s = String(it.title ?? '').trim() || String(it.text ?? it.body ?? '').trim();
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

/** 聚合消息面：分级、分主题、加权多空比、自动结论 */
export function analyzeNews(list: NewsLike[], focusN = 6): NewsAnalysis {
  const items = (list ?? []).map(scoreNews);

  // 影响力降序；同级按时间倒序（HH:mm 字符串可直接比较）
  items.sort((a, b) => b.impact - a.impact || String(b.time).localeCompare(String(a.time)));

  const tierCount: Record<NewsTier, number> = { S: 0, A: 0, B: 0, C: 0 };
  for (const it of items) tierCount[it.tier] += 1;

  let bull = 0;
  let bear = 0;
  let bullW = 0;
  let bearW = 0;
  let impactAll = 0;
  let impactFocus = 0;

  for (const it of items) {
    impactAll += it.impact;
    if (it.tier === 'S' || it.tier === 'A') impactFocus += it.impact;
    if (it.tone === 1) {
      bull += 1;
      bullW += it.weight;
    } else if (it.tone === -1) {
      bear += 1;
      bearW += it.weight;
    }
  }

  const total = items.length;
  const ratio = bull + bear > 0 ? bull / (bull + bear) : null;
  const weightedRatio = bullW + bearW > 0 ? bullW / (bullW + bearW) : null;
  // gap 用「与展示一致的整数百分比」相减，避免出现「36% 对 24% 却标 -13pp」
  const gap =
    ratio != null && weightedRatio != null
      ? Math.round(weightedRatio * 100) - Math.round(ratio * 100)
      : null;

  // 主题聚合
  const map = new Map<Topic, NewsTopicStat>();
  for (const it of items) {
    const cur =
      map.get(it.topic) ??
      ({
        topic: it.topic,
        label: newsTopicLabel(it.topic),
        icon: newsTopicIcon(it.topic),
        total: 0,
        bull: 0,
        bear: 0,
        neutral: 0,
        impactSum: 0,
        top: null,
        share: 0,
        impactShare: 0,
        ratio: null,
        weightedRatio: null,
        wBull: 0,
        wBear: 0
      } as NewsTopicStat);
    cur.total += 1;
    cur.impactSum += it.impact;
    if (it.tone === 1) cur.bull += 1;
    else if (it.tone === -1) cur.bear += 1;
    else cur.neutral += 1;
    if (it.tone === 1) cur.wBull += it.weight;
    else if (it.tone === -1) cur.wBear += it.weight;
    if (!cur.top || it.impact > cur.top.impact) cur.top = it;
    map.set(it.topic, cur);
  }
  const topics = [...map.values()];
  for (const s of topics) {
    s.share = total ? s.total / total : 0;
    s.impactShare = impactAll ? s.impactSum / impactAll : 0;
    s.ratio = s.bull + s.bear > 0 ? s.bull / (s.bull + s.bear) : null;
    s.weightedRatio = s.wBull + s.wBear > 0 ? s.wBull / (s.wBull + s.wBear) : null;
  }
  topics.sort((a, b) => b.impactSum - a.impactSum || b.total - a.total);
  const dominant = topics.length ? topics[0] : null;

  // 焦点：S/A 优先，不足时用高影响力 B 级补位（合集、例行、未归类永不入选）
  const usable = items.filter((it) => !it.digest && !it.routine && it.topic !== 'other');
  const focusCore = usable.filter((it) => it.tier === 'S' || it.tier === 'A');
  const focusFill = usable.filter((it) => it.tier === 'B' && it.impact >= 40);
  const focus = (focusCore.length ? [...focusCore, ...focusFill.slice(0, 2)] : usable.slice(0, 5)).slice(0, focusN);

  const routineCount = items.filter((it) => it.routine).length;
  const digestCount = items.filter((it) => it.digest).length;
  const focusImpactShare = impactAll ? impactFocus / impactAll : 0;

  /* ---------- 自动结论 ---------- */
  const lines: string[] = [];

  if (total) {
    const sa = tierCount.S + tierCount.A;
    const saShare = sa / total;
    // 影响力占比 / 条数占比：倍数越高说明「少数消息决定方向」
    const mult = saShare > 0 ? focusImpactShare / saShare : 0;
    lines.push(
      `${total} 条快讯里，S/A 级 ${sa} 条（占 ${pct1(saShare)}），贡献了 ${pct1(focusImpactShare)} 的影响力——` +
        (mult >= 2
          ? '重点高度集中，少数消息决定方向。'
          : mult >= 1.2
            ? '影响力略向重点倾斜，但仍有不少有效信息。'
            : '影响力分散，没有单一消息主导盘面。')
    );
  }

  if (weightedRatio != null && ratio != null && gap != null) {
    const wr = Math.round(weightedRatio * 100);
    const r = Math.round(ratio * 100);
    if (Math.abs(gap) >= 8) {
      lines.push(
        gap > 0
          ? `条数多空比 ${r}%，但按影响力加权后是 ${wr}%（+${gap}pp）：利好集中在重磅消息里，小消息偏空。`
          : `条数多空比 ${r}%，按影响力加权只有 ${wr}%（${gap}pp）：利空集中在重磅消息里，小消息偏多，别被条数骗了。`
      );
    } else {
      lines.push(`条数多空比 ${r}%，影响力加权 ${wr}%，两者接近（差 ${gap}pp），多空结构比较均衡。`);
    }
  }

  if (dominant) {
    // 方向用影响力加权：条数会被一堆中性小消息稀释，加权才反映真正主导方向
    const dr = dominant.weightedRatio ?? (dominant.bull + dominant.bear > 0 ? dominant.bull / (dominant.bull + dominant.bear) : 0.5);
    const dir = dr > 0.55 ? '偏多' : dr < 0.45 ? '偏空' : '多空各半';
    lines.push(
      `主导主题是「${dominant.label}」：${dominant.total} 条、影响力占 ${pct1(dominant.impactShare)}，内部${dir}` +
        (dominant.top ? `，代表消息是「${headline(dominant.top, 28)}」。` : '。')
    );
  }

  if (tierCount.S > 0) {
    const top = items[0];
    lines.push(`S 级 ${tierCount.S} 条，最重的一条是「${headline(top, 32)}」（影响力 ${top.impact}）。`);
  } else if (total) {
    lines.push('今日无 S 级消息，属于「没有主线催化」的常规信息环境。');
  }

  const noise: string[] = [];
  if (digestCount) noise.push(`${digestCount} 条合集型（早间精选、投资日历）按 0.55 折算且不计方向`);
  if (routineCount >= 3) noise.push(`${routineCount} 条例行播报（收盘统计、融资余额）沉到 C 档`);
  if (noise.length) lines.push(`另有 ${noise.join('，')}，均不参与焦点与加权。`);

  return {
    items,
    focus,
    total,
    tierCount,
    bull,
    bear,
    neutral: total - bull - bear,
    ratio,
    weightedRatio,
    topics,
    dominant,
    gap,
    routineCount,
    digestCount,
    focusImpactShare,
    lines
  };
}

/* ============ 筛选 ============ */

export type NewsFilter = 'focus' | 'all' | 'bull' | 'bear' | 'routine';

/** 按筛选条件过滤（列表默认只看焦点，避免 40 条平铺） */
export function filterNews(items: NewsItem[], f: NewsFilter, topic?: Topic | null): NewsItem[] {
  let out = items;
  if (topic) out = out.filter((it) => it.topic === topic);
  switch (f) {
    case 'focus':
      return out.filter((it) => (it.tier === 'S' || it.tier === 'A') && !it.digest && !it.routine);
    case 'bull':
      return out.filter((it) => it.tone === 1);
    case 'bear':
      return out.filter((it) => it.tone === -1);
    case 'routine':
      return out.filter((it) => it.routine);
    default:
      return out;
  }
}
