import test from 'node:test';
import assert from 'node:assert/strict';
import { select1X2Picks, buildFavRows } from '../../lib/1x2.mjs';
import { loadRegistry } from '../../engine/strategies.mjs';
import { selectApproved } from '../../engine/daily-engine.mjs';
import { sampleDb, makeEvent } from './_fixtures.mjs';

// Strategy A regression (spec #6, #19, #23): the NEW engine must produce the
// EXACT same 1X2 favorite picks as the legacy selector it wraps, and it must
// use the FROZEN validated band [1.8, 2.2) — NOT the experimental 1.5 widening.
// Uses only clean upcoming events so the comparison isolates the 1X2_BAND logic
// itself; simulated/resolved exclusion is a separate (new) guard, tested below.
test('regression: new engine matches legacy 1X2_BAND selector on identical inputs', () => {
  // Clean DB: E1 (Home 1.95 in band), E2 (Away 2.10 in band), E3 (Draw 1.5 out of band).
  const future = '2030-01-01T12:00:00Z';
  const db = {
    events: {
      E1: makeEvent('E1', { sides: { Home: 1.95, Draw: 3.4, Away: 4.0 }, startTime: future }),
      E2: makeEvent('E2', { sides: { Home: 3.0, Draw: 3.2, Away: 2.1 }, startTime: future }),
      E3: makeEvent('E3', { sides: { Home: 4.0, Draw: 1.5, Away: 5.0 }, startTime: future }),
    },
  };
  const registry = loadRegistry();
  const strategyA = registry.strategies.find((s) => s.strategyId === 'STRAT-1X2-BAND-v1');
  assert.equal(strategyA.parameters.lo, 1.8);
  assert.equal(strategyA.parameters.hi, 2.2);

  // Legacy selector, using the validated band.
  const legacy = select1X2Picks(buildFavRows(db), 1.8, 2.2).map((r) => `${r.favName}@${r.favLast}`).sort();

  // New engine.
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const oneXtwo = approved.filter((p) => p.marketId === '1').map((p) => `${p.selection}@${p.odds}`).sort();

  assert.deepEqual(oneXtwo, legacy);
  // E1 Home 1.95 and E2 Away 2.10 are in-band; E3 Draw 1.5 is NOT (validated band).
  assert.deepEqual(oneXtwo, ['Away@2.1', 'Home@1.95']);
});

test('regression: engine ignores experimental BAND_LO=1.5 override (frozen 1.8 wins)', () => {
  // The deployed override widens lo to 1.5. The engine must NOT honor it.
  process.env.BAND_LO = '1.5';
  try {
    const db = sampleDb();
    const registry = loadRegistry();
    const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
    const selectedIds = approved.filter((p) => p.marketId === '1').map((p) => p.matchId);
    // E3 (Draw 1.5) would qualify under the 1.5 override but must be rejected by the frozen 1.8 spec.
    assert.ok(!selectedIds.includes('E3'), 'E3 (odds 1.5) must be excluded by frozen band [1.8,2.2)');
  } finally {
    delete process.env.BAND_LO;
  }
});

test('regression: simulated and resolved events are never selected', () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const ids = approved.map((p) => p.matchId);
  assert.ok(!ids.includes('E4'), 'simulated E4 must be excluded');
  assert.ok(!ids.includes('E5'), 'resolved E5 must be excluded');
});
