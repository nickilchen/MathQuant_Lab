/**
 * 全网讨论情绪（纯函数）
 *
 * 两条互补的线：
 *  1. **讨论情绪** —— 抓股吧热帖标题，用多空词典打分，得到「看多 / 看空 / 中性」比例。
 *     标题短、噪声大，所以只做「词表 + 否定词翻转 + 强词加权」，不吹成 NLP 模型。
 *  2. **讨论热度** —— 股吧人气榜 TOP N 的赚钱效应。散户扎堆的票在涨，说明追涨情绪高；
 *     扎堆的票在跌，说明人气变成了接盘。
 *
 * 词典法的局限必须说清楚：反讽（「又要跌停了吧」）、谐音、多义词都会误判，
 * 所以它只作为一个维度参与加权，不单独构成买卖信号。
 */

/* ============ 词典 ============ */

/** 强多（权重 2）：方向明确、情绪浓 */
const BULL_STRONG = [
  '涨停',
  '一字板',
  '地天板',
  '暴涨',
  '飙升',
  '新高',
  '突破',
  '翻倍',
  '主升浪',
  '放量上攻',
  '绝地反击',
  '抄底',
  '满仓',
  '牛市',
  '反转',
  '起飞'
];

/** 弱多（权重 1） */
const BULL_WEAK = [
  '上涨',
  '红盘',
  '反弹',
  '加仓',
  '买入',
  '增持',
  '回购',
  '利好',
  '看多',
  '做多',
  '上车',
  '强势',
  '洗盘',
  '蓄势',
  '突破在即',
  '业绩超预期',
  '扭亏',
  '低估',
  '价值洼地',
  '龙头',
  '核心资产',
  '分红',
  '大涨',
  '拉升',
  '走高',
  '走强',
  '翻红',
  '冲高',
  '领涨',
  '补涨',
  '抗跌',
  '高开',
  '连板',
  '打板',
  '首板',
  '吸筹',
  '建仓',
  '加仓',
  '解套',
  '抬轿',
  '多头',
  '妖股',
  '牛市',
  // 消息面催化（快讯里最常见的利好措辞）
  '获批',
  '中标',
  '签订',
  '提价',
  '涨价',
  '复产',
  '战略合作',
  '订单增长'
];

/** 强空（权重 2） */
const BEAR_STRONG = [
  '跌停',
  '闪崩',
  '暴跌',
  '跳水',
  '腰斩',
  '新低',
  '破位',
  '爆雷',
  '退市',
  '崩盘',
  '踩踏',
  '割肉',
  '清仓',
  '熊市',
  '戴帽',
  '立案'
];

/** 弱空（权重 1） */
const BEAR_WEAK = [
  '下跌',
  '绿盘',
  '回调',
  '减仓',
  '卖出',
  '减持',
  '利空',
  '看空',
  '做空',
  '下车',
  '弱势',
  '出货',
  '砸盘',
  '套牢',
  '亏损',
  '商誉',
  '质押',
  '跑路',
  '接盘',
  '高估',
  '泡沫',
  '业绩变脸',
  '大跌',
  '跳水',
  '走低',
  '走弱',
  '翻绿',
  '回落',
  '领跌',
  '补跌',
  '低开',
  '空头',
  '空仓',
  '站岗',
  '逃顶',
  '套住',
  '抛售',
  '砸盘',
  '破发',
  '亏钱',
  '腰斩',
  '熊市',
  // 消息面催化（快讯里最常见的利空措辞）
  '处罚',
  '问询',
  '违规',
  '停产',
  '召回',
  '下调评级',
  '诉讼',
  '解禁'
];

/** 否定词：出现在多空词前面 2 个字内则翻转极性 */
const NEGATIONS = ['不', '没', '别', '勿', '未', '难', '无'];

/**
 * 「资讯 / 复盘型」标题：描述行情而不是表达观点。
 *
 * 淘股吧大量帖子是「11.2复盘：今日涨停 80 家…」「早评：三大指数低开」，
 * 里面的「涨停 / 低开」是陈述事实，不是看多看空。这类标题一律记中性，
 * 否则多空比会被系统性拉偏（实测未过滤时看多占比 89%，明显失真）。
 */
const COMMENTARY = /复盘|早评|午评|收评|盘前|盘后|异动|快讯|公告|研报|龙虎榜|涨停潮|消息面|三大指数|沪指|深成指|创业板指|两市/;

export function isCommentary(title: string): boolean {
  return COMMENTARY.test(String(title ?? ''));
}

export interface TitleScore {
  /** 极性：1 多 / -1 空 / 0 中性 */
  tone: 1 | 0 | -1;
  /** 原始得分（正=多，负=空） */
  raw: number;
}

/**
 * 给单条标题打分。
 *
 * 规则：
 *  - 命中强词 ±2、弱词 ±1，累加；
 *  - 若词前 2 字内出现否定词，极性翻转（「不会跌停」→ 偏多）；
 *  - 总分 > 0 记为看多，< 0 记为看空，= 0 记为中性。
 *
 * `skipCommentary`：论坛标题需要过滤「复盘/早评/公告」这类陈述型内容，
 * 但**快讯本身就是公告体**（「XX股份公告，拟收购…」），套同一层过滤会把
 * 消息面全部打成中性，所以消息面调用时要跳过这层过滤。
 */
export function scoreTitle(title: string, opts?: { skipCommentary?: boolean }): TitleScore {
  const t = String(title ?? '');
  if (!t) return { tone: 0, raw: 0 };
  // 资讯/复盘型标题只陈述事实，不计多空
  if (!opts?.skipCommentary && isCommentary(t)) return { tone: 0, raw: 0 };

  let raw = 0;
  const hit = (word: string, weight: number, dir: 1 | -1) => {
    let from = 0;
    for (;;) {
      const i = t.indexOf(word, from);
      if (i < 0) break;
      // 否定词窗口取 3 个字：「别急着抄底」的「别」离「抄底」隔了 2 个字
      const before = t.slice(Math.max(0, i - 3), i);
      const negated = NEGATIONS.some((n) => before.includes(n));
      raw += weight * dir * (negated ? -1 : 1);
      from = i + word.length;
    }
  };

  for (const w of BULL_STRONG) hit(w, 2, 1);
  for (const w of BULL_WEAK) hit(w, 1, 1);
  for (const w of BEAR_STRONG) hit(w, 2, -1);
  for (const w of BEAR_WEAK) hit(w, 1, -1);

  return { tone: raw > 0 ? 1 : raw < 0 ? -1 : 0, raw };
}

/* ============ 帖子聚合 ============ */

export interface BuzzPostLike {
  code: string;
  name: string;
  title: string;
  read: number;
  reply: number;
  time: string;
}

export interface BuzzPostScored extends BuzzPostLike {
  tone: 1 | 0 | -1;
  /** 热度 = 阅读 + 评论×20，用于排序与加权 */
  heat: number;
}

export interface BuzzResult {
  posts: BuzzPostScored[];
  bull: number;
  bear: number;
  neutral: number;
  /** 多空比 = 多 / (多 + 空)，无有效样本时为 null */
  bullRatio: number | null;
  /** 0~100 讨论情绪分；中性记 50 */
  score: number;
}

/**
 * 聚合热帖情绪。
 *
 * 用「阅读 + 评论×20」作权重：一条被读 2 万次的热帖，比一条没人看的帖子更能代表市场情绪。
 * 但仍同时给出**条数**口径，避免单条爆款左右结论。
 */
export function analyzePosts(posts: BuzzPostLike[]): BuzzResult {
  // 同一篇资讯会被转发到多个股吧，按标题去重，避免一篇通稿占满多空比
  const seen = new Set<string>();
  const deduped = posts.filter((p) => {
    const k = p.title.replace(/\s+/g, '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  const scored: BuzzPostScored[] = deduped.map((p) => {
    const s = scoreTitle(p.title);
    return { ...p, tone: s.tone, heat: Math.max(1, (p.read || 0) + (p.reply || 0) * 20) };
  });

  let bull = 0;
  let bear = 0;
  let neutral = 0;
  let bullW = 0;
  let bearW = 0;
  let neutralW = 0;

  for (const p of scored) {
    if (p.tone === 1) {
      bull += 1;
      bullW += p.heat;
    } else if (p.tone === -1) {
      bear += 1;
      bearW += p.heat;
    } else {
      neutral += 1;
      neutralW += p.heat;
    }
  }

  const total = scored.length;
  const bullRatio = bull + bear > 0 ? bull / (bull + bear) : null;

  // 条数口径（中性算半分）与热度口径各占 60% / 40%，避免单条爆款左右结论
  const countScore = total > 0 ? (bull + neutral * 0.5) / total : 0.5;
  const totalW = bullW + bearW + neutralW;
  const heatScore = totalW > 0 ? (bullW + neutralW * 0.5) / totalW : countScore;
  const blended = 0.6 * countScore + 0.4 * heatScore;

  return {
    // 有明确倾向的排前面（同倾向内按热度），中性水贴垫底
    posts: scored.sort((a, b) => Math.abs(b.tone) - Math.abs(a.tone) || b.heat - a.heat),
    bull,
    bear,
    neutral,
    bullRatio,
    score: Math.round(Math.min(100, Math.max(0, blended * 100)) * 10) / 10
  };
}

/* ============ 人气榜 ============ */

export interface PopularStock {
  code: string;
  name: string;
  /** 人气排名（1 = 最热） */
  rank: number;
  /** 排名变化（正=名次上升） */
  rankChange: number;
  /** 涨跌幅（%） */
  pct: number;
  /** 换手率（%） */
  turnover: number;
}

/**
 * 讨论热度分：人气榜 TOP N 的赚钱效应。
 *
 *   0.55 × 上涨家数占比 + 0.45 × tanh 压缩后的平均涨幅
 *
 * 逻辑：散户扎堆的票如果集体上涨，说明「追涨有回报」，情绪正循环；
 * 如果集体下跌，说明人气变成了接盘，属于典型的退潮特征。
 */
export function popularityScore(stocks: PopularStock[], topN = 30): number {
  const top = stocks.slice(0, topN);
  if (!top.length) return 50;
  const up = top.filter((s) => s.pct > 0).length;
  const upRatio = up / top.length;
  const avg = top.reduce((s, x) => s + x.pct, 0) / top.length;
  const avgScore = 0.5 + 0.5 * Math.tanh(avg / 2.5);
  return Math.round(Math.min(100, Math.max(0, 100 * (0.55 * upRatio + 0.45 * avgScore))) * 10) / 10;
}

/** 讨论维度合成：人气榜赚钱效应 60% + 热帖多空比 40% */
export function buzzScore(pop: PopularStock[] | null, posts: BuzzResult | null): number | null {
  const p = pop && pop.length ? popularityScore(pop) : null;
  const t = posts && posts.posts.length ? posts.score : null;
  if (p == null && t == null) return null;
  if (p == null) return t;
  if (t == null) return p;
  return Math.round((p * 0.6 + t * 0.4) * 10) / 10;
}

/** 关注度分箱（千股千评 FOCUS，0~100） */
export function focusDistribution(values: number[], bins = 10): { labels: string[]; counts: number[] } {
  const labels: string[] = [];
  const counts = new Array(bins).fill(0) as number[];
  const width = 100 / bins;
  for (let i = 0; i < bins; i++) labels.push(`${Math.round(i * width)}~${Math.round((i + 1) * width)}`);
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    const i = Math.min(bins - 1, Math.max(0, Math.floor(v / width)));
    counts[i] += 1;
  }
  return { labels, counts };
}
