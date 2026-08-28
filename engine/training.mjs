// ---------------------------------------------------------------------------
// TRAINING ISOLATION (spec #2, #20).
//
// Training uses a VIRTUAL bankroll only. It computes ROI / yield / hit rate /
// P&L / drawdown / average odds / confidence interval / sample size — and is
// FORBIDDEN from invoking the real staking adapter used by the auto path.
//
// This module imports ONLY pure metrics helpers + the existing selectors. It
// must never import the real staking path. The architecture test verifies that
// importing this module does not transitively pull in any execution adapter.
// ---------------------------------------------------------------------------
import { roi, ci } from '../lib/settlement.mjs';

// Virtual stake: never touches the network or real money. Returns a unit record.
export function virtualStake(_strategy, _pick, unit = 1) {
  return { kind: 'virtual', unit };
}

// Compute training metrics from a list of realized P&L records (1 unit/stake).
//   win  -> profit = odds - 1
//   loss -> profit = -1
export function trainingMetrics(pnls) {
  const n = pnls.length;
  const won = pnls.filter((p) => p > 0).length;
  const lost = pnls.filter((p) => p < 0).length;
  const voids = pnls.filter((p) => p === 0).length;
  const staked = won + lost;
  const pnl = pnls.reduce((a, b) => a + b, 0);
  const roiVal = staked ? roi(pnls) : 0;
  const hit = staked ? won / staked : 0;
  const [lo, hi] = staked ? ci(pnls) : [0, 0];

  // Drawdown on the cumulative P&L curve.
  let peak = 0;
  let drawdown = 0;
  let cum = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    drawdown = Math.min(drawdown, cum - peak);
  }

  return {
    sample: n,
    staked,
    won,
    lost,
    voids,
    pnl: Number(pnl.toFixed(4)),
    roi: Number((roiVal * 100).toFixed(2)),
    hitRate: Number((hit * 100).toFixed(2)),
    yield: Number((roiVal * 100).toFixed(2)),
    drawdown: Number(drawdown.toFixed(4)),
    ci: [Number((lo * 100).toFixed(2)), Number((hi * 100).toFixed(2))],
  };
}

// Run a training pass over (strategy, picks). Requires the stake function to be
// virtualStake — any other function throws (training isolation guard).
export function runTraining(strategies, picksByStrategy, { stakeFn = virtualStake } = {}) {
  if (stakeFn !== virtualStake) {
    throw new Error('TRAINING_ISOLATION: only virtualStake is permitted in training');
  }
  const out = {};
  for (const s of strategies) {
    const picks = picksByStrategy[s.strategyId] ?? [];
    const pnls = picks.map((p) => {
      const v = stakeFn(s, p);
      void v;
      // In training the realized pnl is supplied by the caller's settled set;
      // here we just record virtual unit stakes.
      return 0;
    });
    out[s.strategyId] = { ...trainingMetrics(pnls), virtual: true };
  }
  return out;
}
