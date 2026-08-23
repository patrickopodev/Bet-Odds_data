// Shared settlement/metrics (P4). Both the paper track (train-model-v5b.mjs)
// and the real-money track (monitor.js / resolve-results.mjs via evaluateOutcome)
// must compute ROI the same way, or paper profitability is meaningless. This
// module is the single source for those metrics; the outcome evaluator is
// re-exported from lib/common.mjs so every path uses one definition.

export function roi(pnls) {
  const n = pnls.length;
  return n ? pnls.reduce((s, x) => s + x, 0) / n : 0;
}

// Bootstrap confidence interval (2.5% / 97.5% percentiles) over the per-bet P&Ls.
export function ci(pnls, B = 2000) {
  const n = pnls.length;
  if (!n) return [0, 0];
  const rois = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += pnls[(Math.random() * n) | 0];
    rois.push(s / n);
  }
  rois.sort((a, b) => a - b);
  return [rois[Math.floor(B * 0.025)], rois[Math.floor(B * 0.975)]];
}

export { evaluateOutcome } from './common.mjs';
