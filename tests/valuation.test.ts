import { describe, expect, it } from 'vitest';
import { DEFAULT_VALUATION_CONFIG, analyzeValuation, percentile, priceAfterNotice, statsOf, ttmOf } from '../src/math/valuation';
import { canFetchValuation, valuationCode, valuationMarket, valuationMeta } from '../src/data/valuation';
import { parseSaDate, parseSaNumber, parseSaSeries } from '../src/data/valuation/sa';
import { parseSecQuarterly } from '../src/data/valuation/sec';
import { mapHkRow } from '../src/data/valuation/hk';
import { mapNaverFinance } from '../src/data/valuation/kr';
import type { QuarterReport } from '../src/data/valuation';
import type { Bar } from '../src/data/types';

/** 造 N 年季度（默认 3 年 = 12 季），累计 EPS 每年 1/2/3/4 且逐年 +1 */
function mkReports(epsSign = 1, years = 3): QuarterReport[] {
  const out: QuarterReport[] = [];
  const startYear = 2026 - years;
  for (let y = startYear; y <= 2025; y++) {
    const base = y - startYear;
    const quarters: [string, number, string][] = [
      ['03-31', 1 + base, `${y}-04-25`],
      ['06-30', 2 + base, `${y}-08-15`],
      ['09-30', 3 + base, `${y}-10-30`],
      ['12-31', 4 + base, `${y + 1}-04-15`]
    ];
    for (const [md, cum, notice] of quarters) {
      out.push({
        period: `${y}-${md}`,
        noticeDate: notice,
        epsCum: cum * epsSign,
        netProfitCum: cum * 1e8 * epsSign,
        revenueCum: cum * 4e8,
        bps: 20 + base * 2 + cum * 0.5,
        roe: 12 + base,
        profitYoY: 10 - base * 3,
        revenueYoY: 8,
        grossMargin: 40,
        ocfPerShare: cum * 0.8
      });
    }
  }
  return out.reverse(); // 最新在前
}

/** 造覆盖 2023-01-01 ~ 2026-04-30 的日 K，价格线性 100 → 160 */
function mkBars(endPrice = 150): Bar[] {
  const out: Bar[] = [];
  const start = new Date('2020-01-01T00:00:00').getTime();
  const end = new Date('2026-04-30T00:00:00').getTime();
  const days = Math.round((end - start) / 86400000);
  for (let i = 0; i <= days; i++) {
    const d = new Date(start + i * 86400000);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const p = 100 + (i / days) * 50;
    out.push({ date, open: p, high: p * 1.01, low: p * 0.99, close: p, volume: 1e6, amount: p * 1e6 });
  }
  if (out.length) out[out.length - 1].close = endPrice;
  return out;
}

describe('分位数', () => {
  it('线性插值分位', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.25)).toBe(10);
    expect(percentile([], 0.5)).toBeNaN();
  });

  it('样本少于 4 个不给出统计', () => {
    expect(statsOf([10, 12, 14])).toBeNull();
    const s = statsOf([10, 12, 14, 16]);
    expect(s).not.toBeNull();
    expect(s!.p25).toBeLessThan(s!.p50);
    expect(s!.p50).toBeLessThan(s!.p75);
  });
});

describe('TTM 累计值差分', () => {
  const r = mkReports();

  it('年报累计值本身就是 TTM', () => {
    const q4 = r.findIndex((x) => x.period === '2024-12-31');
    expect(ttmOf(r, q4).eps).toBe(5);
  });

  it('中报用「本期 + 上年全年 − 上年同期」', () => {
    const q2 = r.findIndex((x) => x.period === '2024-06-30');
    // 本期累计 3 + 上年全年 4 − 上年同期 2 = 5
    expect(ttmOf(r, q2).eps).toBe(5);
  });

  it('最早一期缺上年数据时返回 null', () => {
    const q1 = r.findIndex((x) => x.period === '2023-03-31');
    expect(ttmOf(r, q1).eps).toBeNull();
  });
});

describe('公告日后的价格（防前视偏差）', () => {
  it('只取公告当日及之后的收盘价', () => {
    const bars = mkBars();
    const p = priceAfterNotice(bars, '2024-04-25');
    expect(p).not.toBeNull();
    const first = bars.find((b) => b.date >= '2024-04-25')!;
    expect(p).toBe(first.close);
  });

  it('公告日之后没有 K 线时返回 null', () => {
    expect(priceAfterNotice(mkBars(), '2030-01-01')).toBeNull();
  });

  it('公告日早于 K 线覆盖范围时返回 null（不能拿今天的价格配多年前的财报）', () => {
    const short = mkBars().filter((b) => b.date >= '2026-01-01');
    expect(priceAfterNotice(short, '2021-04-25')).toBeNull();
  });
});

describe('估值评断', () => {
  const reports = mkReports();
  const bars = mkBars(150);

  it('给出三档具体价格且 low < fair < high', () => {
    const a = analyzeValuation(reports, bars)!;
    expect(a).not.toBeNull();
    expect(a.low).not.toBeNull();
    expect(a.fair).not.toBeNull();
    expect(a.high).not.toBeNull();
    expect(a.low!).toBeLessThan(a.fair!);
    expect(a.fair!).toBeLessThan(a.high!);
  });

  it('差额 = 合理价 − 现价，百分比口径一致', () => {
    const a = analyzeValuation(reports, bars)!;
    expect(a.diff).toBeCloseTo(a.fair! - a.current, 6);
    expect(a.diffPct).toBeCloseTo((a.diff! / a.current) * 100, 6);
  });

  it('判定与差额方向一致', () => {
    const a = analyzeValuation(reports, bars)!;
    if (a.diff! > 0) expect(['明显低估', '偏低估', '合理']).toContain(a.verdict);
    else expect(['合理', '偏高估', '明显高估']).toContain(a.verdict);
  });

  it('结论包含具体金额与百分比', () => {
    const a = analyzeValuation(reports, bars)!;
    const lines = a.lines.join('');
    expect(lines).toContain('元');
    expect(lines).toContain('%');
    expect(lines).toContain(a.verdict);
  });

  it('历史轨迹长度与财报一致，且早期样本不足时合理价为空', () => {
    const a = analyzeValuation(reports, bars)!;
    expect(a.history.length).toBe(reports.length);
    expect(a.history[0].fairPrice).toBeNull(); // 第一季只有 1 个 PE 样本
    expect(a.history[a.history.length - 1].fairPrice).not.toBeNull();
  });

  it('扩张窗口只用已知数据：合理价随财报滚动变化', () => {
    const a = analyzeValuation(reports, bars)!;
    const fairs = a.history.map((h) => h.fairPrice).filter((v): v is number => v != null);
    expect(fairs.length).toBeGreaterThan(4);
    expect(new Set(fairs.map((v) => v.toFixed(2))).size).toBeGreaterThan(1);
  });

  it('换窗口会改变分位与合理价（需要足够多的季度）', () => {
    const longReports = mkReports(1, 6); // 24 季
    const a12 = analyzeValuation(longReports, bars, { ...DEFAULT_VALUATION_CONFIG, window: 12 })!;
    const a24 = analyzeValuation(longReports, bars, { ...DEFAULT_VALUATION_CONFIG, window: 24 })!;
    expect(a12.peStats!.count).toBeLessThan(a24.peStats!.count);
    expect(a12.fair).not.toBe(a24.fair);
  });

  it('方法选 PB 时合理价按 BPS × PB 中位数', () => {
    const a = analyzeValuation(reports, bars, { window: 20, method: 'pb' })!;
    expect(a.method).toBe('pb');
    expect(a.fair).toBeCloseTo(a.bps * a.pbStats!.p50, 6);
  });

  it('亏损股（EPS 为负）自动回退 PB', () => {
    const a = analyzeValuation(mkReports(-1), bars)!;
    expect(a.method).toBe('pb');
    expect(a.fair).not.toBeNull();
  });

  it('K 线不足 60 根返回 null', () => {
    expect(analyzeValuation(reports, bars.slice(0, 30))).toBeNull();
  });
});

describe('市场支持', () => {
  it('A 股六位代码', () => {
    expect(valuationCode('sh600519')).toBe('600519');
    expect(valuationCode('sz000001')).toBe('000001');
    expect(valuationCode('hk00700')).toBeNull();
  });

  it('五个市场都能识别', () => {
    expect(valuationMarket('sh600519')).toBe('CN');
    expect(valuationMarket('hk00700')).toBe('HK');
    expect(valuationMarket('usAAPL')).toBe('US');
    expect(valuationMarket('jp7203')).toBe('JP');
    expect(valuationMarket('kr005930')).toBe('KR');
    expect(canFetchValuation('usNVDA')).toBe(true);
    expect(canFetchValuation('jp72030')).toBe(true);
  });

  it('指数与台股不支持（指数没有财报）', () => {
    expect(valuationMarket('sh000001')).toBeNull();
    expect(valuationMarket('hkHSI')).toBeNull();
    expect(valuationMarket('hkHSTECH')).toBeNull();
    expect(valuationMarket('usDJI')).toBeNull();
    expect(valuationMarket('jpN225')).toBeNull();
    expect(valuationMarket('krKOSPI')).toBeNull();
    expect(valuationMarket('tw2330')).toBeNull();
    expect(valuationMarket('')).toBeNull();
  });

  it('各市场货币与公告日口径不同', () => {
    expect(valuationMeta('sh600519')?.currency).toBe('元');
    expect(valuationMeta('sh600519')?.noticeEstimated).toBe(false);
    expect(valuationMeta('hk00700')?.currency).toBe('港元');
    expect(valuationMeta('usAAPL')?.currencySymbol).toBe('$');
    expect(valuationMeta('jp7203')?.currency).toBe('日元');
    expect(valuationMeta('kr005930')?.currency).toBe('韩元');
    // 海外源没有公告日字段，必须标为估算
    expect(valuationMeta('hk00700')?.noticeEstimated).toBe(true);
    expect(valuationMeta('jp7203')?.noticeEstimated).toBe(true);
  });
});

/* ============ 口径选择的可解释性 ============ */

describe('口径选择', () => {
  it('自动 + EPS > 0 + 样本够 → PE，并说明理由', () => {
    const a = analyzeValuation(mkReports(1, 3), mkBars(), DEFAULT_VALUATION_CONFIG)!;
    expect(a.method).toBe('pe');
    expect(a.methodReason).toContain('自动');
    expect(a.methodReason).toContain('用 PE');
    expect(a.methodReason).toContain('PE 样本');
    // 说明里必须带 EPS 数值，用户才知道凭什么选的
    expect(a.methodReason).toMatch(/TTM EPS -?\d/);
  });

  it('自动 + EPS ≤ 0 → 回退 PB，并写明 EPS ≤ 0', () => {
    const a = analyzeValuation(mkReports(-1, 3), mkBars(), DEFAULT_VALUATION_CONFIG)!;
    expect(a.method).toBe('pb');
    expect(a.methodReason).toContain('≤ 0');
    expect(a.methodReason).toContain('回退 PB');
  });

  it('自动 + PE 样本不足 → 回退 PB，并写明样本数', () => {
    const a = analyzeValuation([mkOverseas(2.1, 8.4)], mkBars(), DEFAULT_VALUATION_CONFIG)!;
    expect(a.method).toBe('pb');
    expect(a.methodReason).toContain('样本只有 1 个');
    expect(a.methodReason).toContain('回退 PB');
  });

  it('手动 PE 但 EPS ≤ 0 → 仍回退，并明确告诉用户「已回退」', () => {
    const a = analyzeValuation(mkReports(-1, 3), mkBars(), { ...DEFAULT_VALUATION_CONFIG, method: 'pe' })!;
    expect(a.method).toBe('pb');
    expect(a.methodReason).toContain('手动选择 PE');
    expect(a.methodReason).toContain('已回退 PB');
  });

  it('手动 PB 直接说明是手动选择', () => {
    const a = analyzeValuation(mkReports(1, 3), mkBars(), { ...DEFAULT_VALUATION_CONFIG, method: 'pb' })!;
    expect(a.method).toBe('pb');
    expect(a.methodReason).toContain('手动选择 PB');
  });
});

/* ============ 海外：单季 TTM ============ */

const mkOverseas = (epsQuarter: number, ttmEps: number | null): QuarterReport => ({
  period: '2026-03-31',
  noticeDate: '2026-04-15',
  epsCum: epsQuarter,
  epsQuarter,
  ttmEps,
  ttmProfit: null,
  netProfitCum: 0,
  revenueCum: 0,
  bps: 30,
  roe: null,
  profitYoY: null,
  revenueYoY: null,
  grossMargin: null,
  ocfPerShare: null,
  noticeEstimated: true
});

describe('海外单季 TTM', () => {
  it('ttmEps 存在时直接用，不再走累计差分', () => {
    const r = mkOverseas(2.1, 8.4);
    expect(ttmOf([r], 0)).toEqual({ eps: 8.4, profit: null });
  });

  it('ttmEps 缺失时回退累计差分（A 股口径）', () => {
    const reports = mkReports(1, 3);
    const r = reports.find((x) => x.period === '2025-06-30')!;
    // 2025H1 累计 4 + 2024 全年 5 − 2024H1 累计 3 = 6
    expect(ttmOf(reports, reports.indexOf(r)).eps).toBe(6);
  });

  it('ADR 币种不一致时拒绝出价，不给放大了汇率的假空间', () => {
    // SK 海力士 ADR：财报 EPS 是韩元（26 万），股价是美元（143）
    const reports = mkReports(1, 3).map((r) => ({ ...r, ttmEps: 260000 }));
    const a = analyzeValuation(reports, mkBars(143), { ...DEFAULT_VALUATION_CONFIG, currency: '美元' })!;
    expect(a.unitMismatch).toBe(true);
    expect(a.verdict).toBe('无法判断');
    expect(a.fair).toBeNull();
    expect(a.diff).toBeNull();
    expect(a.verdictNote).toContain('币种');
    expect(a.lines.join('')).toContain('币种/单位不一致');
  });

  it('正常 PE 不会被误判成币种不一致', () => {
    const a = analyzeValuation(mkReports(1, 3), mkBars(143), DEFAULT_VALUATION_CONFIG)!;
    expect(a.unitMismatch).toBe(false);
    expect(a.fair).not.toBeNull();
  });

  it('海外财报的 ROE/同比缺失时算法不崩，也不冒充 0', () => {
    const a = analyzeValuation([mkOverseas(2.1, 8.4)], mkBars(), { ...DEFAULT_VALUATION_CONFIG, currency: '美元' });
    // 样本不足时返回 null 或「无法判断」，不能抛异常
    if (a) {
      expect(a.lines.join('')).not.toContain('同比 +0.00%');
      expect(a.lines.join('')).toContain('美元');
    }
  });
});

/* ============ StockAnalysis HTML 解析 ============ */

const SA_HTML = `<table><thead><tr>
<th>Fiscal Quarter</th><th>Q1 2027</th><th>Q4 2026</th><th>Q3 2026</th><th>Q2 2026</th>
<th>Period Ending</th>
<th>Mar '27 Mar 31, 2027</th><th>Dec '26 Dec 31, 2026</th><th>Sep '26 Sep 30, 2026</th><th>Jun '26 Jun 30, 2026</th>
</tr></thead><tbody>
<tr><td>Period Ending</td><td>Mar 31, 2027</td><td>Dec 31, 2026</td><td>Sep 30, 2026</td><td>Jun 30, 2026</td></tr>
<tr><td>Earnings Per Share EPS Growth</td><td>120.69</td><td>62.70</td><td>(96.48)</td><td>-</td></tr>
<tr><td>Book Value Per Share</td><td>3,150.60</td><td>3,062.82</td><td>2,990.37</td><td>2,876.62</td></tr>
</tbody></table>`;

describe('StockAnalysis 财报页解析', () => {
  it('数值：千分位、括号负数、缺失', () => {
    expect(parseSaNumber('1,234.56')).toBe(1234.56);
    expect(parseSaNumber('(96.48)')).toBe(-96.48);
    expect(parseSaNumber('-')).toBeNull();
    expect(parseSaNumber('n/a')).toBeNull();
    expect(parseSaNumber('0')).toBe(0);
  });

  it('日期：Jun \'26 Jun 30, 2026 → 2026-06-30', () => {
    expect(parseSaDate("Jun '26 Jun 30, 2026")).toBe('2026-06-30');
    expect(parseSaDate('Mar 31, 2027')).toBe('2027-03-31');
    expect(parseSaDate('—')).toBeNull();
  });

  it('抽 EPS 序列：季度标签与日期按顺序对齐', () => {
    const r = parseSaSeries(SA_HTML, /^earnings per share|^eps/i)!;
    expect(r.quarters).toEqual(['Q1 2027', 'Q4 2026', 'Q3 2026', 'Q2 2026']);
    expect(r.dates).toEqual(['2027-03-31', '2026-12-31', '2026-09-30', '2026-06-30']);
    expect(r.values).toEqual([120.69, 62.7, -96.48, null]);
  });

  it('抽每股净资产序列', () => {
    const r = parseSaSeries(SA_HTML, /^book value per share/i)!;
    expect(r.values[0]).toBe(3150.6);
    expect(r.values[1]).toBe(3062.82);
  });

  it('没有目标行时返回 null，不抛异常', () => {
    expect(parseSaSeries(SA_HTML, /^revenue$/i)).toBeNull();
    expect(parseSaSeries('<table><tbody><tr><td>x</td></tr></tbody></table>', /^eps/i)).toBeNull();
  });
});

/* ============ 新数据源解析器（SEC / 港股 / 韩股）============ */

describe('SEC 美股单季 EPS 识别', () => {
  const fact = (start: string, end: string, val: number, filed: string) => ({ start, end, val, filed, form: '10-Q' });
  const facts = [
    // 累计（Q3 前三季合计）+ 单季（当季）——同一 end 两条，应取单季
    fact('2025-09-28', '2026-06-27', 6.88, '2026-07-31'),
    fact('2026-03-29', '2026-06-27', 2.02, '2026-07-31'),
    // 修订申报：同 end 更晚 filed 应覆盖
    fact('2025-12-28', '2026-03-28', 1.98, '2026-05-01'),
    fact('2025-12-28', '2026-03-28', 2.01, '2026-05-05'),
    // 年报（跨度 > 120 天）应排除
    fact('2025-09-28', '2026-09-26', 8.98, '2026-11-03'),
    // 缺 start 应排除
    { end: '2026-01-01', val: 1, filed: '2026-02-01', form: '10-Q' }
  ];

  it('只保留单季，累计/年报/缺 start 都被排除', () => {
    const r = parseSecQuarterly(facts as never);
    expect(r.map((x) => x.end)).toEqual(['2026-03-28', '2026-06-27']);
  });

  it('同一 end 的修订申报取 filed 最新', () => {
    const r = parseSecQuarterly(facts as never);
    expect(r.find((x) => x.end === '2026-03-28')?.val).toBe(2.01);
  });

  it('结果按期末日期升序', () => {
    const r = parseSecQuarterly(facts as never);
    expect(r[0].end < r[1].end).toBe(true);
  });
});

describe('港股东财财报映射', () => {
  const row = {
    STD_REPORT_DATE: '2026-09-30 00:00:00',
    BASIC_EPS: 19.697,
    BPS: 133.25,
    EPS_TTM: 25.95,
    PE_TTM: 11.36,
    PB_TTM: 2.2,
    ROE_AVG: 15.03,
    HOLDER_PROFIT_YOY: 6.69,
    OPERATE_INCOME_YOY: 9.18,
    GROSS_PROFIT_RATIO: 56.79,
    PER_NETCASH_OPERATE: 17.24
  };

  it('映射核心字段并标记公告日为估算', () => {
    const r = mapHkRow(row)!;
    expect(r.period).toBe('2026-09-30');
    expect(r.bps).toBe(133.25);
    expect(r.noticeEstimated).toBe(true);
    expect(r.ttmEps).toBe(25.95); // 直接用东财 EPS_TTM
    expect(r.peHint).toBe(11.36);
    expect(r.pbHint).toBe(2.2);
  });

  it('季报公告日 = 报告期 + 60 天', () => {
    const r = mapHkRow(row)!;
    expect(r.noticeDate).toBe('2026-11-29');
  });

  it('年报公告日 = 报告期 + 100 天', () => {
    const r = mapHkRow({ ...row, STD_REPORT_DATE: '2025-12-31 00:00:00' })!;
    expect(r.noticeDate).toBe('2026-04-10');
  });

  it('无报告期返回 null', () => {
    expect(mapHkRow({ BASIC_EPS: 1 })).toBeNull();
  });
});

describe('韩股 Naver 年度财报映射', () => {
  const resp = {
    financeInfo: {
      trTitleList: [
        { key: '202312', title: '2023.12.' },
        { key: '202412', title: '2024.12.' },
        { key: '202512', title: '2025.12.' }
      ],
      rowList: [
        { title: 'EPS', columns: { 202312: { value: '2,131' }, 202412: { value: '4,950' }, 202512: { value: '6,564' } } },
        { title: 'BPS', columns: { 202312: { value: '52,002' }, 202412: { value: '57,981' }, 202512: { value: '63,997' } } },
        { title: 'PER', columns: { 202312: { value: '36.84' }, 202412: { value: '10.75' }, 202512: { value: '18.27' } } },
        { title: 'PBR', columns: { 202312: { value: '1.51' }, 202412: { value: '0.92' }, 202512: { value: '1.87' } } },
        { title: 'ROE', columns: { 202312: { value: '4.15' }, 202412: { value: '9.03' }, 202512: { value: '10.85' } } }
      ]
    }
  };

  it('解析千分位 EPS / BPS 与 PE / PB 提示', () => {
    const list = mapNaverFinance(resp as never);
    expect(list).toHaveLength(3);
    expect(list[0].period).toBe('2025-12-31'); // 最新在前
    expect(list[0].epsCum).toBe(6564);
    expect(list[0].bps).toBe(63997);
    expect(list[0].peHint).toBe(18.27);
    expect(list[0].pbHint).toBe(1.87);
    expect(list[0].ttmEps).toBe(6564); // 年度 EPS 即 TTM
  });

  it('无 EPS 的期被跳过', () => {
    const r = mapNaverFinance({
      financeInfo: {
        trTitleList: [{ key: '202512', title: '2025.12.' }],
        rowList: [{ title: 'BPS', columns: { 202512: { value: '100' } } }]
      }
    } as never);
    expect(r).toHaveLength(0);
  });
});
