import test from 'node:test';
import assert from 'node:assert/strict';
import { bandAccepts, validatePick, GATE_DEFAULTS } from '../../engine/validation.mjs';
import { getStrategy, loadRegistry } from '../../engine/strategies.mjs';
import { selectApproved } from '../../engine/daily-engine.mjs';
import { sampleDb } from './_fixtures.mjs';

test('odds boundaries: 1.79 reject, 1.80 accept, 2.19 accept, 2.20 reject (spec #20)', () => {
  assert.equal(bandAccepts(1.79, 1.8, 2.2), false);
  assert.equal(bandAccepts(1.8, 1.8, 2.2), true);
  assert.equal(bandAccepts(2.19, 1.8, 2.2), true);
  assert.equal(bandAccepts(2.2, 1.8, 2.2), false);
});

test('simulation protection: isSimulated=true never stakes', () => {
  const registry = loadRegistry();
  const a = getStrategy(registry, 'STRAT-1X2-BAND-v1');
  const pick = {
    matchId: 'E1', marketId: '1', strategyId: a.strategyId, selection: 'Home', odds: 1.95,
    kickoff: '2030-01-01T12:00:00Z', confidence: 0.92, isSimulated: true, recommendedMinOdds: 1.8,
  };
  const v = validatePick(pick, { strategy: a, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.equal(v.ok, false);
  assert.ok(v.failures.includes('SIMULATED_MATCH'));

  // And the daily engine excludes simulated matches entirely.
  const db = sampleDb();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.ok(!approved.some((p) => p.matchId === 'E4'));
});

test('validation gates: confidence floor, kickoff buffer, live-odds band recheck', () => {
  const a = getStrategy(loadRegistry(), 'STRAT-1X2-BAND-v1');
  const base = { matchId: 'E1', marketId: '1', strategyId: a.strategyId, selection: 'Home', odds: 1.95, kickoff: '2030-01-01T12:00:00Z', confidence: 0.92, recommendedMinOdds: 1.8, isSimulated: false };

  // Confidence below MIN_CONFIDENCE (here artificially) fails.
  const low = validatePick({ ...base, confidence: 0.1 }, { strategy: a, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.ok(low.failures.includes('CONFIDENCE_BELOW_MIN'));

  // Kickoff too close fails.
  const soon = validatePick(base, { strategy: a, now: Date.parse('2030-01-01T11:58:00Z') });
  assert.ok(soon.failures.includes('KICKOFF_TOO_CLOSE'));

  // Live odds drifted out of band fails for a band strategy.
  const drift = validatePick(base, { strategy: a, liveOdds: 2.25, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.ok(drift.failures.includes('LIVE_ODDS_OUT_OF_BAND'));

  // All gates pass.
  const ok = validatePick(base, { strategy: a, liveOdds: 1.95, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.equal(ok.ok, true);
});
