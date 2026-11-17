// Statistics used by canary gates, shadow evals and reports.
import { mulberry32 } from './util.mjs';

export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// Two-proportion z-test: is rate B (new) greater than rate A (baseline)?
export function twoPropZ(errA, nA, errB, nB) {
  if (!nA || !nB) return { z: 0, pA: 0, pB: 0 };
  const pA = errA / nA, pB = errB / nB;
  const p = (errA + errB) / (nA + nB);
  const se = Math.sqrt(p * (1 - p) * (1 / nA + 1 / nB));
  const z = se === 0 ? (pB > pA ? 10 : 0) : (pB - pA) / se;
  return { z, pA, pB };
}

// Bootstrap 95% CI for a proportion and for a paired difference of proportions.
export function bootstrapCI(values, { iters = 2000, seed = 7 } = {}) {
  const rng = mulberry32(seed);
  const n = values.length;
  if (!n) return { mean: 0, lo: 0, hi: 0 };
  const ms = [];
  for (let i = 0; i < iters; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += values[Math.floor(rng() * n)];
    ms.push(s / n);
  }
  return { mean: mean(values), lo: percentile(ms, 2.5), hi: percentile(ms, 97.5) };
}

export function pairedDiffCI(a, b, opts) {
  // a, b: arrays of 0/1 on the same cases; returns CI of mean(b - a)
  return bootstrapCI(a.map((x, i) => b[i] - x), opts);
}
