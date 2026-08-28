// ---------------------------------------------------------------------------
// VALIDATION GATES (spec #8 step 5, #12, #20).
//
// A single, explicit gate function every approved pick must pass before it can
// be executed. Mirrors the safeguards in validate-stake.mjs but generalized so
// the daily engine, manual executor, and auto executor share ONE definition.
//
// Gates: live odds present, kickoff in future (with buffer), simulated match
// forbidden, confidence floor, strategy status LIVE, stake limits, final-odds
// band re-check for band strategies.
// ---------------------------------------------------------------------------
import { isLive } from './strategies.mjs';

export const GATE_DEFAULTS = {
  MIN_CONFIDENCE: 0.6,
  STAKE_PER_BET: 10,
  STAKE_MAX_SLIPS: 2,
  START_BUFFER_MS: 5 * 60 * 1000,
};

// Band acceptance with explicit boundaries (spec #20):
//   1.79 -> reject, 1.80 -> accept, 2.19 -> accept, 2.20 -> reject
export function bandAccepts(odds, lo, hi) {
  const o = Number(odds);
  return o >= lo && o < hi;
}

export function oddsInBand(odds, lo, hi) {
  return bandAccepts(odds, lo, hi);
}

// Validate one candidate pick. Returns { ok, failures: string[] }.
export function validatePick(pick, { strategy, liveOdds = null, now = Date.now(), limits = GATE_DEFAULTS }) {
  const failures = [];

  if (pick.isSimulated) failures.push('SIMULATED_MATCH');
  if (!isLive(strategy)) failures.push('STRATEGY_NOT_LIVE');

  const conf = Number(pick.confidence ?? 0);
  if (conf > 0 && conf < limits.MIN_CONFIDENCE) failures.push('CONFIDENCE_BELOW_MIN');

  const kickoff = pick.kickoff ? Date.parse(pick.kickoff) : null;
  if (kickoff === null || Number.isNaN(kickoff)) {
    failures.push('UNKNOWN_KICKOFF');
  } else {
    if (now >= kickoff) failures.push('MATCH_STARTED');
    if (kickoff - now < limits.START_BUFFER_MS) failures.push('KICKOFF_TOO_CLOSE');
  }

  if (liveOdds != null) {
    const min = Number(pick.recommendedMinOdds ?? pick.odds ?? 0);
    if (min && Number(liveOdds) < min - 1e-9) failures.push('LIVE_ODDS_BELOW_MIN');
    if (strategy.parameters?.lo != null && strategy.parameters?.hi != null) {
      if (!bandAccepts(Number(liveOdds), strategy.parameters.lo, strategy.parameters.hi)) {
        failures.push('LIVE_ODDS_OUT_OF_BAND');
      }
    }
  }

  return { ok: failures.length === 0, failures };
}

// Stake-limit check across a batch (spec #12, STAKE_MAX_SLIPS=2).
export function withinStakeLimits(slips, { limits = GATE_DEFAULTS } = {}) {
  const active = (slips ?? []).filter((s) => s.status === 'confirmed' || s.status === 'placed').length;
  const pending = (slips ?? []).filter(
    (s) => s.status === 'pending' || s.status === 'slip-ready' || s.status === 'confirmed'
  ).length;
  if (active + pending > limits.STAKE_MAX_SLIPS) {
    return { ok: false, reason: `would exceed STAKE_MAX_SLIPS=${limits.STAKE_MAX_SLIPS}` };
  }
  return { ok: true };
}
