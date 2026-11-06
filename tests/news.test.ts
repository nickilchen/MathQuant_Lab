import { describe, expect, it } from 'vitest';
import {
  analyzeNews,
  classifyNewsTopic,
  filterNews,
  isDigest,
  maxAmountYi,
  scoreNews,
  splitFlash,
  type NewsLike
} from '../src/math/news';

const n = (text: string, extra: Partial<NewsLike> = {}): NewsLike => ({
  id: String(Math.random()),
  text,
  level: 'C',
  read: 0,
  time: '09:30',
  subjects: [],
  ...extra
});

describe('splitFlash / isDigest', () => {
  it('拆出【标题】与正文', () => {
    const r = splitFlash('【央行：下调存款准备金率 0.5 个百分点】财联社11月3日电，为…');
    expect(r.title).toBe('央行：下调存款准备金率 0.5 个百分点');
    expect(r.body).toContain('财联社11月3日电');
  });

  it('无标题时整条当正文', () => {
    expect(splitFlash('某公司发布公告')).toEqual({ title: '', body: '某公司发布公告' });
  });

  it('标题含摘要词即判合集', () => {
    expect(isDigest('【投资日历：周二资本市场大事提醒】①今日共有1只新股上市')).toBe(true);
    expect(isDigest('【财联社11月3日早间新闻精选】1、央行…')).toBe(true);
    expect(isDigest('【某公司：中标 35 亿元储能项目】')).toBe(false);
  });

  it('正文出现 3 个以上编号条目也判合集', () => {
    const t = '【盘前】1、央行降准；2、美股收涨；3、某公司中标 3 亿；4、油价上涨';
    expect(isDigest(t)).toBe(true);
  });
});

describe('合集与例行不冒充重点', () => {
  it('投资日历即使堆满政策词与金额也不能是 S 级', () => {
    const s = scoreNews(
      n('【投资日历：周二资本市场大事提醒】①今日共有1只新股上市。②国家发展改革委11月3日召开新闻发布会。③2026世界互联网大会将于11月6日举办。北向资金全年成交 4120 亿元。', {
        level: 'A',
        read: 120000,
        subjects: ['新股', '互联网']
      })
    );
    expect(s.digest).toBe(true);
    expect(s.tier).not.toBe('S');
    expect(s.tone).toBe(0);
    // 金额不该给「日历」加分
    expect(s.reasons.join('')).not.toContain('亿体量');
  });

  it('早间新闻精选按合集打折且不打多空', () => {
    const s = scoreNews(n('【财联社11月3日早间新闻精选】1、央行召开座谈会提出支持资本市场。2、证监会部署改革。3、某公司获批新产品。', { level: 'A' }));
    expect(s.digest).toBe(true);
    expect(s.tone).toBe(0);
    expect(s.impact).toBeLessThan(72);
  });

  it('焦点区不收合集与例行播报', () => {
    const r = analyzeNews([
      n('【投资日历：周二资本市场大事提醒】今日共有1只新股上市，国家发展改革委召开新闻发布会', { level: 'A', read: 120000 }),
      n('【财联社11月3日早间新闻精选】1、央行…2、证监会…3、发改委…', { level: 'A', read: 120000 }),
      n('两市今日共有 3200 只个股上涨，沪指收涨 0.8%', { level: 'A', read: 120000 }),
      n('某公司中标 35 亿元储能项目', { level: 'B' })
    ]);
    expect(r.focus.length).toBeGreaterThan(0);
    for (const f of r.focus) {
      expect(f.digest).toBe(false);
      expect(f.routine).toBe(false);
    }
    expect(r.digestCount).toBeGreaterThanOrEqual(2);
  });
});

describe('政策方向兜底', () => {
  it('降准（句子里没有情绪词）判强利好', () => {
    const s = scoreNews(n('央行宣布下调金融机构存款准备金率 0.5 个百分点，释放长期资金约 1 万亿元'));
    expect(s.tone).toBe(1);
    expect(s.strength).toBe(2);
    expect(s.reasons).toContain('政策宽松');
  });

  it('上调外汇存款准备金率判强利空（收紧）', () => {
    const s = scoreNews(n('【央行：11月15日起上调金融机构外汇存款准备金率2个百分点】财联社11月3日电', { level: 'A' }));
    expect(s.tone).toBe(-1);
    expect(s.strength).toBe(2);
    expect(s.reasons).toContain('政策收紧');
  });
});

describe('maxAmountYi', () => {
  it('识别亿 / 万亿 / 万并取最大值', () => {
    expect(maxAmountYi('中标 3.2 亿元项目')).toBeCloseTo(3.2);
    expect(maxAmountYi('投资 1.5 万亿')).toBeCloseTo(15000);
    expect(maxAmountYi('合同 8000 万元')).toBeCloseTo(0.8);
    expect(maxAmountYi('中标 300 万元')).toBeCloseTo(0.03);
  });

  it('多个金额取最大', () => {
    expect(maxAmountYi('一期 2 亿元，二期 15 亿元')).toBeCloseTo(15);
  });

  it('没有金额返回 0', () => {
    expect(maxAmountYi('公司发布公告')).toBe(0);
  });
});

describe('classifyNewsTopic', () => {
  it('政策优先于宏观（关税同时命中两者）', () => {
    expect(classifyNewsTopic('国务院关税税则委员会发布公告')).toBe('policy');
  });
  it('公司事件 / 业绩 / 行业 / 海外各归其位', () => {
    expect(classifyNewsTopic('某股份：股东拟减持不超过 2%')).toBe('event');
    expect(classifyNewsTopic('某股份前三季度净利润同比增长 35%')).toBe('earnings');
    expect(classifyNewsTopic('多家水泥企业发布涨价函')).toBe('industry');
    expect(classifyNewsTopic('美联储宣布维持利率不变')).toBe('macro');
  });
});

describe('scoreNews 分级', () => {
  it('政策级 + 大额 = S 级', () => {
    const s = scoreNews(n('央行宣布降准 0.5 个百分点，释放长期资金约 1 万亿元', { level: 'A' }));
    expect(s.impact).toBeGreaterThanOrEqual(72);
    expect(s.tier).toBe('S');
    expect(s.reasons).toContain('政策级');
  });

  it('普通公司中标小额只有 B/C，不会冒充重点', () => {
    const s = scoreNews(n('某公司中标 300 万元项目'));
    expect(s.tier).toBe('C');
    expect(s.impact).toBeLessThan(32);
  });

  it('大额中标可到 A 级', () => {
    const s = scoreNews(n('某公司中标 35 亿元储能项目', { level: 'B' }));
    expect(s.tier).toBe('A');
  });

  it('例行播报压到 C 档并标记 routine', () => {
    const s = scoreNews(n('两市今日共有 3200 只个股上涨，沪指收涨 0.8%', { level: 'A', read: 120000 }));
    expect(s.routine).toBe(true);
    expect(s.tier).toBe('C');
    expect(s.impact).toBeLessThanOrEqual(18);
  });

  it('表态型措辞降权，不因「看好」变成重点', () => {
    const soft = scoreNews(n('机构看好该板块后市表现'));
    const hard = scoreNews(n('公司获批新建 20 万吨产能'));
    expect(soft.impact).toBeLessThan(hard.impact);
    expect(soft.reasons).toContain('表态型');
  });

  it('阅读量与覆盖板块参与加分', () => {
    const a = scoreNews(n('某行业动态', { read: 120000, subjects: ['半导体', 'AI'] }));
    const b = scoreNews(n('某行业动态'));
    expect(a.impact).toBeGreaterThan(b.impact);
  });
});

describe('scoreNews 多空', () => {
  it('快讯是公告体，仍能判出利空（不套论坛的陈述型过滤）', () => {
    const s = scoreNews(n('某股份公告：控股股东拟减持不超过 3% 股份'));
    expect(s.tone).toBe(-1);
    expect(s.strength).toBeGreaterThanOrEqual(1);
  });

  it('强措辞强度为 2', () => {
    const s = scoreNews(n('某公司中标 12 亿元大单，股价涨停'));
    expect(s.tone).toBe(1);
    expect(s.strength).toBe(2);
  });

  it('无倾向消息记中性且强度 0', () => {
    const s = scoreNews(n('国家统计局公布 10 月制造业 PMI 数据'));
    expect(s.strength).toBe(0);
  });
});

describe('analyzeNews 聚合', () => {
  const list: NewsLike[] = [
    n('央行宣布降准 0.5 个百分点，释放长期资金约 1 万亿元', { level: 'A', time: '09:00', id: 'a' }),
    n('某公司中标 300 万元项目', { level: 'C', time: '09:10', id: 'b' }),
    n('某股份公告：控股股东拟减持不超过 3% 股份', { level: 'C', time: '09:20', id: 'c' }),
    n('两市今日共有 3200 只个股上涨，沪指收涨 0.8%', { level: 'A', time: '15:00', id: 'd' }),
    n('某公司中标 35 亿元储能项目', { level: 'B', time: '10:00', id: 'e' })
  ];

  it('按影响力降序排列，S 级排第一', () => {
    const r = analyzeNews(list);
    expect(r.items[0].tier).toBe('S');
    expect(r.items[0].id).toBe('a');
    expect(r.total).toBe(5);
  });

  it('档位计数与例行播报计数正确', () => {
    const r = analyzeNews(list);
    expect(r.tierCount.S).toBe(1);
    expect(r.routineCount).toBe(1);
    expect(r.tierCount.S + r.tierCount.A + r.tierCount.B + r.tierCount.C).toBe(5);
  });

  it('焦点只收 S/A 级，且不超过上限', () => {
    const r = analyzeNews(list, 3);
    expect(r.focus.length).toBeGreaterThan(0);
    expect(r.focus.length).toBeLessThanOrEqual(3);
    for (const f of r.focus) expect(['S', 'A']).toContain(f.tier);
  });

  it('没有 S/A 时焦点退化为影响力 TOP5', () => {
    const r = analyzeNews([n('某公司发布日常经营公告'), n('某协会召开例行会议')]);
    expect(r.tierCount.S + r.tierCount.A).toBe(0);
    expect(r.focus.length).toBeGreaterThan(0);
  });

  it('加权多空比与条数比可分离：一条重磅利好压过若干小利空', () => {
    const r = analyzeNews([
      n('央行降准 0.5 个百分点，释放 1 万亿元', { level: 'A' }),
      n('A 公司公告拟减持 1%'),
      n('B 公司公告拟减持 2%'),
      n('C 公司公告拟减持 1.5%')
    ]);
    expect(r.ratio).not.toBeNull();
    expect(r.weightedRatio).not.toBeNull();
    // 条数是 1 多 3 空（33%），加权后应明显高于条数比
    expect(r.weightedRatio!).toBeGreaterThan(r.ratio!);
    expect(r.gap!).toBeGreaterThan(0);
  });

  it('主题内部方向也用加权口径：一条重磅利好压过若干小利空', () => {
    // 同一主题（个股事件）内：一条大额增持 vs 三条小额减持
    const r = analyzeNews([
      n('某公司公告：控股股东拟增持 50 亿元', { level: 'B' }),
      n('A 公司公告拟减持 1%'),
      n('B 公司公告拟减持 2%'),
      n('C 公司公告拟减持 1.5%')
    ]);
    const t = r.topics.find((x) => x.topic === 'event')!;
    expect(t.weightedRatio).not.toBeNull();
    expect(t.ratio).not.toBeNull();
    expect(t.weightedRatio!).toBeGreaterThan(t.ratio!);
  });

  it('主题按影响力排序，dominant 是最重的那个', () => {
    const r = analyzeNews(list);
    expect(r.topics.length).toBeGreaterThan(0);
    expect(r.dominant).not.toBeNull();
    expect(r.dominant!.impactSum).toBeGreaterThanOrEqual(r.topics[r.topics.length - 1].impactSum);
    expect(r.topics[0].impactSum).toBeGreaterThanOrEqual(r.topics[1]?.impactSum ?? 0);
  });

  it('S/A 影响力占比在 0~1 之间，并给出结论', () => {
    const r = analyzeNews(list);
    expect(r.focusImpactShare).toBeGreaterThan(0);
    expect(r.focusImpactShare).toBeLessThanOrEqual(1);
    expect(r.lines.length).toBeGreaterThan(0);
    expect(r.lines.join('')).toContain('影响力');
  });

  it('空输入不崩', () => {
    const r = analyzeNews([]);
    expect(r.total).toBe(0);
    expect(r.ratio).toBeNull();
    expect(r.weightedRatio).toBeNull();
    expect(r.focus).toEqual([]);
    expect(r.dominant).toBeNull();
  });
});

describe('filterNews', () => {
  const r = analyzeNews([
    n('央行降准 0.5 个百分点，释放 1 万亿元', { level: 'A' }),
    n('某公司获批新建产能'),
    n('某股份公告：股东拟减持 2%'),
    n('两市今日共有 3000 只个股上涨')
  ]);

  it('focus 只留 S/A', () => {
    for (const it of filterNews(r.items, 'focus')) expect(['S', 'A']).toContain(it.tier);
  });
  it('bull / bear 按方向过滤', () => {
    for (const it of filterNews(r.items, 'bull')) expect(it.tone).toBe(1);
    for (const it of filterNews(r.items, 'bear')) expect(it.tone).toBe(-1);
  });
  it('routine 只留例行播报', () => {
    for (const it of filterNews(r.items, 'routine')) expect(it.routine).toBe(true);
  });
  it('主题过滤与方向过滤可叠加', () => {
    const rows = filterNews(r.items, 'all', 'event');
    expect(rows.length).toBeGreaterThan(0);
    for (const it of rows) expect(it.topic).toBe('event');
  });
});
