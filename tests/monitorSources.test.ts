import { describe, expect, it } from 'vitest';
import {
  flashFingerprint,
  mergeFlashes,
  parseSinaQuotes,
  parseYahooJpPrice,
  mergeQuotes,
  announcementHost,
  type MonitorFlash
} from '../src/data/monitorSources';
import type { Quote } from '../src/math/monitor';

const flash = (id: string, text: string, source: MonitorFlash['source']): MonitorFlash => ({
  id,
  text,
  source,
  level: source === 'cls' ? 'A' : 'B',
  read: 0,
  time: '10:30',
  subjects: [],
  fingerprint: flashFingerprint(text)
});

describe('快讯多源归一化与去重', () => {
  it('指纹去掉标点与空白，只留正文', () => {
    expect(flashFingerprint('【央行】降准 0.5 个百分点！')).toBe(flashFingerprint('央行降准05个百分点'));
  });

  it('同一条消息被三个源转载时只留一条', () => {
    const text = '央行宣布降准 0.5 个百分点释放长期资金 1 万亿元';
    const merged = mergeFlashes([
      [flash('a', text, 'sina')],
      [flash('b', text, 'em')],
      [flash('c', text, 'cls')]
    ]);
    expect(merged.length).toBe(1);
    // 财联社有官方重要度，优先保留
    expect(merged[0].source).toBe('cls');
  });

  it('不同消息不去重，且总数有上限', () => {
    const list = Array.from({ length: 80 }, (_, i) => flash(`x${i}`, `第 ${i} 条完全不同的市场快讯内容`, 'sina'));
    expect(mergeFlashes([list]).length).toBeLessThanOrEqual(60);
  });
});

describe('新浪行情解析（三市场字段布局不同）', () => {
  it('A 股：现价 / 昨收 / 涨跌幅 / 高低 / 时间', () => {
    const a = Array.from({ length: 34 }, () => '0');
    a[0] = '贵州茅台'; a[1] = '1450.000'; a[2] = '1452.000'; a[3] = '1448.810';
    a[4] = '1457.720'; a[5] = '1436.000'; a[8] = '2847367';
    a[30] = '2026-11-06'; a[31] = '13:33:57';
    const txt = `var hq_str_sh600519="${a.join(',')}";`;
    const [q] = parseSinaQuotes(txt, ['sh600519']);
    expect(q.price).toBe(1448.81);
    expect(q.prevClose).toBe(1452);
    expect(q.chgPct).toBeCloseTo(-0.22, 1);
    expect(q.high).toBe(1457.72);
    expect(q.low).toBe(1436);
    expect(q.currency).toBe('元');
  });

  it('港股：现价在 a[6]、涨跌幅在 a[8]', () => {
    const a = Array.from({ length: 22 }, () => '0');
    a[0] = 'TENCENT'; a[1] = '腾讯控股'; a[2] = '421.000'; a[3] = '430.400';
    a[4] = '428.600'; a[5] = '418.000'; a[6] = '419.400'; a[7] = '-11.000';
    a[8] = '-2.556'; a[12] = '19757997'; a[17] = '2026/11/06'; a[18] = '13:33:59';
    const txt = `var hq_str_rt_hk00700="${a.join(',')}";`;
    const [q] = parseSinaQuotes(txt, ['hk00700']);
    expect(q.price).toBe(419.4);
    expect(q.chgPct).toBe(-2.56);
    expect(q.currency).toBe('港元');
  });

  it('美股：现价 a[1]、涨跌幅 a[2]', () => {
    const a = Array.from({ length: 30 }, () => '0');
    a[0] = '苹果'; a[1] = '344.1700'; a[2] = '-1.53'; a[3] = '2026-11-06 09:45:05';
    a[4] = '-5.3400'; a[5] = '353.8900'; a[6] = '355.3800'; a[7] = '342.0600'; a[26] = '349.5100';
    const txt = `var hq_str_gb_aapl="${a.join(',')}";`;
    const [q] = parseSinaQuotes(txt, ['usAAPL']);
    expect(q.price).toBe(344.17);
    expect(q.chgPct).toBe(-1.53);
    expect(q.currency).toBe('美元');
  });

  it('日韩不在新浪覆盖范围时跳过，不产生脏数据', () => {
    expect(parseSinaQuotes('', ['jp7203', 'kr005930'])).toEqual([]);
  });
});

describe('Yahoo JP 日股备源解析', () => {
  it('从报价板取带千分位逗号的价格，忽略纯 4 位股票代码', () => {
    const html =
      '<div class="_BasePriceBoard__main_x"><span class="code">7203</span>' +
      '<span>3,291</span><span>-6.06%</span></div>';
    const q = parseYahooJpPrice(html, 'jp7203');
    expect(q).not.toBeNull();
    expect(q!.price).toBe(3291);
    expect(q!.chgPct).toBe(-6.06);
    expect(q!.currency).toBe('日元');
    expect(q!.source).toBe('yahoo-jp');
  });

  it('找不到报价板时返回 null', () => {
    expect(parseYahooJpPrice('<html><body>no data</body></html>', 'jp7203')).toBeNull();
  });
});

const q = (code: string, patch: Partial<Quote> = {}): Quote => ({
  code,
  name: code,
  price: 100,
  prevClose: 99,
  chgPct: 1,
  high: 101,
  low: 98,
  volume: 1000,
  time: '10:00',
  currency: '元',
  market: 'CN',
  ...patch
});

describe('多源行情合并', () => {
  it('主源价格优先，备源只补主源缺失的字段', () => {
    const primary = [q('sh600519', { price: 1441, high: 0, low: 0, prevClose: 0 })];
    const backup = [q('sh600519', { price: 1440, prevClose: 1452, high: 1457, low: 1436, source: 'eastmoney' })];
    const [r] = mergeQuotes(primary, backup);
    expect(r.price).toBe(1441); // 不被备源的微小价差覆盖，避免假跳变
    expect(r.prevClose).toBe(1452);
    expect(r.high).toBe(1457);
  });

  it('主源没有的标的由备源补上', () => {
    const r = mergeQuotes([q('sh600519')], [q('hk00700', { source: 'sina' })]);
    expect(r.map((x) => x.code)).toEqual(['sh600519', 'hk00700']);
    expect(r[1].source).toBe('sina');
  });
});

describe('公告源 host 映射', () => {
  it('按市场映射到对应 host，供前置熔断判断', () => {
    expect(announcementHost('sh600519')).toBe('np-anotice-stock.eastmoney.com');
    expect(announcementHost('hk00700')).toBe('np-anotice-stock.eastmoney.com');
    expect(announcementHost('usAAPL')).toBe('data.sec.gov');
    expect(announcementHost('jp7203')).toBe('finance.yahoo.co.jp');
    expect(announcementHost('kr005930')).toBe('api.stock.naver.com');
  });
});
