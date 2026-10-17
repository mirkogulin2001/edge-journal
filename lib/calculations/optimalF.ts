// Optimal f (Ralph Vince): f that maximizes mean log(1 + f*R) over the empirical R-multiples.
// f is expressed in the same units as Kelly here: fraction of equity risked per 1R.

export function maxF(R: number[]): number {
  const worst = Math.min(...R);
  return worst < 0 ? 0.999 / Math.abs(worst) : 1;
}

export function meanLogGrowth(R: number[], f: number): number {
  let s = 0;
  for (const r of R) s += Math.log(1 + f * r);
  return s / R.length;
}

export function optimalF(R: number[]): number {
  let lo = 0;
  let hi = maxF(R);
  for (let k = 0; k < 60; k++) {
    const a = lo + (hi - lo) / 3;
    const b = hi - (hi - lo) / 3;
    if (meanLogGrowth(R, a) < meanLogGrowth(R, b)) lo = a;
    else hi = b;
  }
  return (lo + hi) / 2;
}

// Pre-drawn bootstrap indices, reused for every f so the bisection sees a monotonic DD(f).
export function drawPaths(n: number, horizon: number, sims: number): Int32Array {
  const idx = new Int32Array(sims * horizon);
  for (let i = 0; i < idx.length; i++) idx[i] = (Math.random() * n) | 0;
  return idx;
}

// VaR 95% of the max drawdown (positive fraction, e.g. 0.35 = 35%).
export function var95DD(
  R: number[],
  f: number,
  paths: Int32Array,
  horizon: number
): number {
  const sims = paths.length / horizon;
  const dds = new Float64Array(sims);
  for (let s = 0; s < sims; s++) {
    let eq = 1;
    let peak = 1;
    let worst = 0;
    const base = s * horizon;
    for (let i = 0; i < horizon; i++) {
      eq *= 1 + f * R[paths[base + i]];
      if (eq > peak) peak = eq;
      const dd = (eq - peak) / peak;
      if (dd < worst) worst = dd;
    }
    dds[s] = worst;
  }
  dds.sort();
  return -dds[Math.floor(0.05 * sims)];
}

export interface OptimalFResult {
  fOptimal: number;
  fFinal: number;
  ddAtOptimal: number;
  ddAtFinal: number;
  diluted: boolean;
}

export function optimalFWithDDLimit(
  R: number[],
  ddTarget: number,
  horizon: number,
  maxSims = 20000
): OptimalFResult {
  const sims = Math.max(2000, Math.min(maxSims, Math.floor(4_000_000 / horizon)));
  const paths = drawPaths(R.length, horizon, sims);
  const fOptimal = optimalF(R);
  const ddAtOptimal = var95DD(R, fOptimal, paths, horizon);

  if (ddAtOptimal <= ddTarget) {
    return { fOptimal, fFinal: fOptimal, ddAtOptimal, ddAtFinal: ddAtOptimal, diluted: false };
  }

  let lo = 0;
  let hi = fOptimal;
  for (let k = 0; k < 18; k++) {
    const m = (lo + hi) / 2;
    if (var95DD(R, m, paths, horizon) <= ddTarget) lo = m;
    else hi = m;
  }
  return {
    fOptimal,
    fFinal: lo,
    ddAtOptimal,
    ddAtFinal: var95DD(R, lo, paths, horizon),
    diluted: true,
  };
}
