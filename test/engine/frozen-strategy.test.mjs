import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, getStrategy, selectStrategy } from '../../engine/strategies.mjs';
import { runEngine } from '../../engine/daily-engine.mjs';
import { sampleDb } from './_fixtures.mjs';

test('frozen strategy: registry params are immutable and match the validated spec', () => {
  const registry = loadRegistry();
  const a = getStrategy(registry, 'STRAT-1X2-FAVBAND-v1');
  assert.equal(a.frozen, true);
  // Validated band is [1.8, 2.2); the experimental 1.5 widening is excluded.
  assert.equal(a.parameters.lo, 1.8);
  assert.equal(a.parameters.hi, 2.2);
  assert.equal(a.parameters.confidence, 0.92);
  assert.equal(a.status, 'VALIDATED');

  const b = getStrategy(registry, 'STRAT-OU-H1-v1');
  assert.equal(b.parameters.line, 2.5);
  assert.equal(b.parameters.lo, 1.8);
  assert.equal(b.parameters.hi, 2.2);
  assert.equal(b.parameters.gate, 30);
});

test('frozen strategy: a daily run never mutates the registry (spec #20)', () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const before = JSON.parse(JSON.stringify(registry));

  runEngine({ db, registry, write: false, now: Date.parse('2029-01-01T00:00:00Z') });

  // The registry object passed in must be unchanged by the run.
  assert.deepEqual(registry, before);

  // And re-selecting still uses the original frozen params (no drift).
  const a = getStrategy(registry, 'STRAT-1X2-FAVBAND-v1');
  const cands = selectStrategy(a, { db });
  assert.ok(cands.every((c) => c.odds >= 1.8 && c.odds < 2.2));
});

test('frozen strategy: status cannot change during a daily run (no DISCOVERED->LIVE)', () => {
  const registry = loadRegistry();
  const a = getStrategy(registry, 'STRAT-1X2-FAVBAND-v1');
  // Mutating status at runtime would be the leakage the spec forbids; the engine
  // reads status at selection time, so we assert a tampered copy is what would
  // change behavior (documenting that the caller must not mutate mid-run).
  const tampered = JSON.parse(JSON.stringify(registry));
  tampered.strategies[0].status = 'DISCOVERED';
  const { approved: liveApproved } = runEngine({ db: sampleDb(), registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const { approved: tamperedApproved } = runEngine({ db: sampleDb(), registry: tampered, now: Date.parse('2029-01-01T00:00:00Z') });
  // With status DISCOVERED, the strategy is no longer LIVE -> zero approved picks.
  assert.ok(liveApproved.length > 0);
  assert.equal(tamperedApproved.length, 0);
});
