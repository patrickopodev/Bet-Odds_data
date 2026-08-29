import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovedPick } from '../../engine/pick.mjs';
import { selectApproved, runEngine } from '../../engine/daily-engine.mjs';
import { validatePick } from '../../engine/validation.mjs';
import { loadRegistry, getStrategy } from '../../engine/strategies.mjs';
import { sampleDb } from './_fixtures.mjs';

test('research failure: BLOCKED is distinct from NO_RESULTS (spec #9, #20)', () => {
  assert.notEqual('SEARCH_BLOCKED', 'SEARCH_NO_RESULTS');
  // A blocked search must never be mistaken for "no information found" — both
  // are informational only and must NOT change the statistical selection.
  const registry = loadRegistry();
  const a = getStrategy(registry, 'STRAT-1X2-BAND-v1');
  const candidate = { eventId: 'E1', selection: 'Home', odds: 1.95, kickoff: '2030-01-01T12:00:00Z', league: 'L' };

  const blocked = buildApprovedPick({ strategy: a, candidate, researchStatus: 'SEARCH_BLOCKED' });
  const none = buildApprovedPick({ strategy: a, candidate, researchStatus: 'SEARCH_NO_RESULTS' });
  assert.equal(blocked.researchStatus, 'SEARCH_BLOCKED');
  assert.equal(none.researchStatus, 'SEARCH_NO_RESULTS');

  // Both picks select identically (research is informational, never feeds strategy).
  assert.equal(blocked.selection, none.selection);
  assert.equal(blocked.odds, none.odds);

  // Validation does not fail on BLOCKED (research is orthogonal to gates).
  const v = validatePick(blocked, { strategy: a, liveOdds: 1.95, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.equal(v.ok, true);
});

test('research status flows through the daily engine without changing selection', () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const researchStatus = { E1: 'SEARCH_BLOCKED' };
  const { approved } = selectApproved({ db, registry, researchStatus, now: Date.parse('2029-01-01T00:00:00Z') });
  const e1 = approved.find((p) => p.matchId === 'E1');
  assert.ok(e1, 'E1 still selected despite BLOCKED research');
  assert.equal(e1.researchStatus, 'SEARCH_BLOCKED');
});
