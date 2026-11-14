import { describe, expect, it } from 'vitest';
import {
  ANN_TAG_META,
  analyzeAnnouncements,
  classifyAnn,
  classifyJp,
  classifyKr,
  classifyUs,
  cleanAnnTitle,
  maxAmountYi,
  maxPct,
  scoreAnn,
  toSimplified,
  type AnnInput
} from '../src/math/stockNews';
import { canFetchAnn, isIndexCode, marketOf, toAnnCode } from '../src/data/stockNews';
import { jpCode } from '../src/data/stockNews/jp';
import { naverCode } from '../src/data/stockNews/kr';

const ann = (title: string, date = '2026-11-02', column?: string): AnnInput => ({
  id: title,
  title,
  date,
  column
});

describe('cleanAnnTitle', () => {
  it('去掉「公司名:」前缀与紧随的重复公司名', () => {
    expect(cleanAnnTitle('贵州茅台:贵州茅台关于召开2026年第三季度业绩说明会的公告', '贵州茅台')).toBe(
      '关于召开2026年第三季度业绩说明会的公告'
    );
  });

  it('没有前缀时原样返回', () => {
    expect(cleanAnnTitle('关于回购股份的公告', '某公司')).toBe('关于回购股份的公告');
  });
});

describe('classifyAnn 打标签', () => {
  it('回购', () => {
    const r = classifyAnn('关于回购公司股份的进展公告');
    expect(r.primary).toBe('buyback');
    expect(r.tone).toBe(1);
  });

  it('减持', () => {
    const r = classifyAnn('持股5%以上股东减持股份计划公告');
    expect(r.primary).toBe('reduce');
    expect(r.tone).toBe(-1);
  });

  it('增持', () => {
    const r = classifyAnn('关于股东增持公司股份的公告');
    expect(r.primary).toBe('increase');
    expect(r.tone).toBe(1);
  });

  it('中标 / 合同', () => {
    expect(classifyAnn('关于中标重大项目的中标公告').primary).toBe('contract');
    expect(classifyAnn('关于签订日常经营重大合同的公告').primary).toBe('contract');
  });

  it('获批 / 注册', () => {
    expect(classifyAnn('关于获得药品注册证书的公告').primary).toBe('approval');
  });

  it('立案处罚优先级最高', () => {
    const r = classifyAnn('关于收到中国证监会立案告知书的公告');
    expect(r.primary).toBe('risk');
    expect(r.tone).toBe(-1);
    expect(ANN_TAG_META.risk.priority).toBeGreaterThan(ANN_TAG_META.reduce.priority);
  });

  it('业绩类按措辞定方向', () => {
    const up = classifyAnn('2026年前三季度业绩预增公告');
    expect(up.primary).toBe('earnings');
    expect(up.tone).toBe(1);

    const down = classifyAnn('2026年业绩预减公告');
    expect(down.primary).toBe('earnings');
    expect(down.tone).toBe(-1);

    // 「业绩说明会」是会议通知，不是业绩本身，归 meeting
    const meeting = classifyAnn('关于召开2026年第三季度业绩说明会的公告');
    expect(meeting.primary).toBe('meeting');
    expect(meeting.tone).toBe(0);

    const report = classifyAnn('2026年第三季度报告');
    expect(report.primary).toBe('earnings');
  });

  it('解禁 / 质押 / 诉讼都算利空', () => {
    expect(classifyAnn('关于部分限售股上市流通的公告').primary).toBe('unlock');
    expect(classifyAnn('关于控股股东部分股份质押的公告').primary).toBe('pledge');
    expect(classifyAnn('关于涉及诉讼事项的公告').primary).toBe('lawsuit');
  });

  it('回购与减持同现时以减持为主（更强信号）', () => {
    const r = classifyAnn('关于股东减持及公司回购股份的公告');
    expect(r.primary).toBe('reduce');
    expect(r.tone).toBe(-1);
    expect(r.tags).toContain('buyback');
  });

  it('无命中记 other', () => {
    const r = classifyAnn('关于变更办公地址的公告');
    expect(r.primary).toBe('other');
    expect(r.tone).toBe(0);
  });

  it('公告分类可作为补充证据', () => {
    const r = classifyAnn('关于公司有关事项的公告', '股东减持');
    expect(r.primary).toBe('reduce');
  });
});

describe('金额与比例提取', () => {
  it('金额折算成亿', () => {
    expect(maxAmountYi('回购金额不超过 5 亿元')).toBeCloseTo(5);
    expect(maxAmountYi('投资 1.2 万亿')).toBeCloseTo(12000);
    expect(maxAmountYi('合同金额 3000 万元')).toBeCloseTo(0.3);
    expect(maxAmountYi('没有金额')).toBe(0);
  });

  it('比例取最大值', () => {
    expect(maxPct('拟减持不超过 3% 股份')).toBe(3);
    expect(maxPct('增持 0.5%~1%')).toBe(1);
  });
});

describe('scoreAnn 重要性', () => {
  const now = new Date('2026-11-03T00:00:00').getTime();

  it('越新越重要', () => {
    const fresh = scoreAnn(ann('关于股东减持股份的公告', '2026-11-02'), ['reduce'], now);
    const old = scoreAnn(ann('关于股东减持股份的公告', '2026-06-01'), ['reduce'], now);
    expect(fresh).toBeGreaterThan(old);
  });

  it('金额大、比例高会加分', () => {
    const big = scoreAnn(ann('关于回购 10 亿元股份的公告'), ['buyback'], now);
    const small = scoreAnn(ann('关于回购股份的公告'), ['buyback'], now);
    expect(big).toBeGreaterThan(small);
  });

  it('分数落在 0~100', () => {
    for (const t of ['立案调查', '回购', '变更办公地址']) {
      const s = scoreAnn(ann(t), [classifyAnn(t).primary], now);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(100);
    }
  });
});

describe('analyzeAnnouncements 聚合', () => {
  // 固定「今天」：时效加分会让立案 vs 中标 12 亿的排序随真实日期漂移，
  // 不固定 now 时这条用例会在数周后自行失效。
  const NOW = new Date('2026-11-03T00:00:00').getTime();
  const list: AnnInput[] = [
    ann('关于收到证监会立案告知书的公告', '2026-11-02'),
    ann('持股5%以上股东减持股份计划公告', '2026-11-01'),
    ann('关于回购公司股份的进展公告', '2026-10-28'),
    ann('关于中标 12 亿元项目的公告', '2026-10-20'),
    ann('关于召开2026年第三季度业绩说明会的公告', '2026-10-15'),
    ann('关于变更办公地址的公告', '2026-10-01')
  ];

  it('按重要性排序，立案排第一', () => {
    const r = analyzeAnnouncements(list, '某公司', NOW);
    expect(r.items[0].primary).toBe('risk');
    expect(r.items[0].score).toBeGreaterThanOrEqual(r.items[1].score);
  });

  it('统计多空与标签条数', () => {
    const r = analyzeAnnouncements(list, '某公司', NOW);
    expect(r.bull).toBe(2); // 回购 + 中标
    expect(r.bear).toBe(2); // 立案 + 减持
    expect(r.neutral).toBe(2); // 业绩说明 + 变更地址
    const total = r.counts.reduce((s, c) => s + c.count, 0);
    expect(total).toBe(list.length);
  });

  it('公司行为画像：回购/减持/增持/中标/立案各自计数', () => {
    const r = analyzeAnnouncements(list, '某公司', NOW);
    expect(r.behavior.buyback).toBe(1);
    expect(r.behavior.reduce).toBe(1);
    expect(r.behavior.contract).toBe(1);
    expect(r.behavior.risk).toBe(1);
    expect(r.behavior.increase).toBe(0);
  });

  it('只有减持没有回购增持时给出警示结论', () => {
    const r = analyzeAnnouncements([ann('关于股东减持股份的公告'), ann('关于变更办公地址的公告')], '某公司', NOW);
    expect(r.lines.join('')).toContain('产业资本在往外走');
  });

  it('有回购无减持时给出正面结论', () => {
    const r = analyzeAnnouncements([ann('关于回购公司股份的公告')], '某公司', NOW);
    expect(r.lines.join('')).toContain('公司自己在买');
  });

  it('空列表不崩', () => {
    const r = analyzeAnnouncements([]);
    expect(r.items).toEqual([]);
    expect(r.top).toBeNull();
    expect(r.lines).toEqual([]);
  });
});

describe('代码工具', () => {
  it('A 股代码提取', () => {
    expect(toAnnCode('sh600519')).toBe('600519');
    expect(toAnnCode('sz000001')).toBe('000001');
    expect(toAnnCode('bj830799')).toBe('830799');
    expect(toAnnCode('hk00700')).toBeNull();
    expect(toAnnCode('usAAPL')).toBeNull();
  });

  it('指数不查公告（sh000001 与平安银行 000001 会串）', () => {
    expect(isIndexCode('sh000001')).toBe(true);
    expect(isIndexCode('sz399001')).toBe(true);
    expect(canFetchAnn('sh000001')).toBe(false);
    expect(canFetchAnn('sh600519')).toBe(true);
    expect(canFetchAnn('hk00700')).toBe(true);
  });
});

/* ============ 港股：繁简归一 ============ */

describe('港股：繁体标题归一后打标', () => {
  it('繁简转换覆盖标签常用字', () => {
    expect(toSimplified('股份購回報告')).toBe('股份购回报告');
    expect(toSimplified('中期業績公告')).toBe('中期业绩公告');
    expect(toSimplified('股東減持')).toBe('股东减持');
    expect(toSimplified('自願公告')).toBe('自愿公告');
  });

  it('繁体回购判 buyback', () => {
    const r = classifyAnn('股份購回報告', '', 'HK');
    expect(r.primary).toBe('buyback');
    expect(r.tone).toBe(1);
  });

  it('繁体业绩判 earnings', () => {
    const r = classifyAnn('截至2026年6月30日止六個月中期業績公告', '', 'HK');
    expect(r.primary).toBe('earnings');
  });

  it('繁体减持判 reduce', () => {
    const r = classifyAnn('主要股東減持股份', '', 'HK');
    expect(r.primary).toBe('reduce');
    expect(r.tone).toBe(-1);
  });

  it('繁体供股判 placement', () => {
    const r = classifyAnn('建議按每持有兩股現有股份獲發一股供股股份', '', 'HK');
    expect(r.primary).toBe('placement');
  });

  it('繁体收购判 ma', () => {
    const r = classifyAnn('自願公告關於潛在收購事項', '', 'HK');
    expect(r.primary).toBe('ma');
  });

  it('A 股规则不受影响（简体照旧）', () => {
    expect(classifyAnn('关于回购公司股份的公告', '', 'CN').primary).toBe('buyback');
  });
});

/* ============ 美股：SEC form 映射 ============ */

describe('美股：SEC form 枚举映射', () => {
  it('8-K + 2.02 业绩', () => {
    const r = classifyUs('8-K', '2.02,9.01');
    expect(r.primary).toBe('earnings');
    expect(r.reason).toContain('2.02');
  });

  it('8-K + 5.02 高管变动', () => {
    expect(classifyUs('8-K', '5.02').primary).toBe('exec');
  });

  it('8-K + 1.01 重大协议', () => {
    expect(classifyUs('8-K', '1.01,9.01').primary).toBe('contract');
  });

  it('8-K + 2.01 完成收购', () => {
    expect(classifyUs('8-K', '2.01').primary).toBe('ma');
  });

  it('8-K 无 items 兜底为重大事件（中性）', () => {
    const r = classifyUs('8-K', '');
    expect(r.primary).toBe('material');
    expect(r.tone).toBe(0);
  });

  it('10-Q / 10-K 判业绩', () => {
    expect(classifyUs('10-Q', '').primary).toBe('earnings');
    expect(classifyUs('10-K', '').primary).toBe('earnings');
    expect(classifyUs('20-F', '').primary).toBe('earnings');
  });

  it('Form 4 判内部人交易且方向未知记中性', () => {
    const r = classifyUs('4', '');
    expect(r.primary).toBe('insider');
    expect(r.tone).toBe(0);
  });

  it('13D 判大额持股（举牌偏多但一期记中性）', () => {
    expect(classifyUs('SC 13D', '').primary).toBe('stake');
    expect(classifyUs('SC 13G/A', '').primary).toBe('stake');
  });

  it('144 拟出售判减持标签，但方向记中性（未必执行）', () => {
    const r = classifyUs('144', '');
    expect(r.primary).toBe('reduce');
    expect(r.tone).toBe(0);
  });

  it('增发注册判 placement 且偏空', () => {
    const r = classifyUs('424B5', '');
    expect(r.primary).toBe('placement');
    expect(r.tone).toBe(-1);
  });

  it('25-NSE 退市判风险', () => {
    expect(classifyUs('25-NSE', '').primary).toBe('risk');
  });

  it('classifyAnn 在 US 市场直接走 form 映射', () => {
    expect(classifyAnn('8-K', '2.02', 'US').primary).toBe('earnings');
    expect(classifyAnn('4', '', 'US').primary).toBe('insider');
  });
});

describe('市场路由', () => {
  it('识别 A 股 / 港股 / 美股', () => {
    expect(marketOf('sh600519')).toBe('CN');
    expect(marketOf('sz000001')).toBe('CN');
    expect(marketOf('hk00700')).toBe('HK');
    expect(marketOf('usAAPL')).toBe('US');
  });

  it('识别日股 / 韩股', () => {
    expect(marketOf('jp7203')).toBe('JP');
    expect(marketOf('kr005930')).toBe('KR');
  });

  it('指数与不支持的市场返回 null', () => {
    expect(marketOf('sh000001')).toBeNull();
    expect(marketOf('jpN225')).toBeNull();
    expect(marketOf('krKOSPI')).toBeNull();
    expect(marketOf('hkHSI')).toBeNull();
    expect(marketOf('tw2330')).toBeNull();
  });

  it('canFetchAnn 覆盖三个市场', () => {
    expect(canFetchAnn('sh600519')).toBe(true);
    expect(canFetchAnn('hk00700')).toBe(true);
    expect(canFetchAnn('usAAPL')).toBe(true);
    expect(canFetchAnn('jp7203')).toBe(true);
    expect(canFetchAnn('kr005930')).toBe(true);
    expect(canFetchAnn('sh000001')).toBe(false);
  });
});

describe('港股例行披露', () => {
  it('「翌日披露报表」记例行，不计入公司行为与多空', () => {
    const r = analyzeAnnouncements(
      [
        { id: '1', title: '翌日披露報表', date: '2026-11-02', market: 'HK' },
        { id: '2', title: '翌日披露報表 - 已發行股份變動及股份購回', date: '2026-11-01', market: 'HK' },
        { id: '3', title: '翌日披露報表 - 已發行股份變動', date: '2026-10-31', market: 'HK' },
        { id: '4', title: '股份購回報告', date: '2026-10-30', market: 'HK' }
      ],
      '腾讯控股'
    );
    expect(r.items.filter((i) => i.routine).length).toBe(3);
    // 只有非例行的那条算一次回购
    expect(r.behavior.buyback).toBe(1);
    // 例行披露沉底，头条不是它
    expect(r.items[0].routine).toBe(false);
    expect(r.lines.join('')).toContain('例行披露');
  });

  it('A 股不受例行规则影响', () => {
    const r = analyzeAnnouncements([{ id: '1', title: '关于回购公司股份的进展公告', date: '2026-11-02' }], '某公司');
    expect(r.items[0].routine).toBe(false);
    expect(r.behavior.buyback).toBe(1);
  });
});

/* ============ 日股：TDnet ============ */

describe('日股：TDnet 適時開示', () => {
  it('代码转换：5 位截成 4 位（Yahoo 口径）', () => {
    expect(jpCode('jp7203')).toBe('7203');
    expect(jpCode('jp72030')).toBe('7203');
    expect(jpCode('kr005930')).toBeNull();
  });

  it('決算短信 → 业绩', () => {
    const r = classifyJp('2027年３月期 第２四半期（中間期）決算短信〔日本基準〕（連結）');
    expect(r.primary).toBe('earnings');
  });

  it('自己株式の取得 → 回购', () => {
    const r = classifyJp('自己株式の取得に関するお知らせ');
    expect(r.primary).toBe('buyback');
    expect(r.tone).toBe(1);
  });

  it('公開買付 → 重组并购', () => {
    expect(classifyJp('株式会社○○に対する公開買付けの開始に関するお知らせ').primary).toBe('ma');
  });

  it('上方修正 → 业绩偏多，下方修正 → 偏空', () => {
    expect(classifyJp('通期業績予想の上方修正に関するお知らせ').tone).toBe(1);
    expect(classifyJp('通期業績予想の下方修正に関するお知らせ').tone).toBe(-1);
  });

  it('配当 → 分红', () => {
    expect(classifyJp('剰余金の配当に関するお知らせ').primary).toBe('dividend');
  });

  it('classifyAnn 在 JP 市场走日文规则', () => {
    expect(classifyAnn('自己株式の取得に関するお知らせ', '', 'JP').primary).toBe('buyback');
  });
});

/* ============ 韩股：Naver 新闻 ============ */

describe('韩股：Naver 新闻', () => {
  it('代码提取', () => {
    expect(naverCode('kr005930')).toBe('005930');
    expect(naverCode('jp7203')).toBeNull();
  });

  it('자사주 매입 → 回购', () => {
    const r = classifyKr('삼성전자, 자사주 매입 결정… 3조원 규모');
    expect(r.primary).toBe('buyback');
    expect(r.tone).toBe(1);
  });

  it('유상증자 → 定增（偏空）', () => {
    const r = classifyKr('○○바이오, 500억원 유상증자 결정');
    expect(r.primary).toBe('placement');
    expect(r.tone).toBe(-1);
  });

  it('실적 → 业绩，方向看措辞', () => {
    expect(classifyKr('삼성전자 3분기 실적 발표').primary).toBe('earnings');
    expect(classifyKr('3분기 영업이익 흑자 전환').tone).toBe(1);
    expect(classifyKr('3분기 실적 적자 지속').tone).toBe(-1);
  });

  it('불성실공시 → 立案处罚', () => {
    expect(classifyKr('○○전자 불성실공시법인 지정').primary).toBe('risk');
  });

  it('classifyAnn 在 KR 市场走韩文规则', () => {
    expect(classifyAnn('자사주 매입 공시', '', 'KR').primary).toBe('buyback');
  });
});
