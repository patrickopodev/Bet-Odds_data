import test from 'node:test';
import assert from 'node:assert/strict';
import { manualExecute, buildSelections, assertSelectionFidelity } from '../../engine/executors.mjs';
import { selectApproved } from '../../engine/daily-engine.mjs';
import { loadRegistry } from '../../engine/strategies.mjs';
import { sampleDb } from './_fixtures.mjs';

// Stable outcome-id resolver (no network) for parity tests.
const resolver = (p) => `${p.marketId}_${p.selection.replace(/\s/g, '')}`;

test('manual executor emits exactly the engine selection (no drop/alter, spec #20)', async () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.ok(approved.length > 0);

  const res = await manualExecute(approved, { resolveOutcomeId: resolver, createShareCode: null, writeLedger: false });

  // The executor must not reorder, skip, or rewrite a single pick.
  assert.deepEqual(res.selections, buildSelections(approved, resolver));
  assertSelectionFidelity(approved, resolver, res.selections);
});

test('manual executor never stakes (spec #11)', async () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const res = await manualExecute(approved, { resolveOutcomeId: resolver, createShareCode: null, writeLedger: false });
  assert.equal(res.stakes, false);
  assert.equal(res.mode, 'MANUAL');
  for (const p of res.picks) assert.equal(p.audit.executionMode, 'MANUAL');
});

test('buildSelections maps ApprovedPick -> share selection spec', () => {
  const picks = [{ matchId: 'E1', marketId: '18', selection: 'Over 2.5', line: 2.5 }];
  const sels = buildSelections(picks, resolver);
  assert.deepEqual(sels, [{ eventId: 'E1', marketId: '18', outcomeId: '18_Over2.5', specifier: '2.5' }]);
});
