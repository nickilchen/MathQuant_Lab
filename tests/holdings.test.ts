import { describe, expect, it } from 'vitest';
import {
  CLASS_META,
  aggregateClasses,
  classifyHolder,
  concentration,
  histogram,
  instSignal,
  institutionRatio,
  institutionValue,
  isInstitution,
  median,
  percentileRank,
  percentileText,
  pct,
  prevDate,
  sharesText,
  sortDatesDesc,
  yi,
  type HolderLike
} from '../src/math/holdings';

const H = (name: string, orgType: string, value: number, ratio = 1): HolderLike => ({
  name,
  orgType,
  value,
  shares: Math.round(value / 10),
  ratio
});

describe('机构属性分类', () => {
  it('国家大基金优先于官方「私募基金」标注', () => {
    // 东财把大基金标成私募基金，名称规则必须赢
    expect(classifyHolder('华芯投资管理有限责任公司-国家集成电路产业投资基金二期股份有限公司', '私募基金')).toBe('bigfund');
    expect(classifyHolder('国家集成电路产业投资基金股份有限公司', '其他')).toBe('bigfund');
    expect(classifyHolder('国家制造业转型升级基金股份有限公司', '其他')).toBe('bigfund');
  });

  it('国家队 / 社保 / 保险', () => {
    expect(classifyHolder('中国证券金融股份有限公司', '其他')).toBe('national');
    expect(classifyHolder('中央汇金资产管理有限责任公司', '其他')).toBe('national');
    expect(classifyHolder('梧桐树投资平台有限责任公司', '其他')).toBe('national');
    expect(classifyHolder('全国社会保障基金一一三组合', '其他')).toBe('social');
    expect(classifyHolder('中国人寿保险股份有限公司-传统-普通保险产品', '其他')).toBe('insurance');
    expect(classifyHolder('某组合', '社保')).toBe('social');
  });

  it('外资：QFII 与北向通道', () => {
    expect(classifyHolder('香港中央结算有限公司', '其他')).toBe('foreign');
    expect(classifyHolder('HKSCC NOMINEES LIMITED', '其他')).toBe('foreign');
    expect(classifyHolder('摩根士丹利国际股份有限公司', 'QFII')).toBe('foreign');
  });

  it('私募品牌 vs 公募产品', () => {
    expect(classifyHolder('上海高毅资产管理合伙企业(有限合伙)-高毅邻山1号远望基金', '私募基金')).toBe('private');
    expect(classifyHolder('上海重阳战略投资有限公司-重阳战略才智基金', '私募基金')).toBe('private');
    // 托管行前缀 + 公募产品名 → 公募
    expect(classifyHolder('招商中证白酒指数A', '基金')).toBe('public');
    expect(classifyHolder('华泰柏瑞沪深300ETF', '基金')).toBe('public');
    expect(classifyHolder('中信证券股份有限公司-嘉实上证科创板芯片交易型开放式指数证券投资基金', '基金')).toBe('public');
  });

  it('券商 / 产业资本 / 个人', () => {
    expect(classifyHolder('中信证券股份有限公司', '券商')).toBe('broker');
    expect(classifyHolder('华泰证券资管-华泰新启元FOF单一资产管理计划-华泰价值睿远单一资产管理计划', '其他')).toBe('broker');
    expect(classifyHolder('中电海康集团有限公司', '投资公司')).toBe('industrial');
    expect(classifyHolder('中国贵州茅台酒厂(集团)有限责任公司', '其他')).toBe('industrial');
    // 「(集团)技术开发」这类不带「集团有限公司」连写的也要归产业资本
    expect(classifyHolder('贵州茅台酒厂(集团)技术开发有限公司', '其他')).toBe('industrial');
    expect(classifyHolder('贵州省国有资本运营有限责任公司', '其他')).toBe('industrial');
    expect(classifyHolder('龚虹嘉', '个人')).toBe('person');
  });

  it('基金公司专户 / FOF 归公募', () => {
    expect(classifyHolder('大成基金-大成基金启盛FOF单一资产管理计划-大成基金恒鑫单一资产管理计划', '其他')).toBe('public');
    expect(classifyHolder('国丰兴华(北京)私募基金管理有限公司-鸿鹄志远(上海)私募投资基金有限公司', '其他')).toBe('private');
  });

  it('机构口径排除产业资本与个人', () => {
    expect(isInstitution('public')).toBe(true);
    expect(isInstitution('bigfund')).toBe(true);
    expect(isInstitution('industrial')).toBe(false);
    expect(isInstitution('person')).toBe(false);
    expect(CLASS_META.bigfund.inst).toBe(true);
  });
});

describe('分类聚合', () => {
  const rows = [
    H('华泰柏瑞沪深300ETF', '基金', 300, 3),
    H('招商中证白酒指数A', '基金', 200, 2),
    H('上海高毅资产管理合伙企业-高毅邻山1号', '私募基金', 100, 1),
    H('国家集成电路产业投资基金二期股份有限公司', '私募基金', 400, 4),
    H('中电海康集团有限公司', '投资公司', 5000, 50)
  ];

  it('按属性汇总市值与占比，并计算机构内份额', () => {
    const b = aggregateClasses(rows, { instOnly: true });
    const pub = b.find((x) => x.cls === 'public')!;
    expect(pub.count).toBe(2);
    expect(pub.value).toBe(500);
    expect(pub.ratio).toBe(5);
    const big = b.find((x) => x.cls === 'bigfund')!;
    expect(big.value).toBe(400);
    // 机构市值合计 = 300+200+100+400 = 1000
    expect(pub.instShare).toBeCloseTo(0.5, 6);
    expect(big.instShare).toBeCloseTo(0.4, 6);
    expect(institutionValue(b)).toBe(1000);
    expect(institutionRatio(b)).toBeCloseTo(10, 6);
  });

  it('instOnly=false 时保留产业资本，但不计入机构份额分母', () => {
    const b = aggregateClasses(rows);
    const ind = b.find((x) => x.cls === 'industrial')!;
    expect(ind.value).toBe(5000);
    expect(ind.instShare).toBe(0);
    expect(institutionValue(b)).toBe(1000);
  });

  it('输出顺序固定（不随市值排序跳动）', () => {
    const b = aggregateClasses(rows);
    const idx = (c: string) => b.findIndex((x) => x.cls === c);
    expect(idx('public')).toBeLessThan(idx('private'));
    expect(idx('private')).toBeLessThan(idx('bigfund'));
  });
});

describe('集中度', () => {
  it('等权 n 家 → HHI = 1/n', () => {
    const rows = Array.from({ length: 10 }, (_, i) => H(`机构${i}`, '基金', 100, 1));
    const c = concentration(rows);
    expect(c.hhi).toBeCloseTo(0.1, 8);
    expect(c.effectiveN).toBeCloseTo(10, 6);
    expect(c.top10).toBeCloseTo(1, 8);
  });

  it('单一机构控盘 → HHI 接近 1', () => {
    const rows = [H('某公募ETF', '基金', 990, 9), H('另一家', '基金', 10, 0.1)];
    const c = concentration(rows);
    expect(c.hhi).toBeGreaterThan(0.9);
    expect(c.top1).toBeCloseTo(0.99, 4);
  });

  it('排除产业资本与个人，空数据不崩', () => {
    const c = concentration([H('某某集团有限公司', '投资公司', 1000, 10)]);
    expect(c.hhi).toBe(0);
    expect(concentration([]).effectiveN).toBe(0);
  });
});

describe('机构持仓信号', () => {
  const base = {
    instRatio: 10,
    prevInstRatio: 10,
    holderNumChg: 0,
    hasBigfund: false,
    hasNational: false,
    publicRatio: 5,
    hhi: 0.1
  };

  it('中性输入落在 50 附近', () => {
    const s = instSignal(base);
    expect(s.score).toBeGreaterThan(45);
    expect(s.score).toBeLessThan(62);
    expect(s.tone).toBe('flat');
  });

  it('增持 + 户数下降 + 大基金在场 → 偏多且分数更高', () => {
    const good = instSignal({ ...base, instRatio: 25, prevInstRatio: 20, holderNumChg: -0.12, hasBigfund: true });
    const bad = instSignal({ ...base, instRatio: 2, prevInstRatio: 6, holderNumChg: 0.15 });
    expect(good.score).toBeGreaterThan(bad.score);
    expect(good.tone).toBe('bull');
    expect(bad.tone).toBe('bear');
    expect(good.reasons.length).toBeGreaterThan(2);
    expect(good.reasons.some((r) => r.text.includes('国家大基金'))).toBe(true);
  });

  it('分数被裁剪到 [0,100]，且每条理由都有可追溯的 delta', () => {
    const extreme = instSignal({
      instRatio: 90,
      prevInstRatio: 0,
      holderNumChg: -0.9,
      hasBigfund: true,
      hasNational: true,
      publicRatio: 80,
      hhi: 0.9
    });
    expect(extreme.score).toBeLessThanOrEqual(100);
    expect(extreme.score).toBeGreaterThanOrEqual(0);
    for (const r of extreme.reasons) expect(Number.isFinite(r.delta)).toBe(true);
  });
});

describe('工具函数', () => {
  it('格式化', () => {
    expect(yi(5.55e8)).toBe('5.55亿');
    expect(yi(2.2e12)).toBe('2.20万亿');
    expect(sharesText(1.5e8)).toBe('1.50亿股');
    expect(pct(0.0523)).toBe('5.23%');
  });

  it('报告期排序与上一期', () => {
    const periods = ['2024-12-31', '2026-06-30', '2025-09-30', '2026-06-30'];
    const desc = sortDatesDesc(periods);
    expect(desc).toEqual(['2026-06-30', '2025-09-30', '2024-12-31']);
    const asc = [...desc].reverse();
    expect(prevDate(asc, '2026-06-30')).toBe('2025-09-30');
    expect(prevDate(asc, '2024-12-31')).toBeNull();
  });
});

describe('行业分布工具', () => {
  it('直方图分箱与定位', () => {
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 10);
    expect(h.counts.reduce((a, b) => a + b, 0)).toBe(10);
    expect(h.binOf(0)).toBe(0);
    expect(h.binOf(9)).toBe(9);
    expect(h.binOf(100)).toBe(9); // 越界夹到末箱
    expect(h.labels.length).toBe(10);
  });

  it('全 0 / 空样本不崩', () => {
    const z = histogram([], 5);
    expect(z.counts.length).toBe(5);
    expect(z.counts.reduce((a, b) => a + b, 0)).toBe(0);
    const z2 = histogram([0, 0, 0], 3);
    expect(z2.counts[0]).toBe(3);
  });

  it('分位：严格小于的比例', () => {
    const vals = [1, 2, 3, 4, 5];
    expect(percentileRank(vals, 3)).toBeCloseTo(0.4, 6);
    expect(percentileRank(vals, 0)).toBe(0);
    expect(percentileRank(vals, 9)).toBe(1);
    expect(percentileRank([], 3)).toBe(0);
  });

  it('中位数与分位文案', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBe(0);
    expect(percentileText(0.95)).toBe('行业前 5%');
    expect(percentileText(0.62)).toBe('高于 62% 同行');
    expect(percentileText(0.15)).toBe('低于 85% 同行');
  });
});

/* 报告期口径：季报只披露前十大重仓，不能与半年报/年报直接比较 */
import { reportKind, sameKindPeriods, sameKindPrev } from '../src/data/institutions';

describe('报告期口径可比性', () => {
  const periods = [
    '2024-06-30',
    '2024-09-30',
    '2024-12-31',
    '2025-03-31',
    '2025-06-30',
    '2025-09-30',
    '2025-12-31',
    '2026-03-31',
    '2026-06-30'
  ];

  it('Q2/Q4 为全量披露，Q1/Q3 为季报', () => {
    expect(reportKind('2026-06-30')).toBe('full');
    expect(reportKind('2025-12-31')).toBe('full');
    expect(reportKind('2026-03-31')).toBe('partial');
    expect(reportKind('2026-09-30')).toBe('partial');
  });

  it('上一期取「最近的同口径期」，跨过相邻的异口径季度', () => {
    // 2026Q2 的上一期是 2025Q4（同为全量披露），而不是相邻的 2026Q1（季报）
    expect(sameKindPrev(periods, '2026-06-30')).toBe('2025-12-31');
    expect(sameKindPrev(periods, '2026-03-31')).toBe('2025-09-30');
    expect(sameKindPrev(periods, '2025-12-31')).toBe('2025-06-30');
    expect(sameKindPrev(periods, '2025-03-31')).toBe('2024-09-30');
  });

  it('没有更早的同口径期时返回 null', () => {
    expect(sameKindPrev(['2026-06-30'], '2026-06-30')).toBeNull();
    expect(sameKindPrev(periods, '2024-06-30')).toBeNull();
  });

  it('同口径期列表按升序过滤', () => {
    const full = sameKindPeriods(periods, '2026-06-30');
    expect(full).toEqual(['2024-06-30', '2024-12-31', '2025-06-30', '2025-12-31', '2026-06-30']);
    const partial = sameKindPeriods(periods, '2026-03-31');
    expect(partial).toEqual(['2024-09-30', '2025-03-31', '2025-09-30', '2026-03-31']);
  });
});
