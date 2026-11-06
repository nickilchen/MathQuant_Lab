import { describe, expect, it } from 'vitest';
import { analyzePosts, buzzScore, focusDistribution, popularityScore, scoreTitle, type PopularStock } from '../src/math/buzz';
import { parseGubaList, parseGubaMobile, parseTaoguList } from '../src/data/buzz';
import { md5Hex, parseFlashes } from '../src/data/cls';

const post = (title: string, read = 100, reply = 0, code = '600519') => ({
  code,
  name: '贵州茅台',
  title,
  read,
  reply,
  time: '11-02 10:00'
});

const pop = (pct: number, i = 0): PopularStock => ({
  code: String(600000 + i),
  name: `股票${i}`,
  rank: i + 1,
  rankChange: 0,
  pct,
  turnover: 1
});

describe('标题多空打分', () => {
  it('强词 / 弱词 / 中性', () => {
    expect(scoreTitle('今天要涨停了').tone).toBe(1);
    expect(scoreTitle('放量上攻，主升浪开启').tone).toBe(1);
    expect(scoreTitle('直接跌停，割肉离场').tone).toBe(-1);
    expect(scoreTitle('腰斩之后再腰斩').tone).toBe(-1);
    expect(scoreTitle('公司发布三季报').tone).toBe(0);
    expect(scoreTitle('').tone).toBe(0);
  });

  it('前置否定词翻转极性', () => {
    expect(scoreTitle('不会跌停').tone).toBe(1);
    expect(scoreTitle('别急着抄底').tone).toBe(-1);
    expect(scoreTitle('没有利空').tone).toBe(1);
  });

  it('强弱词权重叠加', () => {
    expect(scoreTitle('涨停').raw).toBe(2);
    expect(scoreTitle('上涨').raw).toBe(1);
    expect(scoreTitle('涨停又上涨').raw).toBe(3);
    expect(scoreTitle('涨停后跌停').raw).toBe(0); // +2 -2
  });
});

describe('热帖聚合', () => {
  it('多空计数与多空比', () => {
    const r = analyzePosts([post('涨停了'), post('继续上涨'), post('跌停'), post('发公告了')]);
    expect(r.bull).toBe(2);
    expect(r.bear).toBe(1);
    expect(r.neutral).toBe(1);
    expect(r.bullRatio).toBeCloseTo(2 / 3, 6);
    expect(r.score).toBeGreaterThan(50);
  });

  it('全中性时分数为 50、多空比为 null', () => {
    const r = analyzePosts([post('发布公告'), post('召开股东大会')]);
    expect(r.bullRatio).toBeNull();
    expect(r.score).toBeCloseTo(50, 6);
  });

  it('空样本不崩', () => {
    const r = analyzePosts([]);
    expect(r.posts).toEqual([]);
    expect(r.score).toBe(50);
    expect(r.bullRatio).toBeNull();
  });

  it('按热度排序，且热度 = 阅读 + 评论×20', () => {
    const r = analyzePosts([post('小热帖', 10, 0), post('爆款', 100000, 500), post('中帖', 100, 5)]);
    expect(r.posts[0].title).toBe('爆款');
    expect(r.posts[0].heat).toBe(100000 + 500 * 20);
    expect(r.posts[2].title).toBe('小热帖');
  });
});

describe('人气榜赚钱效应', () => {
  it('普涨高分、普跌低分', () => {
    const up = popularityScore(Array.from({ length: 30 }, (_, i) => pop(3 + (i % 3), i)));
    const down = popularityScore(Array.from({ length: 30 }, (_, i) => pop(-3 - (i % 3), i)));
    expect(up).toBeGreaterThan(70);
    expect(down).toBeLessThan(30);
  });

  it('空列表返回中性 50', () => {
    expect(popularityScore([])).toBe(50);
  });

  it('只看前 N 只', () => {
    const rows = [...Array.from({ length: 30 }, (_, i) => pop(5, i)), ...Array.from({ length: 30 }, (_, i) => pop(-9, i + 30))];
    expect(popularityScore(rows, 30)).toBeGreaterThan(70);
  });
});

describe('讨论维度合成', () => {
  it('两条线都缺时返回 null（维度不可用）', () => {
    expect(buzzScore(null, null)).toBeNull();
    expect(buzzScore([], analyzePosts([]))).toBeNull();
  });

  it('只有人气榜时退化为单因子', () => {
    const rows = Array.from({ length: 30 }, (_, i) => pop(4, i));
    const only = buzzScore(rows, null);
    expect(only).toBe(popularityScore(rows));
  });

  it('两者都有时按 6:4 加权', () => {
    const rows = Array.from({ length: 30 }, (_, i) => pop(4, i));
    const posts = analyzePosts([post('涨停'), post('涨停'), post('跌停')]);
    const p = popularityScore(rows);
    const expectVal = Math.round((p * 0.6 + posts.score * 0.4) * 10) / 10;
    expect(buzzScore(rows, posts)).toBeCloseTo(expectVal, 5);
  });
});

describe('关注度分箱', () => {
  it('0~100 分成 10 箱，左闭右开', () => {
    const { labels, counts } = focusDistribution([0, 10, 50, 99, 100]);
    expect(labels.length).toBe(10);
    expect(counts[0]).toBe(1); // 0 落在 [0,10)
    expect(counts[1]).toBe(1); // 10 落在 [10,20)
    expect(counts[5]).toBe(1); // 50
    expect(counts[9]).toBe(2); // 99 与 100 都夹到末箱
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5);
  });

  it('非法值忽略', () => {
    const { counts } = focusDistribution([Number.NaN, -5, 50]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(2);
  });
});

describe('股吧页面解析', () => {
  it('PC 列表页：提取标题/阅读/评论/时间', () => {
    const html = `
      <table><tbody>
        <tr class="listitem"><td><div class="read">1,234</div></td><td><div class="reply">56</div></td>
          <td><div class="title"><a data-postid="1" href="/news,600519,1.html">涨停了&amp;真香</a></div></td>
          <td><div class="author"><a href="#">张三</a></div></td><td><div class="update">11-02 10:00</div></td></tr>
        <tr class="listitem"><td><div class="read">8</div></td><td><div class="reply">0</div></td>
          <td><div class="title"><a href="/news,600519,2.html">要跌停？</a></div></td>
          <td><div class="author"><a href="#">李四</a></div></td><td><div class="update">11-02 09:30</div></td></tr>
      </tbody></table>`;
    const rows = parseGubaList(html, '600519', '贵州茅台');
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('涨停了&真香');
    expect(rows[0].read).toBe(1234);
    expect(rows[0].reply).toBe(56);
    expect(rows[0].time).toBe('11-02 10:00');
    expect(rows[1].title).toBe('要跌停？');
  });

  it('移动端：只解析标题，阅读/评论置 0', () => {
    const html = `
      <a href="https://mguba.eastmoney.com/mguba/article/0/1"><p class="title"> 李大霄：重磅信号来了 </p><p class="abstract">摘要</p></a>
      <a href="https://mguba.eastmoney.com/mguba/article/0/2"><p class="title">白酒全线反弹</p><p class="abstract">摘要</p></a>
      <a href="#"><p class="title">短</p></a>`;
    const rows = parseGubaMobile(html, '600519', '贵州茅台');
    expect(rows).toHaveLength(2); // 少于 4 字的标题被过滤
    expect(rows[0].title).toBe('李大霄：重磅信号来了');
    expect(rows[0].read).toBe(0);
    expect(rows[0].reply).toBe(0);
  });

  it('被验证码拦截时 PC 解析返回空，移动端仍可用', () => {
    const blocked = '<html><head><title>身份核实</title></head><body><div id="root"></div></body></html>';
    expect(parseGubaList(blocked, '600519', '贵州茅台')).toEqual([]);
  });
});

describe('淘股吧解析', () => {
  const html = `
    <div class="Nbbs-tiezi-lists">
      <div class="left middle-list-tittle fs15 c333 cursor overhide">
        <a class="overhide mw300" href="/a/2woCnIUqigr" title="打板第一天" target="_blank"> 打板第一天 </a>
        <span>&nbsp;(90)</span></div>
      <div class="left middle-list-talk overhide">160 / 4627</div>
      <div class="left middle-list-reply">11-02 15:44</div>
      <div class="left middle-list-post">11-02 15:11</div>
    </div>
    <div class="Nbbs-tiezi-lists">
      <div class="left middle-list-tittle"><a class="overhide mw300" href="/a/1ykAYf7pqOh" title="11月2日涨停复盘 &amp; 明日展望" target="_blank"> 11月2日涨停复盘 </a></div>
      <div class="left middle-list-talk overhide">14 / 247</div>
      <div class="left middle-list-post">11-02 15:21</div>
    </div>
    <div class="Nbbs-tiezi-lists"><div class="x">没有链接的广告块</div></div>`;

  it('提取标题/回复/阅读/时间，并跳过无链接块', () => {
    const rows = parseTaoguList(html);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe('打板第一天');
    expect(rows[0].reply).toBe(160);
    expect(rows[0].read).toBe(4627);
    expect(rows[0].time).toBe('11-02 15:11');
    expect(rows[0].name).toBe('淘股吧');
    expect(rows[1].title).toBe('11月2日涨停复盘 & 明日展望'); // 实体解码
  });

  it('与股吧帖子合并后按热度排序', () => {
    const rows = parseTaoguList(html);
    const r = analyzePosts([...rows, { code: '600519', name: '贵州茅台', title: '跌停', read: 10, reply: 0, time: '' }]);
    expect(r.posts.length).toBe(3);
    expect(r.posts[0].read).toBe(4627); // 热度最高的排最前（同为中性时）
  });
});

/* 财联社：MD5 与签名（Web Crypto 不提供 MD5，自带实现必须与标准一致） */
describe('财联社签名', () => {
  it('MD5 与标准向量一致', () => {
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5Hex('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5Hex('The quick brown fox jumps over the lazy dog')).toBe('9e107d9d372bb6826bd81d3542a419d6');
    expect(md5Hex('财联社')).toHaveLength(32); // 中文按 UTF-8
  });

  it('快讯去掉「财联社X月X日电，」前缀并打标', () => {
    const rows = parseFlashes([
      { id: 1, content: '财联社11月2日电，公司获批新药临床。', level: 'A', reading_num: 1200, ctime: 1793600000 },
      { id: 2, content: '财联社11月2日电，股东拟减持不超过 2%。', level: 'C', reading_num: 800 },
      { id: 3, content: '' }
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('公司获批新药临床。');
    expect(rows[0].level).toBe('A');
    expect(rows[0].read).toBe(1200);
    expect(rows[0].tone).toBe(1); // 获批 → 利好
    expect(rows[1].tone).toBe(-1); // 减持 → 利空
  });
});
