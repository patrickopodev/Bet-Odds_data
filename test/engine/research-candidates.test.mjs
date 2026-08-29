import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, getLiveStrategies, getStrategy } from '../../engine/strategies.mjs';
import { runFeatureSet, compare1X2Enrichment } from '../../engine/backtest-harness.mjs';
import { buildH2HFromDb } from '../../lib/h2h.mjs';

test('M3: rejected candidate is excluded from live and frozen strategies untouched', () => {
  const reg = loadRegistry();
  const rejected = getStrategy(reg, 'STRAT-1X2-ODDSHIST-v1');
  assert.equal(rejected.status, 'REJECTED_CANDIDATE');
  assert.equal(rejected.validationStatus, 'BACKTESTED_NEGATIVE');
  const live = getLiveStrategies(reg).map((s) => s.strategyId);
  assert.ok(!live.includes('STRAT-1X2-ODDSHIST-v1'), 'rejected entry never live');
  // The two frozen (validated + paper) strategies are unchanged.
  assert.ok(getStrategy(reg, 'STRAT-1X2-BAND-v1').frozen);
  assert.ok(getStrategy(reg, 'STRAT-OU-H1-v1').frozen);
});

test('M4/M5: new research candidates are TRAINING (never LIVE) and safe', () => {
  const reg = loadRegistry();
  for (const id of ['STRAT-1X2-FORM-v1', 'STRAT-OU-GOALTOTAL-v1', 'STRAT-1X2-H2HFORM-v1']) {
    const s = getStrategy(reg, id);
    assert.equal(s.status, 'TRAINING', `${id} is training-only`);
    assert.ok(!getLiveStrategies(reg).includes(s), `${id} never enters live picks`);
  }
});

test('M5: H2H can be derived from the odds-db and exercises the h2h gate (not NO DATA)', () => {
  const db = {
    version: 1,
    events: {
      E1: { eventId: 'E1', homeTeam: 'Arsenal', awayTeam: 'Chelsea', startTime: '2026-01-01T00:00:00Z', finalScore: '2:1', outcomes: {} },
      E2: { eventId: 'E2', homeTeam: 'Arsenal', awayTeam: 'Chelsea', startTime: '2026-02-01T00:00:00Z', finalScore: '3:0', outcomes: {} },
      E3: { eventId: 'E3', homeTeam: 'Chelsea', awayTeam: 'Arsenal', startTime: '2026-03-01T00:00:00Z', finalScore: '1:1', outcomes: {} },
    },
  };
  const h2h = buildH2HFromDb(db);
  assert.equal(h2h.meetings.length, 3);
  // Feed it through the features path the harness expects.
  const features = {
    E1: { homeTeam: 'Arsenal', awayTeam: 'Chelsea', meetings: h2h.meetings.filter((m) => (m.home === 'Arsenal' && m.away === 'Chelsea') || (m.home === 'Chelsea' && m.away === 'Arsenal')), competition: null },
    E2: { homeTeam: 'Arsenal', awayTeam: 'Chelsea', meetings: h2h.meetings.filter((m) => (m.home === 'Arsenal' && m.away === 'Chelsea') || (m.home === 'Chelsea' && m.away === 'Arsenal')), competition: null },
    E3: { homeTeam: 'Chelsea', awayTeam: 'Arsenal', meetings: h2h.meetings.filter((m) => (m.home === 'Arsenal' && m.away === 'Chelsea') || (m.home === 'Chelsea' && m.away === 'Arsenal')), competition: null },
  };
  // With h2h meetings present, a 1X2 favourite that H2H favours must not be NO DATA.
  const r = runFeatureSet(db, { flags: { favBand: true, h2h: true }, features });
  assert.notEqual(r.verdict, 'NO DATA', 'h2h gate exercised once meetings are supplied');
});

test('M5: 1X2 H2H ablation never auto-promotes', () => {
  // Harness only reports; it must not flip a strategy status. getLiveStrategies
  // still excludes the H2H candidate regardless of a SIGNAL verdict.
  const reg = loadRegistry();
  assert.ok(!getLiveStrategies(reg).some((s) => s.strategyId === 'STRAT-1X2-H2HFORM-v1'));
});
