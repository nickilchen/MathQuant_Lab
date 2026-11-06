import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  capEvents,
  diffAnnouncements,
  diffNews,
  evalQuotes,
  filterNew,
  normalizeConfig,
  type MonitorEvent,
  type Quote
} from '../src/math/monitor';
import { parseTencentQuotes } from '../src/data/monitor';
import { scoreNews, type NewsLike } from '../src/math/news';
import type { AnnInput } from '../src/math/stockNews';

/* ============ 腾讯批量报价解析（真实返回片段） ============ */

const RAW = [
  'v_sh600519="1~贵州茅台~600519~1441.13~1452.00~1450.00~23991~12504~11487~1440.03~2~1440.00~6~1439.98~1~1439.50~1~1439.40~1~1441.14~1~1441.15~8~1441.16~2~1441.17~5~1441.18~4~~20261106111803~-10.87~-0.75~1457.72~1436.00~1441.13/23991/3468176731~23991~346818~0.19~21.93~~1457.72~1436.00~1.50~18015.30~18015.30~6.64~1597.20~1306.80~0.80~-9~1445.61~20.96~21.88~~~-0.02~346817.6731~0.0000~0~   A~GP-A~6.82~3.53~3.61~30.29~26.74~1539.98~1151.01~7.95~14.10~10.13~1250081601~1250081601~-29.03~-3.73~1250081601~~~4.19~-0.06~~CNY~0~___D__F__N~1439.00~3~";',
  'v_hk00700="100~腾讯控股~00700~427.400~430.400~421.000~14882666.0~0~0~427.400~0~0~0~0~0~0~0~0~0~427.400~0~0~0~0~0~0~0~0~0~14882666.0~2026/11/06 11:03:03~-3.000~-0.70~428.600~419.600~427.400~14882666.0~6317734680.628~0~15.61~~0~0~2.09~38861.9640~38861.9640~TENCENT~1.24~656.700~375.200~1.88~-23.23~0~0~0~0~0~14.33~2.99~0.16~100~-28.01~11.42~GP~20.41~11.00~10.73~3.89~-7.41~9092644829.00~9092644829.00~14.79~5.315~424.503~-21.25~HKD~1~30";',
  'v_usAAPL="200~苹果~AAPL.OQ~344.17~349.51~353.89~75678945~0~0~343.30~1000~0~0~0~0~0~0~0~0~343.40~40~0~0~0~0~0~0~0~0~~2026-11-05 16:00:02~-5.34~-1.53~355.38~342.06~USD~75678945~26240370102~0.52~38.33~~38.33~~3.8~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00~0.00";',
  'v_jp7203="351~Toyota Motor Corp.~7203.T~3319~3533~3500~36784300~~~~~~~~~~~~~~~~~~~~~~~~2026-11-06 10:30:00~-214~-6.05718~3501~3312~~36784300~~~~~~~~~393030.8754~Toyota Motor Corp.~~4000~2686~~~~~~~~~~~~~~~~~~~~~~";',
  'v_kr005930="352~Samsung Electronics Co., Ltd.~005930.KS~195700~201500~180000~19642656~~~~~~~~~~~~~~~~~~~~~~~~2026-11-06 10:54:54~-5800~-2.87841~196500~179200~~19642656~~~~~~~~~11280526.2783~Samsung Electronics Co., Ltd.~~374500~94500~~~~~~~~~~~~~~~~~~~~~~";'
].join('\n');

describe('腾讯批量报价解析', () => {
  it('五个市场一次解析，字段位置统一', () => {
    const codes = ['sh600519', 'hk00700', 'usAAPL', 'jp7203', 'kr005930'];
    const q = parseTencentQuotes(RAW, codes);
    expect(q.length).toBe(5);
    expect(q.map((x) => x.market)).toEqual(['CN', 'HK', 'US', 'JP', 'KR']);
    expect(q.map((x) => x.currency)).toEqual(['元', '港元', '美元', '日元', '韩元']);
  });

  it('A 股：价格、涨跌幅、高低、时间', () => {
    const [a] = parseTencentQuotes(RAW, ['sh600519']);
    expect(a.name).toBe('贵州茅台');
    expect(a.price).toBe(1441.13);
    expect(a.prevClose).toBe(1452);
    expect(a.chgPct).toBe(-0.75);
    expect(a.high).toBe(1457.72);
    expect(a.low).toBe(1436);
    expect(a.time).toBe('20261106111803');
  });

  it('日韩涨跌幅小数位收敛到 2 位', () => {
    const q = parseTencentQuotes(RAW, ['jp7203', 'kr005930']);
    expect(q[0].chgPct).toBe(-6.06);
    expect(q[1].chgPct).toBe(-2.88);
  });

  it('未返回 / 无有效价格的代码被跳过，不产生脏数据', () => {
    const q = parseTencentQuotes('v_pv_none_match="1";\nv_sh600519="1~x~600519~0~0~0~0";', ['sh600519', 'usNVDA']);
    expect(q).toEqual([]);
  });

  it('空文本不抛异常', () => {
    expect(parseTencentQuotes('', ['sh600519'])).toEqual([]);
  });
});

/* ============ 配置边界 ============ */

describe('配置归一化', () => {
  it('间隔低于下限会被夹住，避免疯狂请求', () => {
    const c = normalizeConfig({ quoteInterval: 0, newsInterval: -5, annInterval: 1 });
    expect(c.quoteInterval).toBe(10);
    expect(c.newsInterval).toBe(20);
    expect(c.annInterval).toBe(60);
  });

  it('阈值与档位不合法时回退默认', () => {
    const c = normalizeConfig({ rules: { ...DEFAULT_RULES, movePct: -3, jumpPct: 999, newsTier: 'Z' as 'A' } });
    expect(c.rules.movePct).toBeGreaterThan(0);
    expect(c.rules.jumpPct).toBeLessThanOrEqual(20);
    expect(c.rules.newsTier).toBe('A');
  });
});

/* ============ 快讯增量 ============ */

const flash = (id: string, text: string, level = 'A'): NewsLike => ({
  id,
  text,
  level,
  read: 20000,
  time: '10:30',
  subjects: ['宏观']
});

describe('快讯增量', () => {
  const heavy = flash('n2', '央行宣布降准 0.5 个百分点，释放长期资金 1 万亿元', 'A');
  const light = flash('n3', '【投资日历】今日重要财经事件一览', 'C');

  it('首次轮询（prev=null）建立基线，不刷屏', () => {
    expect(diffNews(null, [heavy, light], DEFAULT_RULES)).toEqual([]);
  });

  it('只报新增的快讯，已见过的不再报', () => {
    const old = flash('n1', '某公司公告拟回购股份', 'B');
    const evs = diffNews([old], [old, heavy], DEFAULT_RULES);
    expect(evs.length).toBe(1);
    expect(evs[0].id).toBe('news:n2');
    expect(evs[0].kind).toBe('news');
    expect(evs[0].link).toBe('/sentiment');
  });

  it('档位门槛生效：低于门槛的不报', () => {
    const tier = scoreNews(heavy).tier;
    // 把门槛设到比这条更高（如果已经是 S 就跳过该断言）
    if (tier !== 'S') {
      expect(diffNews([], [heavy], { ...DEFAULT_RULES, newsTier: 'S' })).toEqual([]);
    }
    expect(diffNews([], [light], { ...DEFAULT_RULES, newsTier: 'A' })).toEqual([]);
  });

  it('关闭快讯监控时不产生事件', () => {
    expect(diffNews([], [heavy], { ...DEFAULT_RULES, enableNews: false })).toEqual([]);
  });

  it('跨源 ID 并集：主源被限流切到备源再切回来，不把旧消息当新增', () => {
    const old = flash('n1', '央行降准释放 1 万亿元流动性', 'A');
    const sinaOnly = flash('sina:9', '台湾加权指数进入熊市', 'B');
    // 第一轮看到主源 n1，第二轮因主源被限流只拿到备源消息
    const seen = new Set([old.id, sinaOnly.id]);
    // 第三轮主源恢复，仍带着 n1 → 不该再报
    const evs = diffNews([sinaOnly], [old, heavy], DEFAULT_RULES, Date.now(), seen);
    expect(evs.every((e) => e.id !== 'news:n1')).toBe(true);
    expect(evs.some((e) => e.id === 'news:n2')).toBe(true);
  });

  it('一次返回大量新快讯时裁剪到上限', () => {
    const many = Array.from({ length: 40 }, (_, i) => flash(`m${i}`, '央行降准释放 1 万亿元流动性', 'A'));
    const evs = diffNews([], many, DEFAULT_RULES);
    expect(evs.length).toBeLessThanOrEqual(12);
  });
});

/* ============ 行情：穿越 + 跳变 ============ */

const quote = (price: number, chgPct: number): Quote => ({
  code: 'sh600519',
  name: '贵州茅台',
  price,
  prevClose: 100,
  chgPct,
  high: price * 1.02,
  low: price * 0.98,
  volume: 10000,
  time: '11:00:00',
  currency: '元',
  market: 'CN'
});

describe('行情告警', () => {
  it('首次基线不告警', () => {
    expect(evalQuotes(null, [quote(101, 3.5)], DEFAULT_RULES)).toEqual([]);
  });

  it('涨跌幅从阈值内越到阈值外，报一次', () => {
    const evs = evalQuotes([quote(99, 2.9)], [quote(100.5, 3.5)], DEFAULT_RULES);
    expect(evs.some((e) => e.title.includes('越过'))).toBe(true);
    expect(evs[0].code).toBe('sh600519');
    expect(evs[0].value).toBeCloseTo(3.5);
  });

  it('一直在阈值外不重复报（穿越语义）', () => {
    const evs = evalQuotes([quote(100.5, 3.5)], [quote(100.6, 3.6)], DEFAULT_RULES);
    expect(evs.some((e) => e.title.includes('越过'))).toBe(false);
  });

  it('瞬时急跌产生跳变事件', () => {
    const evs = evalQuotes([quote(100, 1)], [quote(97.5, -1.5)], DEFAULT_RULES);
    const jump = evs.find((e) => e.title.includes('急跌'));
    expect(jump).toBeDefined();
    expect(jump!.value).toBeCloseTo(-2.5);
  });

  it('同一分钟同方向跳变只报一次（ID 稳定）', () => {
    const now = 1762400000000;
    const a = evalQuotes([quote(100, 1)], [quote(98, -1)], DEFAULT_RULES, now);
    const b = evalQuotes([quote(98, -1)], [quote(96, -3)], DEFAULT_RULES, now + 10000);
    const ids = [...a, ...b].filter((e) => e.title.includes('急跌')).map((e) => e.id);
    expect(new Set(ids).size).toBe(1);
  });

  it('跌幅超过阈值两倍时级别升为 critical', () => {
    const evs = evalQuotes([quote(100, 0)], [quote(92, -7)], DEFAULT_RULES);
    expect(evs.some((e) => e.level === 'critical')).toBe(true);
  });

  it('关闭行情监控时不产生事件', () => {
    expect(evalQuotes([quote(99, 2.9)], [quote(100.5, 3.5)], { ...DEFAULT_RULES, enableQuotes: false })).toEqual([]);
  });
});

/* ============ 公告增量 ============ */

const ann = (id: string, title: string, market: AnnInput['market'] = 'CN'): AnnInput => ({
  id,
  title,
  date: '2026-11-06',
  market
});

const meta = { code: 'sh600519', name: '贵州茅台', market: 'CN' as const };

describe('公告增量', () => {
  it('首次基线不告警', () => {
    expect(diffAnnouncements(null, [ann('a1', '关于回购公司股份的公告')], meta, DEFAULT_RULES)).toEqual([]);
  });

  it('只报新增公告，且标出公司行为', () => {
    const evs = diffAnnouncements(
      new Set(['a1']),
      [ann('a1', '关于回购公司股份的公告'), ann('a2', '关于收到证监会立案告知书的公告')],
      meta,
      DEFAULT_RULES
    );
    expect(evs.length).toBe(1);
    expect(evs[0].id).toContain('a2');
    expect(evs[0].kind).toBe('announcement');
    expect(evs[0].level).toBe('critical');
  });

  it('说明会 / 程序性公告被跳过，不刷屏', () => {
    const evs = diffAnnouncements(
      new Set(),
      [ann('a3', '关于召开2026年第三季度业绩说明会的公告'), ann('a4', '公司章程修订说明')],
      meta,
      DEFAULT_RULES
    );
    expect(evs).toEqual([]);
  });

  it('关闭「只报重要」后仍不报 other', () => {
    const evs = diffAnnouncements(new Set(), [ann('a5', '某某无关事项说明')], meta, {
      ...DEFAULT_RULES,
      annImportantOnly: false
    });
    expect(evs).toEqual([]);
  });
});

/* ============ 去重与裁剪 ============ */

const ev = (id: string, level: MonitorEvent['level'] = 'info', ts = 1000): MonitorEvent => ({
  id,
  ts,
  kind: 'quote',
  level,
  title: id,
  detail: ''
});

describe('事件去重与裁剪', () => {
  it('跨轮重复 ID 被过滤，seen 同步更新', () => {
    const first = filterNew([ev('a'), ev('b')], new Set());
    expect(first.fresh.length).toBe(2);
    const second = filterNew([ev('b'), ev('c')], first.seen);
    expect(second.fresh.map((e) => e.id)).toEqual(['c']);
  });

  it('seen 超过 2000 条会截断', () => {
    const big = new Set(Array.from({ length: 2500 }, (_, i) => `old${i}`));
    const r = filterNew([ev('new')], big);
    expect(r.seen.size).toBeLessThanOrEqual(2000);
    expect(r.seen.has('new')).toBe(true);
  });

  it('单轮裁剪按级别保留最重要的', () => {
    const list = [ev('low', 'info'), ev('high', 'critical')];
    const capped = capEvents(list, 1);
    expect(capped.length).toBe(1);
    expect(capped[0].id).toBe('high');
  });
});
