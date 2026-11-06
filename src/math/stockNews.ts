/**
 * 个股消息面（公告/事件）打标（纯函数）
 *
 * 个股页原来只有技术面（趋势法），缺一条「公司在发生什么」的线。
 * 公告是最结构化的事件源：回购、减持、增持、中标、获批、立案……
 * 这些动作对股价的影响方向明确，比新闻标题可靠得多。
 *
 * 这一层做三件事：
 *   1. **打标签**：一条公告归到 1~2 个动作标签（回购 / 减持 / 中标 / 立案…）；
 *   2. **定方向**：标签自带多空（回购偏多、减持偏空），业绩类看措辞；
 *   3. **排重要性**：立案 > 减持 > 回购 > 中标 > 获批 > 业绩……再叠时效与金额。
 *
 * 规则完全可解释：每条都能说出命中了哪个词，错的时候一眼看得出为什么错。
 */

/* ============ 市场 ============ */

export type AnnMarket = 'CN' | 'HK' | 'US' | 'JP' | 'KR';

/** 各市场的面板措辞：美股是监管申报，港股是港交所公告，不能都叫「公告」 */
export const ANN_SOURCE_META: Record<AnnMarket, { label: string; desc: string }> = {
  CN: { label: '公告', desc: '来自东财公告库，按重要性排序' },
  HK: { label: '港交所公告', desc: '来自东财港股公告库（繁体原文），按重要性排序' },
  US: { label: 'SEC 申报', desc: '来自 SEC EDGAR（8-K / 10-Q / Form 4 等监管申报），按重要性排序' },
  JP: { label: '適時開示', desc: '来自 TDnet 適時開示' },
  KR: { label: '新闻', desc: '来自 Naver 新闻（非公司公告，方向仅供参考）' }
};

/* ============ 标签 ============ */

export type AnnTag =
  | 'buyback' // 回购
  | 'increase' // 增持
  | 'reduce' // 减持
  | 'incentive' // 股权激励
  | 'placement' // 定增/再融资
  | 'contract' // 中标/合同
  | 'approval' // 获批/注册
  | 'earnings' // 业绩
  | 'dividend' // 分红
  | 'unlock' // 解禁
  | 'risk' // 立案/处罚/退市风险
  | 'lawsuit' // 诉讼/冻结
  | 'ma' // 重组/并购
  | 'suspend' // 停复牌
  | 'exec' // 人事变动
  | 'pledge' // 股权质押
  | 'subsidy' // 政府补助
  | 'meeting' // 说明会/调研（程序性）
  | 'insider' // 内部人交易（美股 Form 4）
  | 'stake' // 大额持股（美股 13D/13G）
  | 'material' // 重大事件（美股 8-K 兜底）
  | 'other'; // 其他

export interface AnnTagMeta {
  label: string;
  icon: string;
  /** 1 利好 / 0 中性 / -1 利空（业绩类会按措辞覆盖） */
  tone: 1 | 0 | -1;
  /** 越大越重要，用于选主标签与排序 */
  priority: number;
}

export const ANN_TAG_META: Record<AnnTag, AnnTagMeta> = {
  risk: { label: '立案处罚', icon: '⚠️', tone: -1, priority: 100 },
  reduce: { label: '减持', icon: '📉', tone: -1, priority: 90 },
  buyback: { label: '回购', icon: '🔄', tone: 1, priority: 85 },
  contract: { label: '中标合同', icon: '🤝', tone: 1, priority: 80 },
  approval: { label: '获批注册', icon: '✅', tone: 1, priority: 75 },
  ma: { label: '重组并购', icon: '🧩', tone: 1, priority: 70 },
  earnings: { label: '业绩', icon: '📊', tone: 0, priority: 65 },
  lawsuit: { label: '诉讼冻结', icon: '⚖️', tone: -1, priority: 60 },
  unlock: { label: '解禁', icon: '🔓', tone: -1, priority: 55 },
  increase: { label: '增持', icon: '📈', tone: 1, priority: 50 },
  dividend: { label: '分红', icon: '💵', tone: 1, priority: 45 },
  pledge: { label: '质押', icon: '🔒', tone: -1, priority: 40 },
  placement: { label: '定增融资', icon: '🏦', tone: 0, priority: 35 },
  incentive: { label: '股权激励', icon: '🎯', tone: 1, priority: 30 },
  subsidy: { label: '政府补助', icon: '🎁', tone: 1, priority: 25 },
  meeting: { label: '说明会调研', icon: '📅', tone: 0, priority: 8 },
  insider: { label: '内部人交易', icon: '👔', tone: 0, priority: 46 },
  stake: { label: '大额持股', icon: '🏛️', tone: 0, priority: 52 },
  material: { label: '重大事件', icon: '📢', tone: 0, priority: 58 },
  suspend: { label: '停复牌', icon: '⏸️', tone: 0, priority: 20 },
  exec: { label: '人事变动', icon: '👤', tone: 0, priority: 10 },
  other: { label: '其他', icon: '📄', tone: 0, priority: 0 }
};

/** 关键词表：顺序即匹配顺序，命中即记标签（一条最多留 2 个） */
const RULES: { tag: AnnTag; re: RegExp }[] = [
  {
    tag: 'risk',
    re: /立案|行政处罚|处罚决定|警示函|监管函|纪律处分|问询函|关注函|责令改正|退市风险|终止上市|财务造假|违规占用|冻结.*股份|被实施.*风险警示/
  },
  {
    tag: 'reduce',
    re: /减持|减持股|计划减持|减持计划|清仓式|集中竞价减持|大宗交易减持/
  },
  {
    tag: 'buyback',
    re: /回购|购回|回购股份|回购注销|回购方案|回购进展/
  },
  {
    tag: 'contract',
    re: /中标|中选|成交结果|签订.*合同|签署.*合同|重大合同|框架协议|战略合作|订单|供货协议/
  },
  {
    tag: 'approval',
    re: /获批|批准|注册证|注册申请|临床批件|上市许可|一致性评价|通过.*审批|核准|备案通过/
  },
  {
    tag: 'ma',
    re: /重组|并购|收购|重大资产|资产置换|吸收合并|控制权.*变更|要约收购/
  },
  {
    tag: 'earnings',
    re: /业绩|业绩预告|业绩快报|预增|预减|扭亏|净利|净利润|营收|营业收入|年报|年度报告|半年报|半年度报告|季报|季度报告|主要经营数据|经营情况/
  },
  {
    tag: 'lawsuit',
    re: /诉讼|仲裁|司法冻结|查封|被执行|破产重整|债权申报/
  },
  {
    tag: 'unlock',
    re: /解除限售|限售股.*上市流通|解禁|限售股份上市/
  },
  {
    tag: 'increase',
    re: /增持|增持计划|股东增持|拟增持|董监高增持/
  },
  {
    tag: 'dividend',
    re: /分红|派息|利润分配|送转|权益分派|现金红利/
  },
  {
    tag: 'pledge',
    re: /质押|解除质押|质押延期/
  },
  {
    tag: 'placement',
    re: /非公开发行|定增|向特定对象发行|可转债|可转换公司债|配股|供股|募集资金|发行股份/
  },
  {
    tag: 'incentive',
    re: /股权激励|限制性股票|员工持股|期权激励|激励计划/
  },
  {
    tag: 'subsidy',
    re: /政府补助|财政补贴|补助资金|税收返还/
  },
  {
    tag: 'suspend',
    re: /停牌|复牌|暂停上市|恢复上市/
  },
  {
    tag: 'exec',
    re: /辞职|离任|聘任|换届|选举.*董事|董事长|总经理|财务总监|董事会秘书/
  }
];

/**
 * 繁体 → 简体（只覆盖标签相关的字）。
 *
 * 港股公告是繁体（「回購」「減持」「中期業績」），直接用简体词表会全部漏判。
 * 与其维护两套正则，不如先归一成简体——改动小、可测、不会漏。
 */
const T2S: Record<string, string> = {
  購: '购', 減: '减', 業: '业', 績: '绩', 獲: '获', 註: '注', 證: '证', 訴: '诉',
  訟: '讼', 質: '质', 權: '权', 勵: '励', 紅: '红', 買: '买', 賣: '卖', 約: '约',
  團: '团', 產: '产', 資: '资', 債: '债', 營: '营', 報: '报', 淨: '净', 潤: '润',
  虧: '亏', 損: '损', 擴: '扩', 銷: '销', 單: '单', 訂: '订', 簽: '签', 監: '监',
  罰: '罚', 詢: '询', 凍: '冻', 結: '结', 暫: '暂', 復: '复', 辭: '辞', 職: '职',
  財: '财', 總: '总', 經: '经', 銀: '银', 藥: '药', 醫: '医', 疗: '疗', 審: '审',
  準: '准', 許: '许', 轉: '转', 換: '换', 發: '发', 東: '东', 會: '会', 議: '议',
  說: '说', 調: '调', 關: '关', 聯: '联', 運: '运', 數: '数', 網: '网', 絡: '络',
  電: '电', 訊: '讯', 軟: '软', 體: '体', 幣: '币', 價: '价', 額: '额', 億: '亿',
  萬: '万', 个: '个', 點: '点', 線: '线', 級: '级', 類: '类', 別: '别', 機: '机',
  構: '构', 組: '组', 餘: '余', 稅: '税', 费: '费', 繳: '缴', 貸: '贷', 還: '还',
  週: '周', 歷: '历', 檔: '档', 讓: '让', 屬: '属', 攤: '摊', 興: '兴', 舉: '举',
  殼: '壳', 內: '内', 幕: '幕', 療: '疗', 個: '个', 費: '费', 願: '愿',
  潛: '潜', 貨: '货', 擬: '拟', 冊: '册',
};

/** 繁体标题归一成简体，供标签正则使用 */
export function toSimplified(text: string): string {
  return String(text ?? '').replace(/[\u4e00-\u9fff]/g, (ch) => T2S[ch] ?? ch);
}

/* ============ 美股：SEC form 映射 ============ */

/** SEC form → 中文说明（列表里光显示「144」「8-K」用户看不懂） */
const US_FORM_LABEL: Record<string, string> = {
  '8-K': '重大事项',
  '10-Q': '季报',
  '10-K': '年报',
  '20-F': '年报（外国发行人）',
  '40-F': '年报（加拿大发行人）',
  '6-K': '临时报告',
  '4': '内部人交易',
  '144': '拟出售证券',
  'S-1': 'IPO 注册',
  'S-3': '增发注册',
  'F-1': 'IPO 注册（外国发行人）',
  'DEF 14A': '股东大会委托书',
  'PRE 14A': '股东大会委托书',
  '25-NSE': '退市通知'
};

/** 把 form 代号翻译成中文说明；未知 form 返回空串 */
export function usFormLabel(form: string): string {
  const f = String(form ?? '').toUpperCase().trim();
  if (US_FORM_LABEL[f]) return US_FORM_LABEL[f];
  if (/^4\//.test(f)) return '内部人交易';
  if (/^SC 13D/.test(f)) return '举牌';
  if (/^SC 13G/.test(f)) return '大额持股';
  if (/^424B/.test(f)) return '增发说明书';
  if (/^(S-1|S-3|F-1)/.test(f)) return 'IPO/增发注册';
  if (/^(SC TO|SC 14D)/.test(f)) return '要约收购';
  return '';
}

/**
 * SEC 的申报**没有标题**，只有 form 类型和 items 编号。
 * 所以美股不能走中文关键词，只能按 form 枚举映射——好处是 100% 结构化，不用猜。
 */
export function classifyUs(formRaw: string, items = ''): { tags: AnnTag[]; primary: AnnTag; tone: 1 | 0 | -1; reason: string } {
  const form = String(formRaw ?? '').toUpperCase().trim();
  const it = String(items ?? '');
  const tags: AnnTag[] = [];
  const reasons: string[] = [];

  const push = (t: AnnTag, why: string) => {
    tags.push(t);
    reasons.push(why);
  };

  if (/^8-K/.test(form)) {
    // 8-K 的 items 是结构化枚举，能直接读出事件类型
    if (/(^|,)\s*2\.02(,|$)/.test(it)) push('earnings', '2.02 业绩发布');
    if (/(^|,)\s*5\.02(,|$)/.test(it)) push('exec', '5.02 高管变动');
    if (/(^|,)\s*1\.01(,|$)/.test(it)) push('contract', '1.01 重大协议');
    if (/(^|,)\s*2\.01(,|$)/.test(it)) push('ma', '2.01 完成收购');
    if (/(^|,)\s*3\.01(,|$)/.test(it)) push('risk', '3.01 退市警示');
    if (/(^|,)\s*4\.02(,|$)/.test(it)) push('risk', '4.02 财报重述');
    if (!tags.length) push('material', '8-K 重大事件');
  } else if (/^(10-K|10-Q|20-F|40-F|6-K)/.test(form)) {
    push('earnings', `${form} 财报`);
  } else if (/^4(\/A)?$/.test(form)) {
    push('insider', 'Form 4 内部人交易');
  } else if (/^144$/.test(form)) {
    push('reduce', 'Form 144 拟出售（可能未执行）');
  } else if (/^SC 13D/.test(form)) {
    push('stake', '13D 举牌');
  } else if (/^SC 13G/.test(form)) {
    push('stake', '13G 大额持股');
  } else if (/^(S-1|S-3|F-1|424B)/.test(form)) {
    push('placement', `${form} 增发注册`);
  } else if (/^(DEF 14A|PRE 14A)/.test(form)) {
    push('meeting', '股东大会');
  } else if (/^25-NSE/.test(form)) {
    push('risk', '25-NSE 退市通知');
  } else if (/^(SC TO|SC 14D)/.test(form)) {
    push('ma', '要约收购');
  } else {
    push('other', form || '未分类');
  }

  const top = tags.slice(0, 2);
  const primary = top.reduce((a, b) => (ANN_TAG_META[b].priority > ANN_TAG_META[a].priority ? b : a));

  // Form 4 只说明「有内部人交易」，买还是卖要看 XML 里的 transactionCode，一期一律记中性
  let tone: 1 | 0 | -1 = ANN_TAG_META[primary].tone;
  if (primary === 'insider' || primary === 'stake' || primary === 'material') tone = 0;
  if (primary === 'placement') tone = -1;
  // Form 144 只是「拟出售」申报，未必真的卖，不能当已发生的利空
  if (/^144$/.test(form)) tone = 0;

  return { tags: top, primary, tone, reason: reasons.join(' · ') || form };
}

/**
 * 例行披露：港股每天一份的「翌日披露报表」「月报表」。
 *
 * 腾讯天天回购，于是 40 条公告里 32 条是「翌日披露报表」——
 * 它们确实是回购记录，但属于每日例行披露，按「32 次回购」计数会严重失真。
 * 这类只保留在列表里，不参与多空与公司行为统计。
 */
const ROUTINE_RE = /翌日披露报表|翌日披露報告|月报表|股份发行人的证券变动月报|证券变动月报/;

/** 会议通知：最具体的一类，命中即独占，不再让「业绩」把它抢走 */
const MEETING_RE = /业绩说明会|说明会|投资者关系|路演|机构调研|调研活动|新闻发布会|股东大会通知|董事会会议召开|董事会会议日期/;

/* ============ 日股：TDnet 適時開示 ============ */

/**
 * 日股用 TDnet 的開示标题（日文），关键词直配。
 * 日本公司披露用词非常固定（「決算短信」「自己株式の取得」「公開買付」），
 * 比中文公告还规整，词表覆盖率高。
 */
const JP_RULES: { tag: AnnTag; re: RegExp }[] = [
  { tag: 'buyback', re: /自己株式(の)?取得|自己株式の消却|自社株買い|Repurchase of (its )?(Own )?Shares|Share Buyback/i },
  { tag: 'earnings', re: /決算短信|決算報告|業績予想|通期業績|四半期決算|中間決算|Financial Results|Earnings Forecast|Consolidated Financial Statements/i },
  { tag: 'dividend', re: /配当|増配|減配|株主還元|Dividend/i },
  { tag: 'ma', re: /公開買付|TOB|株式交換|株式移転|合併契約|事業譲渡|子会社化|Tender Offer|Business Integration|Merger/i },
  { tag: 'placement', re: /第三者割当|公募増資|新株発行|新株予約権/ },
  { tag: 'stake', re: /大量保有報告書|大量保有報告/ },
  { tag: 'risk', re: /課徴金|業務改善命令|報告徴求|上場廃止|監理銘柄|特設注意市場銘柄/ },
  { tag: 'lawsuit', re: /民事再生|会社更生|特別清算|破産/ },
  { tag: 'exec', re: /代表取締役|取締役の異動|執行役員|人事異動/ },
  { tag: 'meeting', re: /株主総会|説明会|決算説明会/ },
  { tag: 'contract', re: /受注|契約締結|業務提携|資本業務提携|Receipt of Order|Business Alliance/i },
  { tag: 'suspend', re: /一時停止|売買停止|整理銘柄/ }
];

/** 日文业绩方向词 */
const JP_UP_RE = /上方修正|増益|黒字転換|過去最高|増収/;
const JP_DOWN_RE = /下方修正|減益|赤字|減収|損失/;

export function classifyJp(title: string, column = ''): { tags: AnnTag[]; primary: AnnTag; tone: 1 | 0 | -1; reason: string } {
  const t = `${String(title ?? '')} ${String(column ?? '')}`;
  const hits: AnnTag[] = [];
  const reasons: string[] = [];
  for (const r of JP_RULES) {
    const m = r.re.exec(t);
    if (m) {
      hits.push(r.tag);
      reasons.push(m[0]);
      if (hits.length >= 2) break;
    }
  }
  if (!hits.length) return { tags: ['other'], primary: 'other', tone: 0, reason: '未命中日文标签词' };

  const primary = hits.reduce((a, b) => (ANN_TAG_META[b].priority > ANN_TAG_META[a].priority ? b : a));
  let tone: 1 | 0 | -1 = ANN_TAG_META[primary].tone;
  if (primary === 'earnings') {
    if (JP_DOWN_RE.test(t) && !JP_UP_RE.test(t)) tone = -1;
    else if (JP_UP_RE.test(t)) tone = 1;
    else tone = 0;
  }
  if (primary === 'placement') tone = -1;
  return { tags: hits.slice(0, 2), primary, tone, reason: reasons.join(' · ') };
}

/* ============ 韩股：Naver 新闻 ============ */

/**
 * 韩股只有新闻，没有免费公告源（DART 要 key），
 * 所以这里的关键词是「媒体措辞」而不是「披露措辞」，准确率天然低一档，
 * 结论里必须标明来源性质，方向只做提示。
 */
const KR_RULES: { tag: AnnTag; re: RegExp }[] = [
  { tag: 'buyback', re: /자사주\s*매입|자기주식\s*취득|자사주\s*취득|자사주\s*소각/ },
  { tag: 'placement', re: /유상증자|제3자\s*배정|전환사채|신주인수권|유상감자/ },
  { tag: 'dividend', re: /무상증자|배당|현금배당|주당배당/ },
  { tag: 'earnings', re: /실적|잠정실적|영업이익|당기순이익|매출/ },
  { tag: 'ma', re: /최대주주\s*변경|경영권|인수|합병|M&A/ },
  { tag: 'risk', re: /불성실공시|과징금|제재|상장폐지|관리종목|감사의견\s*거절/ },
  { tag: 'exec', re: /대표이사|임원\s*인사|사장\s*선임/ },
  { tag: 'lawsuit', re: /소송|법정관리|채권자/ },
  { tag: 'contract', re: /수주|공급계약|계약\s*체결/ }
];

/** 韩文业绩方向词 */
const KR_UP_RE = /흑자|증가|호조|최대\s*실적|상향/;
const KR_DOWN_RE = /적자|감소|부진|하향|악화/;

export function classifyKr(title: string, column = ''): { tags: AnnTag[]; primary: AnnTag; tone: 1 | 0 | -1; reason: string } {
  const t = `${String(title ?? '')} ${String(column ?? '')}`;
  const hits: AnnTag[] = [];
  const reasons: string[] = [];
  for (const r of KR_RULES) {
    const m = r.re.exec(t);
    if (m) {
      hits.push(r.tag);
      reasons.push(m[0]);
      if (hits.length >= 2) break;
    }
  }
  if (!hits.length) return { tags: ['other'], primary: 'other', tone: 0, reason: '未命中韩文标签词' };

  const primary = hits.reduce((a, b) => (ANN_TAG_META[b].priority > ANN_TAG_META[a].priority ? b : a));
  let tone: 1 | 0 | -1 = ANN_TAG_META[primary].tone;
  if (primary === 'earnings') {
    if (KR_DOWN_RE.test(t) && !KR_UP_RE.test(t)) tone = -1;
    else if (KR_UP_RE.test(t)) tone = 1;
    else tone = 0;
  }
  if (primary === 'placement') tone = -1;
  return { tags: hits.slice(0, 2), primary, tone, reason: reasons.join(' · ') };
}

/** 业绩方向词：预增/扭亏偏多，预减/亏损偏空 */
const EARN_UP_RE = /预增|扭亏|增长|上升|超预期|盈利|创.*新高|同比增加/;
const EARN_DOWN_RE = /预减|亏损|下滑|下降|减少|转亏|不及预期|同比减少/;

/** 金额与比例：用于排序，不改变方向 */
const AMOUNT_RE = /(\d+(?:\.\d+)?)\s*(万亿|亿|千万|万)\s*元?/g;
const PCT_RE = /(\d+(?:\.\d+)?)\s*%/g;

/**
 * 「动作 + 比例」才算数：「拟减持不超过 3%」是减持比例，
 * 而「持股 5% 以上股东减持」里的 5% 是股东持股比例，不是本次动作的规模。
 */
const ACTION_PCT_RE = /(减持|增持|解除限售|解禁|回购|质押)[^。；;，,]{0,24}?(\d+(?:\.\d+)?)\s*%/;

export function maxAmountYi(text: string): number {
  const t = String(text ?? '');
  let best = 0;
  AMOUNT_RE.lastIndex = 0;
  for (;;) {
    const m = AMOUNT_RE.exec(t);
    if (!m) break;
    const v = Number(m[1]);
    if (!Number.isFinite(v)) continue;
    const yi = m[2] === '万亿' ? v * 10000 : m[2] === '亿' ? v : m[2] === '千万' ? v / 10 : v / 10000;
    if (yi > best) best = yi;
  }
  return best;
}

export function maxPct(text: string): number {
  const t = String(text ?? '');
  let best = 0;
  PCT_RE.lastIndex = 0;
  for (;;) {
    const m = PCT_RE.exec(t);
    if (!m) break;
    const v = Number(m[1]);
    if (Number.isFinite(v) && v > best) best = v;
  }
  return best;
}

/* ============ 单条打标 ============ */

export interface AnnInput {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  /** 东财公告分类 / SEC items / TDnet 分类 */
  column?: string;
  url?: string;
  /** 市场：决定用哪套标签规则（默认 A 股） */
  market?: AnnMarket;
  /** 原始类型：SEC form（8-K / 4 / 10-Q），展示用 */
  kind?: string;
}

export interface AnnItem extends AnnInput {
  /** 去掉「公司名:」前缀后的标题 */
  clean: string;
  tags: AnnTag[];
  /** 主标签（优先级最高），用于列表徽章与筛选 */
  primary: AnnTag;
  tone: 1 | 0 | -1;
  /** 0~100 重要性 */
  score: number;
  /** 命中说明，可解释 */
  reason: string;
  /** 例行披露（港股「翌日披露报表」「月报表」等），不计入公司行为统计 */
  routine: boolean;
}

/** 去掉公告标题里的「公司名:」与紧随其后的重复公司名 */
export function cleanAnnTitle(title: string, name?: string): string {
  let t = String(title ?? '').trim();
  t = t.replace(/^[^:：]{2,14}[:：]\s*/, '');
  if (name && t.startsWith(name)) {
    t = t.slice(name.length).replace(/^[:：、\s]+/, '');
  }
  return t.trim() || String(title ?? '').trim();
}

/** 给一条公告打标签、定方向 */
export function classifyAnn(
  title: string,
  column?: string,
  market: AnnMarket = 'CN'
): { tags: AnnTag[]; primary: AnnTag; tone: 1 | 0 | -1; reason: string } {
  // 美股没有标题，只有 form 类型 → 走枚举映射，不碰中文词表
  if (market === 'US') return classifyUs(title, column);
  if (market === 'JP') return classifyJp(title, column);
  if (market === 'KR') return classifyKr(title, column);

  // 港股公告是繁体，先归一成简体再走同一套规则
  const raw = `${String(title ?? '')} ${String(column ?? '')}`;
  const t = market === 'HK' ? toSimplified(raw) : raw;
  const hits: AnnTag[] = [];
  const reasons: string[] = [];

  // 「关于召开第三季度业绩说明会的公告」本质是会议通知，不是业绩本身
  if (MEETING_RE.test(t)) {
    return { tags: ['meeting'], primary: 'meeting', tone: 0, reason: '会议/调研通知' };
  }

  for (const r of RULES) {
    if (r.re.test(t)) {
      hits.push(r.tag);
      const m = r.re.exec(t);
      if (m) reasons.push(m[0].slice(0, 8));
      if (hits.length >= 2) break;
    }
  }

  if (!hits.length) return { tags: ['other'], primary: 'other', tone: 0, reason: '未命中标签词' };

  // 主标签取优先级最高的
  const primary = hits.reduce((a, b) => (ANN_TAG_META[b].priority > ANN_TAG_META[a].priority ? b : a));

  let tone = ANN_TAG_META[primary].tone;
  // 业绩类按措辞定方向：预增/扭亏 → 多，预减/亏损 → 空
  if (primary === 'earnings') {
    if (EARN_DOWN_RE.test(t) && !EARN_UP_RE.test(t)) tone = -1;
    else if (EARN_UP_RE.test(t)) tone = 1;
    else tone = 0;
  }
  // 回购+减持同时出现时，减持是更强信号（优先级已保证 primary=reduce），这里兜底
  if (primary === 'buyback' && /减持/.test(t)) tone = -1;

  return { tags: hits, primary, tone, reason: reasons.join(' · ') || '关键词命中' };
}

/**
 * 重要性：标签权重 + 时效 + 金额/比例。
 * 时效用「距今天数」而不是绝对日期，保证任何时候打开都合理。
 */
export function scoreAnn(item: AnnInput, tags: AnnTag[], now = Date.now()): number {
  let s = 40 + Math.min(40, ANN_TAG_META[tags[0] ?? 'other'].priority * 0.4);

  const days = daysBetween(item.date, now);
  if (days <= 3) s += 15;
  else if (days <= 7) s += 8;
  else if (days <= 30) s += 3;
  else if (days > 120) s -= 8;

  const yi = maxAmountYi(item.title);
  if (yi >= 10) s += 10;
  else if (yi >= 1) s += 5;

  const act = ACTION_PCT_RE.exec(String(item.title ?? ''));
  const pct = act ? Number(act[2]) : 0;
  if (pct >= 5) s += 8;
  else if (pct >= 2) s += 4;

  return Math.max(0, Math.min(100, Math.round(s)));
}

function daysBetween(date: string, now: number): number {
  const d = new Date(`${String(date).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return 999;
  return Math.max(0, Math.round((now - d.getTime()) / 86400000));
}

/** 单条公告 → 打标后的条目 */
export function toAnnItem(raw: AnnInput, name?: string, now = Date.now()): AnnItem {
  const market = raw.market ?? 'CN';
  // 美股的 title 是「8-K 重大事项」这类展示文本，分类必须用原始 form（kind）
  const forClassify = market === 'US' ? raw.kind ?? raw.title : raw.title;
  const c = classifyAnn(forClassify, raw.column, market);
  // 港股公告是繁体，例行判断前先归一
  const norm = market === 'HK' ? toSimplified(`${raw.title} ${raw.column ?? ''}`) : `${raw.title} ${raw.column ?? ''}`;
  const routine = ROUTINE_RE.test(norm);
  return {
    ...raw,
    clean: cleanAnnTitle(raw.title, name),
    tags: c.tags,
    primary: c.primary,
    // 例行披露不表达方向，避免「32 条回购」把多空比拉满
    tone: routine ? 0 : c.tone,
    score: routine ? Math.max(0, scoreAnn(raw, c.tags, now) - 25) : scoreAnn(raw, c.tags, now),
    reason: routine ? '例行披露' : c.reason,
    routine
  };
}

/* ============ 聚合 ============ */

export interface AnnAnalysis {
  items: AnnItem[];
  /** 各标签条数（只保留命中的） */
  counts: { tag: AnnTag; count: number }[];
  bull: number;
  bear: number;
  neutral: number;
  /** 近 90 天回购 / 减持 / 增持 次数，用于「公司行为画像」 */
  behavior: { buyback: number; reduce: number; increase: number; risk: number; contract: number };
  /** 例行披露条数（港股翌日披露报表等） */
  routineCount: number;
  /** 例行披露中属于股份购回的条数（说明公司在持续回购） */
  routineBuyback: number;
  /** 最值得看的一条 */
  top: AnnItem | null;
  /** 自动结论 */
  lines: string[];
}

/** 聚合公告：排序、统计标签、生成结论 */
export function analyzeAnnouncements(list: AnnInput[], name?: string, now = Date.now()): AnnAnalysis {
  const items = (list ?? []).map((r) => toAnnItem(r, name, now));

  // 例行披露沉底；其余按重要性降序，同日按日期新→旧
  items.sort(
    (a, b) =>
      (a.routine === b.routine ? 0 : a.routine ? 1 : -1) ||
      b.score - a.score ||
      String(b.date).localeCompare(String(a.date))
  );

  const map = new Map<AnnTag, number>();
  let bull = 0;
  let bear = 0;
  let neutral = 0;

  for (const it of items) {
    if (!it.routine) map.set(it.primary, (map.get(it.primary) ?? 0) + 1);
    if (it.tone === 1) bull += 1;
    else if (it.tone === -1) bear += 1;
    else neutral += 1;
  }

  const counts = [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    // 「其他」永远排最后：它是兜底桶，不该排在减持、回购前面
    .sort((a, b) => {
      if (a.tag === 'other') return 1;
      if (b.tag === 'other') return -1;
      return b.count - a.count || ANN_TAG_META[b.tag].priority - ANN_TAG_META[a.tag].priority;
    });

  const real = items.filter((i) => !i.routine);
  const behavior = {
    buyback: real.filter((i) => i.tags.includes('buyback')).length,
    // 只算已发生的减持；Form 144 是「拟出售」，单独统计
    reduce: real.filter((i) => i.tags.includes('reduce') && i.tone === -1).length,
    increase: real.filter((i) => i.tags.includes('increase')).length,
    risk: real.filter((i) => i.tags.includes('risk')).length,
    contract: real.filter((i) => i.tags.includes('contract')).length
  };

  const top = real.length ? real[0] : items[0] ?? null;
  const routineCount = items.filter((i) => i.routine).length;
  // 例行披露里也可能藏着「持续回购」这个关键信息，不能一刀切丢掉
  const routineBuyback = items.filter((i) => i.routine && i.tags.includes('buyback')).length;

  /* ---------- 自动结论 ---------- */
  const lines: string[] = [];
  if (items.length) {
    const dir = bull + bear;
    const tail =
      dir === 0
        ? '没有方向明确的消息，中性申报占绝大多数。'
        : dir <= 3 || dir / items.length < 0.25
          ? `方向明确的只有 ${dir} 条（${bull > bear ? '偏多' : bear > bull ? '偏空' : '多空各半'}），其余 ${neutral} 条无明确方向。`
          : bear > bull * 1.5
            ? '利空明显占优，注意减持、立案这类硬信号。'
            : bull > bear * 1.5
              ? '利好占优，回购、中标、获批这类动作偏正面。'
              : '多空混杂，公告层面没有一致方向。';
    lines.push(`近 ${items.length} 条公告：利好 ${bull} 条、利空 ${bear} 条、中性 ${neutral} 条——${tail}`);
  }

  const acts: string[] = [];
  if (behavior.buyback) acts.push(`回购 ${behavior.buyback} 次`);
  if (behavior.increase) acts.push(`增持 ${behavior.increase} 次`);
  if (behavior.reduce) acts.push(`减持 ${behavior.reduce} 次`);
  if (behavior.contract) acts.push(`中标/合同 ${behavior.contract} 次`);
  if (behavior.risk) acts.push(`立案/处罚 ${behavior.risk} 次`);
  if (acts.length) lines.push(`公司行为：${acts.join('、')}。`);

  if (behavior.reduce > 0 && behavior.buyback === 0 && behavior.increase === 0) {
    lines.push('只有减持、没有回购或增持——产业资本在往外走，这类信号通常领先于业绩变脸。');
  } else if (behavior.buyback > 0 && behavior.reduce === 0) {
    lines.push('有回购、无减持，公司自己在买，通常出现在低估或护盘阶段。');
  }

  const intendSell = items.filter((i) => !i.routine && /拟出售/.test(i.reason)).length;
  if (intendSell) {
    lines.push(`另有 ${intendSell} 笔 Form 144 拟出售申报，属于计划性减持，未必全部执行。`);
  }

  if (routineCount >= 3) {
    lines.push(
      `另有 ${routineCount} 条例行披露（翌日披露报表 / 月报表），已从统计中剔除` +
        (routineBuyback >= 3
          ? `；其中 ${routineBuyback} 条为股份购回记录，说明公司在持续回购。`
          : '。')
    );
  }

  if (top) lines.push(`最值得看的一条：「${top.clean.slice(0, 34)}${top.clean.length > 34 ? '…' : ''}」（${ANN_TAG_META[top.primary].label}，重要性 ${top.score}）。`);

  return { items, counts, bull, bear, neutral, routineCount, routineBuyback, behavior, top, lines };
}
