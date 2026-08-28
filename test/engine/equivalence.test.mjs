import test from 'node:test';
import assert from 'node:assert/strict';
import { compareStrategyA } from '../../engine/equivalence.mjs';
import { loadRegistry } from '../../engine/strategies.mjs';
import { sampleDb, makeEvent } from './_fixtures.mjs';

test('equivalence: engine == legacy Strategy A at the validated band, on real-shaped data', () => {
  const future = '2030-01-01T12:00:00Z';
  // Mix of in-band (1.8-2.2), widened-only (1.5-1.8), simulated, resolved.
  const db = {
    events: {
      E1: makeEvent('E1', { sides: { Home: 1.95, Draw: 3.4, Away: 4.0 }, startTime: future }), // in band
      E2: makeEvent('E2', { sides: { Home: 3.0, Draw: 3.2, Away: 2.1 }, startTime: future }), // in band
      E3: makeEvent('E3', { sides: { Home: 4.0, Draw: 1.5, Away: 5.0 }, startTime: future }), // widened-only (1.5)
      E4: makeEvent('E4', { sides: { Home: 1.6, Draw: 3.3, Away: 4.2 }, startTime: future, isSimulated: true }),
      E5: makeEvent('E5', { sides: { Home: 1.9, Draw: 3.1, Away: 4.0 }, startTime: '2000-01-01T00:00:00Z', finalScore: '2-1' }),
    },
  };
  const report = compareStrategyA(db, { now: Date.parse('2029-01-01T00:00:00Z') });

  // Engine must equal legacy at the validated [1.8,2.2) band (the equivalence proof).
  assert.equal(report.equivalenceWithValidated, true);
  assert.equal(report.counts.engine, 2); // E1, E2
  assert.equal(report.counts.legacyValidated, 2);

  // The deployed 1.5 widening currently adds the E3 (1.5) pick in production...
  assert.equal(report.counts.legacyDeployed, 3);
  // ...which the band freeze removes from the engine. This delta is expected/by-design.
  assert.ok(report.frozenOutDelta.some((k) => k.startsWith('E3|')));
  // Simulated (E4) and resolved (E5) never reach any set.
  assert.ok(!report.picks.engine.some((p) => p.eventId === 'E4' || p.eventId === 'E5'));
});

test('equivalence harness reads frozen band from registry, never env', () => {
  process.env.FAV_BAND_LO = '1.0'; // hostile deployment value
  try {
    const registry = loadRegistry();
    const a = registry.strategies.find((s) => s.strategyId === 'STRAT-1X2-FAVBAND-v1');
    assert.equal(a.parameters.lo, 1.8); // engine band unaffected by env
  } finally {
    delete process.env.FAV_BAND_LO;
  }
});
