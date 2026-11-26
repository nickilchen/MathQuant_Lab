import { describe, expect, it } from 'vitest';
import {
  GENERAL_SYSTEM_PROMPT,
  snapshotToFactsText,
  type GeneralSnapshot
} from '../src/ai/general';
import { DEFAULT_AI_CONFIG, chatUrl, maskKey, validateAiConfig } from '../src/ai/config';

const snap = (): GeneralSnapshot => ({
  module: '技术面体检',
  symbol: '贵州茅台',
  facts: [
    { label: '评分', value: '72 / 100' },
    { label: 'RSI', value: '68.3' },
    { label: 'MACD', value: 'DIF 2.31 / DEA 1.85' }
  ],
  note: '技术面评的是指标状态，不是方向'
});

describe('通用 AI 只读分析师', () => {
  it('system prompt 明确禁止改参数与切标的', () => {
    expect(GENERAL_SYSTEM_PROMPT).toContain('不能');
    expect(GENERAL_SYSTEM_PROMPT).toContain('不允许');
    expect(GENERAL_SYSTEM_PROMPT).toContain('快照未提供');
    expect(GENERAL_SYSTEM_PROMPT).toContain('不构成投资建议');
  });

  it('事实文本包含标的、模块、全部事实与口径说明', () => {
    const t = snapshotToFactsText(snap());
    expect(t).toContain('贵州茅台');
    expect(t).toContain('技术面体检');
    expect(t).toContain('评分：72 / 100');
    expect(t).toContain('RSI：68.3');
    expect(t).toContain('口径说明：技术面评的是指标状态，不是方向');
    expect(t).toContain('唯一可信数据源');
  });

  it('无标的名与口径时也能生成文本，不出现 undefined', () => {
    const t = snapshotToFactsText({ module: '波动率模型', facts: [{ label: 'α', value: '0.08' }] });
    expect(t).not.toContain('undefined');
    expect(t).toContain('波动率模型');
    expect(t).toContain('α：0.08');
  });
});

describe('AI 配置隐私与校验', () => {
  it('默认配置 Key 为空，需用户自行填写', () => {
    expect(DEFAULT_AI_CONFIG.apiKey).toBe('');
  });

  it('掩码不泄露完整 Key，短 Key 全遮', () => {
    const masked = maskKey('sk-abcdefghijklmnop');
    expect(masked).toContain('****');
    expect(masked.startsWith('sk-a')).toBe(true);
    expect(masked.endsWith('mnop')).toBe(true);
    expect(masked).not.toBe('sk-abcdefghijklmnop');
    expect(maskKey('abc')).toBe('***');
    expect(maskKey('')).toBe('');
  });

  it('校验只针对本机配置字段，不依赖任何服务端状态', () => {
    expect(validateAiConfig(DEFAULT_AI_CONFIG)).toContain('Key');
    expect(validateAiConfig({ ...DEFAULT_AI_CONFIG, apiKey: 'k' })).toBeNull();
  });

  it('chat 地址由用户填写的 baseUrl 派生，拼接合规', () => {
    expect(chatUrl({ ...DEFAULT_AI_CONFIG, baseUrl: 'https://api.deepseek.com/' })).toBe(
      'https://api.deepseek.com/chat/completions'
    );
  });
});
