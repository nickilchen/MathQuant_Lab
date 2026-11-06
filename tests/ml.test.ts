import { describe, expect, it } from 'vitest';
import {
  MLP,
  LogisticRegression,
  accuracyScore,
  aucScore,
  buildFeatures,
  confusionMatrix,
  fitScaler,
  applyScaler,
  mlPosition,
  mulberry32
} from '../src/math/ml';
import { genSyntheticBars } from '../src/data/synthetic';
import { SYMBOLS } from '../src/data/symbols';

describe('机器学习', () => {
  it('buildFeatures 产出 10 维特征与 0/1 标签', () => {
    const bars = genSyntheticBars(SYMBOLS[0], 300);
    const ds = buildFeatures(bars);
    expect(ds.X.length).toBeGreaterThan(100);
    expect(ds.X[0]).toHaveLength(10);
    expect(ds.y.every((v) => v === 0 || v === 1)).toBe(true);
    expect(ds.dates).toHaveLength(ds.X.length);
  });

  it('标准化后各列均值≈0', () => {
    const bars = genSyntheticBars(SYMBOLS[0], 300);
    const ds = buildFeatures(bars);
    const s = fitScaler(ds.X);
    const Z = applyScaler(ds.X, s);
    for (let j = 0; j < 10; j++) {
      const m = Z.reduce((a, row) => a + row[j], 0) / Z.length;
      expect(Math.abs(m)).toBeLessThan(1e-9);
    }
  });

  it('逻辑回归在可分离数据上收敛', () => {
    const rnd = mulberry32(1);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 200; i++) {
      const cls = i % 2;
      X.push([(rnd() - 0.5) * 0.5 + cls * 2, (rnd() - 0.5) * 0.5 - cls]);
      y.push(cls);
    }
    const lr = new LogisticRegression(2);
    lr.fit(X, y, 0.5, 400);
    const p = lr.predictProba(X);
    expect(accuracyScore(p, y)).toBeGreaterThan(0.95);
    expect(lr.lossHistory[lr.lossHistory.length - 1]).toBeLessThan(lr.lossHistory[0]);
  });

  it('MLP 损失下降且预测概率在 (0,1)', () => {
    const bars = genSyntheticBars(SYMBOLS[0], 300);
    const ds = buildFeatures(bars);
    const scaler = fitScaler(ds.X);
    const X = applyScaler(ds.X, scaler);
    const net = new MLP(10, 8, 42);
    net.fit(X, ds.y, { epochs: 60, lr: 0.05, batch: 32 });
    expect(net.lossHistory[net.lossHistory.length - 1]).toBeLessThan(net.lossHistory[0]);
    const p = net.predictProba(X);
    expect(p.every((v) => v > 0 && v < 1)).toBe(true);
    expect(net.featureImportance()).toHaveLength(10);
  });

  it('AUC / 混淆矩阵 / mlPosition 行为正确', () => {
    expect(aucScore([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    const c = confusionMatrix([0.9, 0.2, 0.8, 0.1], [1, 0, 0, 1]);
    expect(c).toEqual({ tp: 1, fp: 1, tn: 1, fn: 1 });
    const pos = mlPosition([0.9, 0.5, 0.1]);
    expect(pos[0]).toBeGreaterThan(0);
    expect(pos[1]).toBe(0);
    expect(pos[2]).toBeLessThan(0);
  });

  it('零成交量指数数据不崩溃（量能比降级为中性 0）', () => {
    // 东财源下的部分指数（如日经225）成交量全为 0
    const bars = genSyntheticBars(SYMBOLS[0], 300).map((b) => ({ ...b, volume: 0, amount: 0 }));
    const ds = buildFeatures(bars);
    expect(ds.X.length).toBeGreaterThan(100);
    // 第 9 列（量能比）应为 0 而非 Infinity
    for (const row of ds.X) {
      expect(Number.isFinite(row[8])).toBe(true);
      expect(row[8]).toBe(0);
    }
    const scaler = fitScaler(ds.X);
    const Z = applyScaler(ds.X, scaler);
    const net = new MLP(10, 8, 42);
    net.fit(Z, ds.y, { epochs: 20, lr: 0.05, batch: 32 });
    expect(net.lossHistory[net.lossHistory.length - 1]).toBeLessThan(net.lossHistory[0]);
  });
});
