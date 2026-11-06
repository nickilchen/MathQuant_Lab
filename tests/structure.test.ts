import { describe, expect, it } from 'vitest';
import {
  RATIO_BANDS,
  classifyTopic,
  driversOf,
  extractStocks,
  levelOf,
  percentileOf,
  ratioBand,
  stockMentions,
  structureMetrics,
  summarizeStructure,
  topicStats,
  type TonePost
} from '../src/math/structure';

describe('主题分类', () => {
  it('常见句式能归到正确主题', () => {
    expect(classifyTopic('央行宣布降准 0.5 个百分点')).toBe('policy');
    expect(classifyTopic('三季报净利同比增长 120%')).toBe('earnings');
    expect(classifyTopic('北向资金今日净流入 80 亿')).toBe('capital');
    expect(classifyTopic('光伏硅料涨价，产能利用率回升')).toBe('industry');
    expect(classifyTopic('AI 算力需求爆发，CPO 概念走强')).toBe('theme');
    expect(classifyTopic('放量突破年线，回踩确认')).toBe('technical');
    expect(classifyTopic('美联储加息预期升温，美股跳水')).toBe('macro');
    expect(classifyTopic('五连板后炸板，接力资金退潮')).toBe('speculation');
    expect(classifyTopic('股东拟减持不超过 2% 股份')).toBe('event');
  });

  it('优先级：事件 > 政策 > 业绩 > 资金 …', () => {
    // 同时含「减持」（事件）与「业绩」（业绩），应归事件
    expect(classifyTopic('业绩预增但股东减持')).toBe('event');
    // 同时含「政策」与「资金」，应归政策
    expect(classifyTopic('政策放松带动资金流入')).toBe('policy');
  });

  it('无法归类的落到「闲聊无主题」', () => {
    expect(classifyTopic('今天心情不错，继续躺平')).toBe('other');
    expect(classifyTopic('')).toBe('other');
  });
});

describe('主题统计', () => {
  const posts: TonePost[] = [
    { text: '央行降准，利好银行', tone: 1 },
    { text: '政策不及预期', tone: -1 },
    { text: '北向资金大幅流入', tone: 1 },
    { text: '今天又亏了', tone: -1 },
    { text: '随便聊聊', tone: 0 }
  ];

  it('按主题聚合多空并算多空比', () => {
    const stats = topicStats(posts);
    const policy = stats.find((s) => s.topic === 'policy')!;
    expect(policy.total).toBe(2);
    expect(policy.bull).toBe(1);
    expect(policy.bear).toBe(1);
    expect(policy.ratio).toBeCloseTo(0.5, 6);

    const other = stats.find((s) => s.topic === 'other')!;
    expect(other.total).toBe(2); // 「今天又亏了」「随便聊聊」
    expect(stats.reduce((s, x) => s + x.total, 0)).toBe(posts.length);
  });

  it('没有方向样本时 ratio 为 null', () => {
    const stats = topicStats([{ text: '随便聊聊今天', tone: 0 }]);
    expect(stats[0].ratio).toBeNull();
  });

  it('按条数降序', () => {
    const stats = topicStats(posts);
    for (let i = 1; i < stats.length; i++) expect(stats[i - 1].total).toBeGreaterThanOrEqual(stats[i].total);
  });
});

describe('归因', () => {
  it('取 TOP N 并给出占比', () => {
    const stats = topicStats([
      { text: '降准了', tone: 1 },
      { text: '政策发力', tone: 1 },
      { text: '净利大增', tone: 1 },
      { text: '股东减持', tone: -1 }
    ]);
    const bull = driversOf(stats, 1, 2);
    expect(bull.length).toBeLessThanOrEqual(2);
    expect(bull[0].count).toBeGreaterThanOrEqual(bull[bull.length - 1].count);
    expect(bull.reduce((s, d) => s + d.share, 0)).toBeCloseTo(1, 6);
    const bear = driversOf(stats, -1);
    expect(bear).toHaveLength(1);
    expect(bear[0].label).toBe('个股事件');
  });
});

describe('阈值体系', () => {
  it('多空比五档边界', () => {
    expect(ratioBand(10).label).toBe('极度悲观');
    expect(ratioBand(24.9).label).toBe('极度悲观');
    expect(ratioBand(25).label).toBe('偏空');
    expect(ratioBand(50).label).toBe('多空分歧');
    expect(ratioBand(60).label).toBe('偏多');
    expect(ratioBand(80).label).toBe('极度乐观');
    expect(ratioBand(100).label).toBe('极度乐观');
    expect(RATIO_BANDS.reduce((s, b) => s + (b.max - b.min), 0)).toBe(100);
  });

  it('温度分档：冰点与异常高涨有明确边界', () => {
    expect(levelOf(5).level).toBe('ice');
    expect(levelOf(15).level).toBe('ice');
    expect(levelOf(16).level).toBe('cold');
    expect(levelOf(50).level).toBe('normal');
    expect(levelOf(65).level).toBe('warm');
    expect(levelOf(84.9).level).toBe('warm');
    expect(levelOf(85).level).toBe('fever');
    expect(levelOf(100).level).toBe('fever');
    expect(levelOf(85).band).toContain('异常高涨');
  });

  it('分位数计算', () => {
    const series = [10, 20, 30, 40, 50];
    expect(percentileOf(30, series)).toBeCloseTo(0.4, 6);
    expect(percentileOf(5, series)).toBe(0);
    expect(percentileOf(60, series)).toBe(1);
    expect(percentileOf(30, [])).toBe(0.5);
  });
});

describe('结构指标', () => {
  const topics = topicStats([
    { text: '降准了', tone: 1 },
    { text: '政策发力', tone: 1 },
    { text: '随便聊聊', tone: 0 },
    { text: '今天心情好', tone: 0 }
  ]);

  it('分歧度：多空 50/50 最高，单边最低', () => {
    const half = structureMetrics({ ratio: 0.5, volume: 100, topics, newsRatio: 0.5, forumRatio: 0.5, medianPct: 0, volumeBaseline: 100 });
    const one = structureMetrics({ ratio: 1, volume: 100, topics, newsRatio: null, forumRatio: null, medianPct: 0, volumeBaseline: 100 });
    expect(half.divergence).toBe(100);
    expect(half.consensus).toBe(0);
    expect(one.divergence).toBe(0);
    expect(one.consensus).toBe(100);
  });

  it('消息面背离：正值表示消息比讨论乐观', () => {
    const m = structureMetrics({ ratio: 0.5, volume: 100, topics, newsRatio: 0.7, forumRatio: 0.4, medianPct: 0, volumeBaseline: 100 });
    expect(m.newsGap).toBe(30);
  });

  it('量价背离：热且跌=顶部，冷且涨=底部', () => {
    const top = structureMetrics({ ratio: 0.5, volume: 200, topics, newsRatio: null, forumRatio: null, medianPct: -1, volumeBaseline: 100 });
    expect(top.priceGap).toBe('top');
    const bottom = structureMetrics({ ratio: 0.5, volume: 50, topics, newsRatio: null, forumRatio: null, medianPct: 1, volumeBaseline: 100 });
    expect(bottom.priceGap).toBe('bottom');
    const none = structureMetrics({ ratio: 0.5, volume: 100, topics, newsRatio: null, forumRatio: null, medianPct: 1, volumeBaseline: 100 });
    expect(none.priceGap).toBe('none');
  });

  it('信息含量 = 非闲聊占比', () => {
    const m = structureMetrics({ ratio: 0.5, volume: 100, topics, newsRatio: null, forumRatio: null, medianPct: 0, volumeBaseline: 100 });
    expect(m.substance).toBeCloseTo(0.5, 6); // 2 条政策 / 4 条
  });
});

describe('个股抽取', () => {
  const index = new Map<string, string>([
    ['贵州茅台', '600519'],
    ['襄阳轴承', '000678'],
    ['机器人', '300024'],
    ['中国平安', '601318']
  ]);

  it('抽取真实股票名', () => {
    const out = extractStocks('今天贵州茅台和襄阳轴承都在涨', index);
    expect(out.map((x) => x.code)).toEqual(['600519', '000678']);
  });

  it('过滤「机器人」这类通用词误命中', () => {
    const out = extractStocks('机器人板块今天爆发', index);
    expect(out).toHaveLength(0);
  });

  it('长名优先，不会被短名截胡', () => {
    const out = extractStocks('中国平安发布公告', index);
    expect(out[0].name).toBe('中国平安');
  });

  it('提及次数少于 2 次的不上榜', () => {
    const posts: TonePost[] = [
      { text: '贵州茅台涨停', tone: 1 },
      { text: '贵州茅台又涨', tone: 1 },
      { text: '襄阳轴承跌停', tone: -1 }
    ];
    const list = stockMentions(posts, index);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('贵州茅台');
    expect(list[0].count).toBe(2);
    expect(list[0].tone).toBe(1);
  });
});

describe('结论生成', () => {
  it('输出多条可读结论，且包含关键判断', () => {
    const topics = topicStats([
      { text: '降准了', tone: 1 },
      { text: '政策发力', tone: 1 },
      { text: '股东减持', tone: -1 }
    ]);
    const metrics = structureMetrics({ ratio: 0.67, volume: 100, topics, newsRatio: 0.3, forumRatio: 0.7, medianPct: 0, volumeBaseline: 100 });
    const lines = summarizeStructure({
      ratio: 0.67,
      sample: 3,
      band: ratioBand(67),
      level: 'warm',
      tempBand: '58~72 偏热',
      metrics,
      bullDrivers: driversOf(topics, 1),
      bearDrivers: driversOf(topics, -1),
      topStocks: []
    });
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(text).toContain('偏多');
    expect(text).toContain('样本偏少');
    expect(text).toContain('散户情绪跑在消息前面'); // newsGap < 0 且 |gap| >= 20
  });
});
