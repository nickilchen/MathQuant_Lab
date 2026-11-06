/**
 * GARCH(1,1) 拟极大似然估计（方差目标法 + 网格搜索 + 局部细化）
 *   sigma2_t = omega + alpha * eps_{t-1}^2 + beta * sigma2_{t-1}
 *   omega = var_hat * (1 - alpha - beta)   （方差目标，减少一维搜索）
 *
 * 注意：内部递推为日频；返回的 sigma / forecast 已年化（×√252），
 * 以便与 realizedVol 等年化口径指标直接比较。
 */
import { linspace, mean, variance } from './stats';

const SQRT252 = Math.sqrt(252);

export interface GarchResult {
  omega: number;
  alpha: number;
  beta: number;
  /** 条件波动率序列（与输入等长，sigma[0] 为回溯初值） */
  sigma: number[];
  /** 一步预测条件波动率 */
  forecast: number;
  loglik: number;
  persistence: number;
}

export function fitGarch11(returns: number[], demean = true): GarchResult {
  const n = returns.length;
  const m = demean ? mean(returns) : 0;
  const eps = returns.map((x) => x - m);
  const vbar = Math.max(variance(eps), 1e-12);

  const qmle = (a: number, b: number): { ll: number; sigma: number[] } => {
    const om = vbar * (1 - a - b);
    if (om <= 0) return { ll: -Infinity, sigma: [] };
    const sigma = new Array(n).fill(0);
    let s2 = vbar;
    let ll = 0;
    for (let t = 0; t < n; t++) {
      sigma[t] = Math.sqrt(s2);
      ll += -0.5 * (Math.log(2 * Math.PI * s2) + (eps[t] * eps[t]) / s2);
      s2 = om + a * eps[t] * eps[t] + b * s2;
    }
    return { ll, sigma };
  };

  let bestA = 0.08;
  let bestB = 0.9;
  let best = qmle(bestA, bestB);
  const as = linspace(0.02, 0.25, 24);
  const bs = linspace(0.55, 0.96, 21);
  for (const a of as) {
    for (const b of bs) {
      if (a + b >= 0.995) continue;
      const r = qmle(a, b);
      if (r.ll > best.ll) {
        best = r;
        bestA = a;
        bestB = b;
      }
    }
  }

  // 局部细化两轮
  const stepA = (as[1] - as[0]) / 2;
  const stepB = (bs[1] - bs[0]) / 2;
  for (let round = 0; round < 3; round++) {
    let improved = false;
    for (const da of [-stepA, 0, stepA]) {
      for (const db of [-stepB, 0, stepB]) {
        const a = bestA + da;
        const b = bestB + db;
        if (a <= 0.001 || b <= 0.01 || a + b >= 0.995) continue;
        const r = qmle(a, b);
        if (r.ll > best.ll + 1e-9) {
          best = r;
          bestA = a;
          bestB = b;
          improved = true;
        }
      }
    }
    if (!improved) break;
  }

  const om = vbar * (1 - bestA - bestB);
  // 一步预测：从最后条件方差继续递推
  let s2 = best.sigma.length ? best.sigma[best.sigma.length - 1] ** 2 : vbar;
  s2 = om + bestA * eps[n - 1] * eps[n - 1] + bestB * s2;

  return {
    omega: om,
    alpha: bestA,
    beta: bestB,
    sigma: best.sigma.map((s) => s * SQRT252),
    forecast: Math.sqrt(s2) * SQRT252,
    loglik: best.ll,
    persistence: bestA + bestB
  };
}
