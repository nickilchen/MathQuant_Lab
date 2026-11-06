import { describe, expect, it } from 'vitest';
import { DEFAULT_MOM, buildMomentumReport, type MomParams } from '../src/math/momentum';
import { buildActionPlan } from '../src/math/action';
import { DEFAULT_BT } from '../src/math/backtest';
import { DEFAULT_AI_CONFIG, chatUrl, maskKey, normalizeBaseUrl, validateAiConfig } from '../src/ai/config';
import { buildSnapshot, snapshotToText } from '../src/ai/context';
import { SYSTEM_PROMPT, buildMessages } from '../src/ai/agent';
import { firstToolCall, mergeParams } from '../src/ai/tools';
import type { Bar } from '../src/data/types';

const barsOf = (closes: number[]): Bar[] =>
  closes.map((c, i) => ({
    date: '2024-' + String(i + 1).padStart(4, '0'),
    open: c,
    close: c,
    high: c,
    low: c,
    volume: 1,
    amount: 1
  }));

const P = (patch: Partial<MomParams> = {}): MomParams => ({ ...DEFAULT_MOM, ...patch });
const closes = Array.from({ length: 400 }, (_, i) => 100 * Math.pow(1.002, i));

const makeSnap = () => {
  const p = P();
  const report = buildMomentumReport(barsOf(closes), p, DEFAULT_BT);
  const plan = buildActionPlan(report, p);
  const snap = buildSnapshot({
    code: 'sh600519',
    name: '贵州茅台',
    marketLabel: 'A股',
    source: 'tencent',
    report,
    plan,
    params: p
  });
  return { p, report, plan, snap };
};

describe('AI 配置', () => {
  it('规范化地址与拼接 chat 路径', () => {
    expect(normalizeBaseUrl(' https://api.deepseek.com/ ')).toBe('https://api.deepseek.com');
    expect(chatUrl({ ...DEFAULT_AI_CONFIG, baseUrl: 'https://api.deepseek.com' })).toBe(
      'https://api.deepseek.com/chat/completions'
    );
    expect(chatUrl({ ...DEFAULT_AI_CONFIG, baseUrl: 'https://x.cn/v1' })).toBe('https://x.cn/v1/chat/completions');
    expect(chatUrl({ ...DEFAULT_AI_CONFIG, baseUrl: 'https://x.cn/v1/chat/completions' })).toBe(
      'https://x.cn/v1/chat/completions'
    );
    expect(chatUrl({ ...DEFAULT_AI_CONFIG, baseUrl: '' })).toBe('');
  });

  it('缺字段时给出人话错误', () => {
    expect(validateAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: '' })).toContain('Key');
    expect(validateAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: 'k', baseUrl: '' })).toContain('地址');
    expect(validateAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: 'k', baseUrl: 'ftp://x' })).toContain('http');
    expect(validateAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: 'k' })).toBeNull();
  });

  it('掩码不泄露完整 Key', () => {
    expect(maskKey('')).toBe('');
    expect(maskKey('short')).toBe('*****');
    const m = maskKey('sk-1234567890abcdef');
    expect(m.startsWith('sk-1')).toBe(true);
    expect(m.endsWith('cdef')).toBe(true);
    expect(m).not.toContain('234567890ab');
  });
});

describe('事实快照', () => {
  it('数字全部来自计算结果，不含 undefined/NaN', () => {
    const { snap } = makeSnap();
    const text = snapshotToText(snap);
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('NaN');
    expect(text).toContain('sh600519');
    expect(text).toContain('最新收盘');
    expect(text).toContain('动量强度分');
    expect(snap.bars).toBe(400);
    expect(snap.price).toBeGreaterThan(0);
  });

  it('把触发价与参数写进快照，便于模型引用', () => {
    const { snap } = makeSnap();
    expect(snap.triggers.length).toBeGreaterThan(0);
    expect(snap.params.lookback).toBe(DEFAULT_MOM.lookback);
    const text = snapshotToText(snap);
    expect(text).toContain('触发价');
    expect(text).toContain('回看 ' + DEFAULT_MOM.lookback + ' 日');
  });
});

describe('消息组装', () => {
  it('system 含角色约束与事实快照，历史截断到 6 轮', () => {
    const { snap } = makeSnap();
    const history = Array.from({ length: 10 }, (_, i) => ({ role: 'user' as const, content: 'q' + i }));
    const msgs = buildMessages({
      cfg: { ...DEFAULT_AI_CONFIG, apiKey: 'k' },
      snapshot: snap,
      history,
      question: '现在能买吗'
    });
    expect(msgs[0].content).toBe(SYSTEM_PROMPT);
    expect(msgs[0].content).toContain('只能使用');
    expect(msgs[1].content).toContain('事实快照');
    expect(msgs[1].content).toContain('sh600519');
    expect(msgs.filter((m) => m.role === 'user').length).toBe(7);
    expect(msgs[msgs.length - 1].content).toBe('现在能买吗');
  });
});

describe('工具调用', () => {
  it('解析合法工具调用', () => {
    const tc = firstToolCall({
      tool_calls: [{ function: { name: 'set_momentum_params', arguments: '{"entry":0.05,"exit":-0.05}' } }]
    });
    expect(tc).not.toBeNull();
    expect(tc!.name).toBe('set_momentum_params');
    expect(tc!.args.entry).toBe(0.05);
  });

  it('未知工具、坏 JSON、空响应都返回 null 而不抛错', () => {
    expect(firstToolCall({ tool_calls: [{ function: { name: 'rm_rf', arguments: '{}' } }] })).toBeNull();
    expect(firstToolCall({ tool_calls: [{ function: { name: 'switch_symbol', arguments: '{bad' } }] })).toEqual({
      name: 'switch_symbol',
      args: {}
    });
    expect(firstToolCall(null)).toBeNull();
    expect(firstToolCall({})).toBeNull();
  });

  it('参数合并会夹到合法区间，并报告实际变化', () => {
    const cur = P();
    const { next, changed } = mergeParams(cur, { entry: 9, exit: -9, cap: 0.5, lookback: 'x' });
    expect(next.entry).toBeLessThanOrEqual(0.5);
    expect(next.exit).toBeGreaterThanOrEqual(-0.5);
    expect(next.cap).toBe(0.5);
    expect(next.lookback).toBe(cur.lookback);
    expect(changed).toContain('cap');
  });

  it('非法值被忽略，不产生变化', () => {
    const cur = P();
    const { next, changed } = mergeParams(cur, { entry: NaN, skip: Infinity, maLen: '200' });
    expect(next).toEqual(cur);
    expect(changed).toEqual([]);
  });
});
