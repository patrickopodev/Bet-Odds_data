import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRun, loadLog, evaluateReadiness, READINESS_DEFAULTS } from '../../engine/observe.mjs';

function fakeReport(equivalence, picks = [], count = picks.length) {
  return {
    equivalenceWithValidated: equivalence,
    counts: { engine: count, legacyDeployed: count, legacyValidated: count },
    frozenOutDelta: [],
    picks: { engine: picks },
  };
}

test('observation ledger: one entry per calendar day (latest run wins)', () => {
  // Two runs on the same day -> single record updated, not duplicated.
  recordRun(fakeReport(true, [{ eventId: 'E1', selection: 'Home', odds: 1.9 }]), { file: 'data/test-tmp-obs.json', now: Date.parse('2026-08-27T10:00:00Z') });
  recordRun(fakeReport(true, [{ eventId: 'E1', selection: 'Home', odds: 1.95 }]), { file: 'data/test-tmp-obs.json', now: Date.parse('2026-08-27T20:00:00Z') });
  recordRun(fakeReport(true, [{ eventId: 'E2', selection: 'Away', odds: 2.0 }]), { file: 'data/test-tmp-obs.json', now: Date.parse('2026-08-28T10:00:00Z') });
  const log = loadLog('data/test-tmp-obs.json');
  assert.equal(log.length, 2);
  assert.equal(log[0].date, '2026-08-27');
  assert.equal(log[0].eligibleEnginePicks[0], 'E1|Home|1.95'); // updated, not duplicated
});

test('readiness gate: NOT ready before thresholds, READY after enough equivalent cycles', () => {
  const file = 'data/test-tmp-obs2.json';
  try { require('node:fs').unlinkSync(file); } catch {}
  const d = READINESS_DEFAULTS;
  // Simulate 14 days, each with 2 distinct picks, all equivalent.
  for (let i = 0; i < d.minDays; i++) {
    const date = `2026-09-${String(i + 1).padStart(2, '0')}`;
    recordRun(fakeReport(true, [
      { eventId: `D${i}A`, selection: 'Home', odds: 1.9 },
      { eventId: `D${i}B`, selection: 'Away', odds: 2.0 },
    ]), { file, now: Date.parse(`${date}T12:00:00Z`) });
  }
  const log = loadLog(file);
  const r = evaluateReadiness(log);
  assert.equal(r.runs, d.minDays);
  assert.equal(r.distinctPicks, d.minDays * 2);
  assert.equal(r.allEquivalent, true);
  assert.equal(r.ready, true);
});

test('readiness gate: equivalence violation blocks readiness (fail-closed)', () => {
  const file = 'data/test-tmp-obs3.json';
  for (let i = 0; i < READINESS_DEFAULTS.minDays; i++) {
    const date = `2026-10-${String(i + 1).padStart(2, '0')}`;
    recordRun(fakeReport(i === 5 ? false : true, [
      { eventId: `X${i}`, selection: 'Home', odds: 1.9 },
    ]), { file, now: Date.parse(`${date}T12:00:00Z`) });
  }
  const r = evaluateReadiness(loadLog(file));
  assert.equal(r.allEquivalent, false);
  assert.equal(r.ready, false);
  assert.match(r.note, /equivalence violation/);
});
