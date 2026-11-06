import { describe, expect, it, beforeEach } from 'vitest';
import {
  DEFAULT_POLICY,
  HOST_POLICY,
  backoffMs,
  withinBudget,
  waitMs,
  isTradingNow,
  intervalFactor,
  effectiveInterval,
  canRequest,
  noteSuccess,
  noteFailure,
  getStats,
  resetStats,
  policyOf
} from '../src/data/rateLimit';
import { normalizeConfig, DEFAULT_CONFIG } from '../src/math/monitor';

/** 构造北京时间：2026-11-06 是周五 */
const bj = (y: number, m: number, d: number, hh: number, mm: number) =>
  Date.UTC(y, m - 1, d, hh - 8, mm, 0);

describe('退避与预算', () => {
  it('指数退避随失败次数翻倍且封顶', () => {
    expect(backoffMs(0, 15_000, 300_000, 0)).toBe(15_000);
    expect(backoffMs(1, 15_000, 300_000, 0)).toBe(30_000);
    expect(backoffMs(2, 15_000, 300_000, 0)).toBe(60_000);
    expect(backoffMs(8, 15_000, 300_000, 0)).toBe(300_000);
  });

  it('抖动不会让退避变短', () => {
    expect(backoffMs(2, 15_000, 300_000, 0.5)).toBeGreaterThanOrEqual(60_000);
  });

  it('每分钟预算：达到上限后不再放行', () => {
    const now = 1_000_000;
    const p = { minIntervalMs: 1000, maxConcurrent: 1, perMinute: 2 };
    expect(withinBudget([now - 10_000], p, now)).toBe(true);
    expect(withinBudget([now - 10_000, now - 5_000], p, now)).toBe(false);
    // 超过一分钟的旧记录不计入
    expect(withinBudget([now - 70_000, now - 10_000], p, now)).toBe(true);
  });

  it('waitMs 取「最小间隔」与「冷却」中较大者', () => {
    const now = 1_000_000;
    const p = { minIntervalMs: 10_000, maxConcurrent: 1, perMinute: 5 };
    expect(waitMs(now - 2_000, 0, p, now)).toBe(8_000);
    expect(waitMs(now - 20_000, now + 30_000, p, now)).toBe(30_000);
    expect(waitMs(now - 20_000, 0, p, now)).toBe(0);
  });
});

describe('交易时段与降频', () => {
  it('A 股盘中 / 午休 / 收盘判断', () => {
    expect(isTradingNow('CN', bj(2026, 11, 6, 10, 0))).toBe(true);
    expect(isTradingNow('CN', bj(2026, 11, 6, 12, 0))).toBe(false);
    expect(isTradingNow('CN', bj(2026, 11, 6, 14, 0))).toBe(true);
    expect(isTradingNow('CN', bj(2026, 11, 6, 16, 0))).toBe(false);
  });

  it('周末休市', () => {
    expect(isTradingNow('CN', bj(2026, 11, 7, 10, 0))).toBe(false);
    expect(isTradingNow('HK', bj(2026, 11, 8, 10, 0))).toBe(false);
  });

  it('日韩按北京时间偏移（东京/首尔 UTC+9）', () => {
    expect(isTradingNow('JP', bj(2026, 11, 6, 9, 0))).toBe(true);
    expect(isTradingNow('KR', bj(2026, 11, 6, 13, 0))).toBe(true);
    expect(isTradingNow('JP', bj(2026, 11, 6, 11, 0))).toBe(false); // 日本午休（北京 11:00）
  });

  it('美股冬令时 22:30 后开盘（北京时间）', () => {
    expect(isTradingNow('US', bj(2026, 11, 6, 23, 0))).toBe(true);
    expect(isTradingNow('US', bj(2026, 11, 6, 20, 0))).toBe(false);
  });

  it('休市 ×3、后台 ×4，同时命中取较大值', () => {
    expect(intervalFactor(['CN'], false, bj(2026, 11, 6, 10, 0))).toBe(1);
    expect(intervalFactor(['CN'], false, bj(2026, 11, 6, 16, 0))).toBe(3);
    expect(intervalFactor(['CN'], true, bj(2026, 11, 6, 10, 0))).toBe(4);
    expect(intervalFactor(['CN'], true, bj(2026, 11, 6, 16, 0))).toBe(4);
  });

  it('effectiveInterval 按倍率拉长且有上限', () => {
    expect(effectiveInterval(30, 1)).toBe(30);
    expect(effectiveInterval(30, 3)).toBe(90);
    expect(effectiveInterval(30, 4)).toBe(120);
    expect(effectiveInterval(10, 1)).toBe(10);
    expect(effectiveInterval(2000, 4)).toBeLessThanOrEqual(3600);
  });
});

describe('host 策略', () => {
  it('每个已知 host 都有合理的最小间隔与预算', () => {
    for (const [host, p] of Object.entries(HOST_POLICY)) {
      expect(p.minIntervalMs).toBeGreaterThanOrEqual(10_000);
      expect(p.perMinute).toBeGreaterThan(0);
      expect(p.maxConcurrent).toBeGreaterThan(0);
      expect(policyOf(host)).toBe(p);
    }
    expect(policyOf('unknown.example.com')).toBe(DEFAULT_POLICY);
  });
});

describe('前置熔断（公告类适配器）', () => {
  beforeEach(() => resetStats());

  it('失败后进入冷却，冷却期内 canRequest 为 false', () => {
    const host = 'np-anotice-stock.eastmoney.com';
    expect(canRequest(host)).toBe(true);
    noteFailure(host, new Error('HTTP 429'));
    expect(canRequest(host)).toBe(false);
    const s = getStats().find((x) => x.host === host)!;
    expect(s.consecutiveFailures).toBe(1);
    expect(s.cooldownUntil).toBeGreaterThan(Date.now());
    expect(s.lastError).toContain('429');
  });

  it('成功后重置连续失败与冷却', () => {
    const host = 'data.sec.gov';
    noteFailure(host, 'timeout');
    expect(canRequest(host)).toBe(false);
    noteSuccess(host, 120);
    const s = getStats().find((x) => x.host === host)!;
    expect(s.consecutiveFailures).toBe(0);
    expect(s.cooldownUntil).toBe(0);
    expect(s.lastLatency).toBe(120);
  });

  it('连续失败把冷却越拉越长', () => {
    const host = 'www.cls.cn';
    noteFailure(host, 'a');
    const first = getStats().find((x) => x.host === host)!.cooldownUntil - Date.now();
    noteFailure(host, 'b');
    const second = getStats().find((x) => x.host === host)!.cooldownUntil - Date.now();
    expect(second).toBeGreaterThan(first);
  });
});

describe('配置归一化（多源字段）', () => {
  it('默认策略是主源优先且启用自适应降频', () => {
    expect(DEFAULT_CONFIG.flashStrategy).toBe('primary');
    expect(DEFAULT_CONFIG.adaptive).toBe(true);
    expect(DEFAULT_CONFIG.crossEvery).toBeGreaterThan(0);
    expect(DEFAULT_CONFIG.verifyEvery).toBeGreaterThan(0);
  });

  it('非法策略回退 primary，间隔字段被夹住', () => {
    const c = normalizeConfig({ flashStrategy: 'nope' as 'primary', crossEvery: 999, verifyEvery: -3 });
    expect(c.flashStrategy).toBe('primary');
    expect(c.crossEvery).toBeLessThanOrEqual(60);
    expect(c.verifyEvery).toBe(0);
  });

  it('旧配置（没有多源字段）也能安全升级', () => {
    const c = normalizeConfig({ quoteInterval: 30, rules: { ...DEFAULT_CONFIG.rules } });
    expect(c.flashStrategy).toBe('primary');
    expect(c.adaptive).toBe(true);
  });
});
