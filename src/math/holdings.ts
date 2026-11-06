/**
 * 机构持仓分类与分析（纯函数，无 UI / 网络依赖）
 *
 * 两层口径：
 *  1. 官方口径 —— 东财「机构持仓」报表直接给出 6 类（基金 / QFII / 社保 / 券商 / 保险 / 其他），
 *     合计即为机构持股，用于类型占比时序。
 *  2. 穿透口径 —— 官方「其他」是个大杂烩（产业资本、控股股东、私募、国家队都在里面），
 *     且东财把「国家大基金」也标成「私募基金」。因此用股东名称规则重新归类，
 *     得到 公募 / 私募 / 国家大基金 / 国家队 / 社保 / 保险 / 外资 / 券商 / 产业资本 / 个人 等属性。
 *
 * 规则顺序很重要：先强特征（大基金、国家队、社保、外资、私募品牌），再弱特征（托管行前缀、泛化的「基金」）。
 */

/* ============ 属性分类 ============ */

export type HolderClass =
  | 'bigfund' // 国家大基金 / 产业投资基金
  | 'national' // 国家队（证金、汇金、外汇局）
  | 'social' // 社保基金
  | 'public' // 公募基金
  | 'private' // 私募基金
  | 'insurance' // 保险资金
  | 'foreign' // QFII / 北向 / 外资
  | 'broker' // 券商 / 信托
  | 'industrial' // 产业资本 / 控股股东 / 国资平台
  | 'person' // 个人
  | 'other'; // 未识别

export interface ClassMeta {
  label: string;
  /** 是否属于「机构投资者」（产业资本与个人不计入机构口径） */
  inst: boolean;
  /** 一句话说明，用于图例与结论 */
  note: string;
}

export const CLASS_META: Record<HolderClass, ClassMeta> = {
  bigfund: { label: '国家大基金', inst: true, note: '国家级产业投资基金（集成电路/制造业转型等），产业背书属性' },
  national: { label: '国家队', inst: true, note: '证金、汇金、外汇局等平准资金' },
  social: { label: '社保基金', inst: true, note: '全国社保基金及组合，长线资金' },
  public: { label: '公募基金', inst: true, note: '公募基金及 ETF，被动与主动合计' },
  private: { label: '私募基金', inst: true, note: '私募证券基金，风格灵活、换手较高' },
  insurance: { label: '保险资金', inst: true, note: '寿险/财险及保险资管产品，负债端长久期' },
  foreign: { label: '外资 / QFII', inst: true, note: 'QFII、陆股通（香港中央结算）等境外资金' },
  broker: { label: '券商 / 信托', inst: true, note: '券商自营、资管与信托计划' },
  industrial: { label: '产业资本', inst: false, note: '控股股东、集团与国资平台，通常不视为财务投资者' },
  person: { label: '个人', inst: false, note: '自然人股东' },
  other: { label: '其他机构', inst: true, note: '未能归入上述类别的机构' }
};

/** 分类展示顺序（比例图/图例固定顺序，避免每次排序跳动） */
export const CLASS_ORDER: HolderClass[] = [
  'public',
  'private',
  'bigfund',
  'national',
  'social',
  'insurance',
  'foreign',
  'broker',
  'other',
  'industrial',
  'person'
];

export function isInstitution(cls: HolderClass): boolean {
  return CLASS_META[cls].inst;
}

/* ---- 名称规则 ---- */

const RE_BIGFUND =
  /国家集成电路产业投资基金|国家集成电路|国家制造业转型升级基金|制造业转型升级基金|国家中小企业发展基金|国家军民融合产业投资基金|国家绿色发展基金|国家战略性新兴产业|国家集成电路产业投资|大基金/;

const RE_NATIONAL = /中国证券金融|证券金融股份|中央汇金|汇金资产|梧桐树投资|国家外汇管理局|证金公司/;

const RE_SOCIAL = /全国社会保障基金|社会保障基金|社保基金|社保理事会/;

const RE_INSURANCE =
  /人寿保险|财产保险|养老保险|保险股份|保险资产|保险产品|再保险|平安人寿|太平洋保险|新华保险|泰康保险|人民保险|中国人保|中邮人寿|友邦保险|保险资管/;

const RE_FOREIGN =
  /香港中央结算|HKSCC|陆股通|沪股通|深股通|QFII|合格境外|摩根|高盛|瑞银|UBS|花旗|巴克莱|野村|新加坡政府投资|挪威中央银行|阿布达比|淡马锡|贝莱德|BlackRock|Vanguard|先锋领航|景顺|施罗德|安本|资本国际|MSCI/;

const RE_PRIVATE =
  /私募|高毅|景林|淡水泉|林园|幻方|九坤|明汯|灵均|衍复|重阳|星石|朱雀|少数派|汉和|盘京|聚鸣|宁泉|睿郡|慎知|汉唐|彤源|大朴|石锋|源乐晟|世诚|泰旸|东方港湾|但斌|冯柳|裘国根/;

/** 公募产品特征：ETF / 指数基金 / 混合 / 债券 / 灵活配置 / 基金公司专户 */
const RE_PUBLIC_PRODUCT =
  /交易型开放式指数|ETF|指数型|指数A|指数C|混合A|混合C|股票A|股票C|债券A|债券C|灵活配置|证券投资基金|货币市场基金|基金-.*(资产管理计划|FOF)/;

const RE_FUND_HOUSE = /基金管理(有限)?公司|基金管理股份|资产管理(有限)?公司.*基金/;

const RE_BROKER = /证券股份|证券有限|证券公司|证券自营|证券资管|信托有限|信托公司|信托计划|证券投资部/;

const RE_INDUSTRIAL =
  /集团有限公司|\(集团\)|控股集团|控股有限|投资控股|投资(有限)?公司|资本运营|国有资产|国资委|财政局|开发投资|产业投资|创业投资|股权投资|实业(有限)?公司|科技集团|信息通信集团|电子科技集团|酒厂|集团公司|有限责任公司|股份有限公司/;

const RE_PERSON_HINT = /公司|基金|合伙|银行|证券|保险|信托|投资|集团|控股|中心|委员会|大学|研究院|事务所|管理局|财政|工会|职工持股会/;

/**
 * 把股东名称 + 官方机构类型映射到属性分类。
 * @param name 股东名称（可能带「XX公司-XX基金」的托管结构）
 * @param orgType 东财官方机构类型：基金/QFII/社保/券商/保险/私募基金/证券投资基金/投资公司/个人/其它
 */
export function classifyHolder(name: string, orgType?: string): HolderClass {
  // 新浪/部分披露用全角连字符「－」连接托管行与产品名，统一成半角再匹配
  const n = (name ?? '').replace(/[－—–]/g, '-').trim();
  const t = (orgType ?? '').trim();
  if (!n && !t) return 'other';

  // 1) 强特征优先：东财会把「国家大基金」标成私募基金，必须先按名称识别
  if (RE_BIGFUND.test(n)) return 'bigfund';
  if (RE_NATIONAL.test(n)) return 'national';
  if (t === '社保' || RE_SOCIAL.test(n)) return 'social';
  if (t === '保险' || RE_INSURANCE.test(n)) return 'insurance';
  if (t === 'QFII' || RE_FOREIGN.test(n)) return 'foreign';
  // 私募品牌 / 官方标注，先于「基金」泛匹配
  if (t === '私募基金' || RE_PRIVATE.test(n)) return 'private';

  // 2) 公募：官方标「基金 / 证券投资基金」，或名称是公募产品（托管行前缀不影响判断）
  if (t === '基金' || t === '证券投资基金' || RE_PUBLIC_PRODUCT.test(n) || RE_FUND_HOUSE.test(n)) return 'public';

  // 3) 券商 / 信托
  if (t === '券商' || RE_BROKER.test(n)) return 'broker';

  // 4) 产业资本 / 控股股东
  if (t === '投资公司' || RE_INDUSTRIAL.test(n)) return 'industrial';

  // 5) 个人
  if (t === '个人' || (n.length <= 8 && !RE_PERSON_HINT.test(n))) return 'person';

  return 'other';
}

/* ============ 聚合 ============ */

export interface HolderLike {
  name: string;
  orgType?: string;
  /** 持股市值（元） */
  value: number;
  /** 持股数（股） */
  shares: number;
  /** 占总股本比例（%） */
  ratio: number;
}

export interface ClassBucket {
  cls: HolderClass;
  label: string;
  inst: boolean;
  /** 该属性下的股东家数 */
  count: number;
  /** 市值合计（元） */
  value: number;
  /** 持股数合计（股） */
  shares: number;
  /** 占总股本比例合计（%） */
  ratio: number;
  /** 占「机构合计市值」的比重（0–1）；非机构为 0 */
  instShare: number;
}

/**
 * 按属性聚合股东明细。
 * @param rows 股东明细（已限定同一报告期）
 * @param opts.instOnly 只保留机构投资者（默认 false，返回全量并标注 inst 标记）
 */
export function aggregateClasses(rows: HolderLike[], opts: { instOnly?: boolean } = {}): ClassBucket[] {
  const map = new Map<HolderClass, ClassBucket>();
  let instTotal = 0;

  for (const r of rows) {
    const cls = classifyHolder(r.name, r.orgType);
    const meta = CLASS_META[cls];
    if (opts.instOnly && !meta.inst) continue;
    const cur =
      map.get(cls) ??
      ({ cls, label: meta.label, inst: meta.inst, count: 0, value: 0, shares: 0, ratio: 0, instShare: 0 } as ClassBucket);
    cur.count += 1;
    cur.value += r.value;
    cur.shares += r.shares;
    cur.ratio += r.ratio;
    map.set(cls, cur);
    if (meta.inst) instTotal += r.value;
  }

  const out = [...map.values()];
  for (const b of out) b.instShare = b.inst && instTotal > 0 ? b.value / instTotal : 0;
  const order = new Map(CLASS_ORDER.map((c, i) => [c, i]));
  out.sort((a, b) => (order.get(a.cls)! - order.get(b.cls)!));
  return out;
}

/** 机构口径下的市值合计（元） */
export function institutionValue(buckets: ClassBucket[]): number {
  return buckets.reduce((s, b) => s + (b.inst ? b.value : 0), 0);
}

/** 机构口径下的持股比例合计（%） */
export function institutionRatio(buckets: ClassBucket[]): number {
  return buckets.reduce((s, b) => s + (b.inst ? b.ratio : 0), 0);
}

/* ============ 集中度 ============ */

export interface Concentration {
  /** 赫芬达尔指数：Σwᵢ²，w 为各机构市值占机构合计的比重（0–1） */
  hhi: number;
  /** 第一大机构占机构合计市值比重 */
  top1: number;
  /** 前五大 / 前十大占比 */
  top5: number;
  top10: number;
  /** 等效机构家数 = 1/HHI，越小越集中 */
  effectiveN: number;
}

/** 计算机构持仓集中度（只统计机构投资者） */
export function concentration(rows: HolderLike[]): Concentration {
  const vals = rows
    .filter((r) => isInstitution(classifyHolder(r.name, r.orgType)))
    .map((r) => Math.max(0, r.value))
    .sort((a, b) => b - a);
  const total = vals.reduce((s, v) => s + v, 0);
  if (total <= 0) return { hhi: 0, top1: 0, top5: 0, top10: 0, effectiveN: 0 };
  const w = vals.map((v) => v / total);
  const hhi = w.reduce((s, x) => s + x * x, 0);
  const sum = (k: number) => w.slice(0, k).reduce((s, x) => s + x, 0);
  return {
    hhi,
    top1: w[0] ?? 0,
    top5: sum(5),
    top10: sum(10),
    effectiveN: hhi > 0 ? 1 / hhi : 0
  };
}

/* ============ 信号（可解释评分） ============ */

export interface SignalReason {
  text: string;
  /** 该项对总分的贡献（正=偏多/偏强，负=偏空/偏弱） */
  delta: number;
}

export interface InstSignal {
  /** 0–100 */
  score: number;
  tone: 'bull' | 'bear' | 'flat';
  label: string;
  reasons: SignalReason[];
}

export interface SignalInput {
  /** 机构合计持股占总股本（%） */
  instRatio: number;
  /** 上期机构合计持股占比（%），缺省表示无环比 */
  prevInstRatio?: number | null;
  /** 股东户数环比（小数，-0.05 表示减少 5%），缺省表示无数据 */
  holderNumChg?: number | null;
  /** 是否出现国家大基金 */
  hasBigfund: boolean;
  /** 是否出现国家队 */
  hasNational: boolean;
  /** 公募占总股本（%） */
  publicRatio: number;
  /** 集中度 HHI（0–1） */
  hhi: number;
}

/**
 * 机构持仓评分（0–100，50 为中性）。
 * 设计原则：每一项都可解释、可追溯，避免黑箱总分。
 */
export function instSignal(input: SignalInput): InstSignal {
  const reasons: SignalReason[] = [];
  let score = 50;

  const add = (text: string, delta: number) => {
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.01) return;
    score += delta;
    reasons.push({ text, delta });
  };

  // 1) 绝对水平：机构持股占比越高，筹码越稳定
  const r = input.instRatio;
  if (r >= 30) add(`机构合计持股 ${r.toFixed(1)}%，属于高度机构化`, 14);
  else if (r >= 15) add(`机构合计持股 ${r.toFixed(1)}%，机构参与度高`, 10);
  else if (r >= 8) add(`机构合计持股 ${r.toFixed(1)}%，机构参与度中等`, 5);
  else if (r >= 3) add(`机构合计持股 ${r.toFixed(1)}%，机构参与度偏低`, 0);
  else add(`机构合计持股仅 ${r.toFixed(1)}%，机构关注度很低`, -6);

  // 2) 环比方向：增减仓是核心边际信息
  if (input.prevInstRatio != null && Number.isFinite(input.prevInstRatio)) {
    const d = r - input.prevInstRatio;
    if (Math.abs(d) >= 0.05) {
      const delta = Math.max(-12, Math.min(12, d * 6));
      add(`机构持股环比${d > 0 ? '增加' : '减少'} ${Math.abs(d).toFixed(2)} 个百分点`, delta);
    } else {
      add('机构持股环比基本持平', 0);
    }
  }

  // 3) 股东户数：下降=筹码集中（同股数分给更少的人）
  if (input.holderNumChg != null && Number.isFinite(input.holderNumChg)) {
    const c = input.holderNumChg;
    if (c <= -0.1) add(`股东户数环比减少 ${Math.abs(c * 100).toFixed(1)}%，筹码显著集中`, 10);
    else if (c < -0.02) add(`股东户数环比减少 ${Math.abs(c * 100).toFixed(1)}%，筹码趋于集中`, 6);
    else if (c >= 0.1) add(`股东户数环比增加 ${(c * 100).toFixed(1)}%，筹码明显分散`, -10);
    else if (c > 0.02) add(`股东户数环比增加 ${(c * 100).toFixed(1)}%，筹码趋于分散`, -5);
    else add('股东户数环比基本稳定', 0);
  }

  // 4) 特殊资金：国家级资金在场是产业背书，但也可能是长期不动
  if (input.hasBigfund) add('国家大基金在列，具备产业政策背书', 8);
  if (input.hasNational) add('国家队在列，具备平准资金托底特征', 5);

  // 5) 结构：公募主导更透明；单一机构控盘反而有流动性风险
  if (input.publicRatio >= 5) add(`公募持股 ${input.publicRatio.toFixed(1)}%，定价权集中在公募`, 3);
  if (input.hhi >= 0.35) add(`集中度 HHI ${input.hhi.toFixed(2)}，单一机构控盘，流动性风险上升`, -5);
  else if (input.hhi > 0 && input.hhi <= 0.08) add(`集中度 HHI ${input.hhi.toFixed(2)}，持仓高度分散`, 2);

  score = Math.max(0, Math.min(100, score));
  const tone: InstSignal['tone'] = score >= 62 ? 'bull' : score <= 42 ? 'bear' : 'flat';
  const label =
    tone === 'bull' ? '机构增持 / 筹码集中' : tone === 'bear' ? '机构减持 / 筹码分散' : '机构持仓中性';
  return { score: Math.round(score), tone, label, reasons };
}

/* ============ 分布与分位（行业对比用） ============ */

export interface Histogram {
  /** 每箱左闭右开的区间标签 */
  labels: string[];
  /** 每箱计数 */
  counts: number[];
  /** 箱宽 */
  width: number;
  /** 上界 */
  max: number;
  /** 某个值落在第几箱（越界会被夹到首/末箱） */
  binOf: (v: number) => number;
}

/**
 * 等宽直方图。
 * @param values 样本（负数会被夹到 0）
 * @param bins 箱数
 */
export function histogram(values: number[], bins = 10): Histogram {
  const vals = values.filter((v) => Number.isFinite(v)).map((v) => Math.max(0, v));
  const b = Math.max(1, Math.floor(bins));
  const max = vals.length ? Math.max(...vals) : 1;
  // 全 0 样本也要有一格
  const width = max > 0 ? max / b : 1;
  const counts = new Array(b).fill(0) as number[];
  for (const v of vals) {
    const i = Math.min(b - 1, Math.floor(v / width));
    counts[i] += 1;
  }
  const d = width >= 1 ? 0 : 1;
  const labels = counts.map((_, i) => `${(i * width).toFixed(d)}~${((i + 1) * width).toFixed(d)}`);
  const binOf = (v: number) => {
    if (!Number.isFinite(v)) return -1;
    return Math.max(0, Math.min(b - 1, Math.floor(Math.max(0, v) / width)));
  };
  return { labels, counts, width, max, binOf };
}

/**
 * 分位：样本中严格小于 value 的比例（0–1）。
 * 例：180 只成分股里 83 只低于它 → 0.46，表示「超过 46% 的同行业公司」。
 */
export function percentileRank(values: number[], value: number): number {
  const vals = values.filter((v) => Number.isFinite(v));
  if (!vals.length) return 0;
  const below = vals.reduce((s, v) => s + (v < value ? 1 : 0), 0);
  return below / vals.length;
}

/** 中位数 */
export function median(values: number[]): number {
  const vals = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!vals.length) return 0;
  const mid = Math.floor(vals.length / 2);
  return vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
}

/** 把 0–1 的分位说成人话 */
export function percentileText(p: number): string {
  const pct = Math.round(p * 100);
  if (pct >= 90) return `行业前 ${100 - pct || 1}%`;
  if (pct >= 50) return `高于 ${pct}% 同行`;
  return `低于 ${100 - pct}% 同行`;
}

/* ============ 小工具 ============ */

/** 把 0.0523 这类比例格式化为百分数 */
export const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

/** 亿元格式化 */
export function yi(v: number, d = 2): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e12) return `${(v / 1e12).toFixed(d)}万亿`;
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(d)}亿`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(d)}万`;
  return v.toFixed(0);
}

/** 万股 / 亿股 */
export function sharesText(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (Math.abs(v) >= 1e8) return `${(v / 1e8).toFixed(2)}亿股`;
  if (Math.abs(v) >= 1e4) return `${(v / 1e4).toFixed(2)}万股`;
  return `${v.toFixed(0)}股`;
}

/** 报告期排序（YYYY-MM-DD 字符串可直接比较） */
export function sortDatesDesc(dates: string[]): string[] {
  return [...new Set(dates)].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

/** 取上一个报告期（不存在返回 null） */
export function prevDate(periods: string[], date: string): string | null {
  const sorted = sortDatesDesc(periods);
  const i = sorted.indexOf(date);
  return i >= 0 && i + 1 < sorted.length ? sorted[i + 1] : null;
}
