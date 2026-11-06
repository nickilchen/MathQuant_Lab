import { describe, expect, it } from 'vitest';
import { parseSinaTopHolders } from '../src/data/sources/sinaF10';
import { isValidCached } from '../src/data/institutions';

/** 按新浪真实页面的结构裁剪出的最小片段（GBK 页面解码后的文本形态） */
const HTML = `
<table width="100%" border="0" class="table2">
 <tr>
  <td><div align="center"><strong>截止日期:</strong></div></td>
  <td><div class="datelist"><ul><li><a href="#2026-06-30">2026-06-30</a></li></ul></div></td>
 </tr>
</table>
<table width="100%" border="0" class="table2">
 <tr class="tr_2"><td colspan="6" align="left" class="tdr">2026-06-30</td></tr>
 <tr class="tr_2"><td><div align="center"><strong>公告日期</strong></div></td><td colspan="5" class="tdr">2026-08-15</td></tr>
 <tr class="tr_2">
   <td><div align="center"><strong>编号</font></td>
   <td><div align="center"><strong>股东名称</font></td>
   <td width="80"><div align="center"><strong>持股数量(股)</strong></div></td>
   <td width="80"><div align="center"><strong>占流通股比例(%)</strong></div></td>
   <td width="80"><div align="center"><strong>股本性质</strong></div></td>
 </tr>
 <tr class="tr_2"><td><div align="center">1</div></td><td><div align="center">中国贵州茅台酒厂(集团)有限责任公司</div></td><td><div align="center">681282935</div></td><td><div align="center">54.499</div></td><td><div align="center">国有股</div></td></tr>
 <tr><td><div align="center">2</div></td><td><div align="center">香港中央结算有限公司</div></td><td><div align="center">53711656</div></td><td><div align="center">4.297</div></td><td><div align="center">境外法人股</div></td></tr>
 <tr class="tr_2"><td><div align="center">3</div></td><td><div align="center">中国人寿保险股份有限公司－传统－普通保险产品－005L－CT001沪</div></td><td><div align="center">5583897</div></td><td><div align="center">0.447</div></td><td><div align="center">境内法人股</div></td></tr>
</table>
<table width="100%" border="0" class="table2">
 <tr><td><div align="center"><strong>截止日期:</strong></div></td><td colspan="5" class="tdr">2026-03-31</td></tr>
 <tr class="tr_2">
   <td><div align="center"><strong>编号</font></td>
   <td><div align="center"><strong>股东名称</font></td>
   <td><div align="center"><strong>持股数量(股)</strong></div></td>
   <td><div align="center"><strong>占流通股比例(%)</strong></div></td>
   <td><div align="center"><strong>股本性质</strong></div></td>
 </tr>
 <tr><td><div align="center">1</div></td><td><div align="center">中国贵州茅台酒厂(集团)有限责任公司</div></td><td><div align="center">681282935</div></td><td><div align="center">54.499</div></td><td><div align="center">国有股</div></td></tr>
</table>
`;

describe('新浪十大流通股东解析', () => {
  it('按报告期分块，取到最新一期', () => {
    const blocks = parseSinaTopHolders(HTML);
    expect(blocks.length).toBe(2);
    expect(blocks[0].date).toBe('2026-06-30');
    expect(blocks[1].date).toBe('2026-03-31');
    expect(blocks[0].holders.length).toBe(3);
  });

  it('字段解析：名称 / 持股数 / 占比 / 股本性质', () => {
    const [latest] = parseSinaTopHolders(HTML);
    const first = latest.holders[0];
    expect(first.name).toBe('中国贵州茅台酒厂(集团)有限责任公司');
    expect(first.shares).toBe(681282935);
    expect(first.ratio).toBeCloseTo(54.499, 3);
    expect(first.nature).toBe('国有股');
    expect(latest.holders[1].nature).toBe('境外法人股');
  });

  it('跳过表头行（序号非数字）', () => {
    const [latest] = parseSinaTopHolders(HTML);
    expect(latest.holders.every((h) => h.name.length > 0)).toBe(true);
    expect(latest.holders.some((h) => h.name.includes('股东名称'))).toBe(false);
  });

  it('无数据时返回空数组，不抛错', () => {
    expect(parseSinaTopHolders('<html><body>暂无数据</body></html>')).toEqual([]);
    expect(parseSinaTopHolders('')).toEqual([]);
  });
});

/* ---------- 缓存结构校验（防止旧版本缓存把页面渲染打崩） ---------- */

describe('机构持仓缓存结构校验', () => {
  const good = {
    code: 'sh688981',
    name: '中芯国际',
    updatedAt: Date.now(),
    sources: { orgHold: 'eastmoney-dc', detail: 'eastmoney-dc', holderNum: 'eastmoney-f10', topHolders: 'eastmoney-f10' },
    degraded: false,
    periods: ['2026-06-30'],
    typePoints: [],
    summary: [],
    detailDate: '2026-06-30',
    detail: [],
    detailTotal: 0,
    prevDetailDate: null,
    prevDetail: [],
    prevDetailTotal: 0,
    holderNums: [],
    topHolders: [],
    topHolderDate: '2026-06-30',
    warnings: []
  };

  it('新结构通过', () => {
    expect(isValidCached(good)).toBe(true);
  });

  it('旧版结构（没有 sources / degraded / topHolders）被拒绝', () => {
    // 这正是线上「Cannot read properties of undefined (reading 'orgHold')」的来源
    const legacy = {
      code: 'sh688981',
      name: '中芯国际',
      periods: ['2026-06-30'],
      typePoints: [],
      summary: [],
      detailDate: '2026-06-30',
      detail: [],
      detailTotal: 0,
      holderNums: [],
      topFreeHolders: [],
      warnings: []
    };
    expect(isValidCached(legacy)).toBe(false);
  });

  it('缺字段 / 类型错误一律拒绝', () => {
    expect(isValidCached(null)).toBe(false);
    expect(isValidCached([])).toBe(false);
    expect(isValidCached({ ...good, topHolders: undefined })).toBe(false);
    expect(isValidCached({ ...good, degraded: 'no' })).toBe(false);
    expect(isValidCached({ ...good, sources: null })).toBe(false);
  });
});
