import test from 'node:test';
import assert from 'node:assert/strict';
import { manualExecute, autoExecute, buildSelections, assertExecutionParity } from '../../engine/executors.mjs';
import { selectApproved } from '../../engine/daily-engine.mjs';
import { loadRegistry } from '../../engine/strategies.mjs';
import { sampleDb } from './_fixtures.mjs';

// Stable outcome-id resolver (no network) for parity tests.
const resolver = (p) => `${p.marketId}_${p.selection.replace(/\s/g, '')}`;

test('execution parity: manual and auto derive identical selections (spec #13, #20)', async () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.ok(approved.length > 0);

  const manual = await manualExecute(approved, { resolveOutcomeId: resolver, createShareCode: null, writeLedger: false });
  const auto = await autoExecute(approved, { resolveOutcomeId: resolver, stakeAutoplaceEnabled: false });

  assertExecutionParity(manual.selections, auto.selections);
  assert.deepEqual(manual.selections, auto.selections);
  assert.equal(manual.stakes, false);
  // Auto with autoplace OFF must not stake.
  assert.equal(auto.stakes, false);
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

test('auto executor is fail-closed when autoplace enabled but no adapter', async () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const res = await autoExecute(approved, { resolveOutcomeId: resolver, stakeAutoplaceEnabled: true, placeStake: null });
  assert.equal(res.stakes, false);
  assert.equal(res.stakeResult?.reason, 'NO_STAKE_ADAPTER');
});

test('auto executor stakes only when enabled AND adapter provided', async () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  let staked = false;
  const placeStake = async () => { staked = true; return { staked: true }; };
  const res = await autoExecute(approved, { resolveOutcomeId: resolver, stakeAutoplaceEnabled: true, placeStake });
  assert.equal(res.stakes, true);
  assert.equal(staked, true);
});

test('buildSelections maps ApprovedPick -> share selection spec', () => {
  const picks = [{ matchId: 'E1', marketId: '18', selection: 'Over 2.5', line: 2.5 }];
  const sels = buildSelections(picks, resolver);
  assert.deepEqual(sels, [{ eventId: 'E1', marketId: '18', outcomeId: '18_Over2.5', specifier: '2.5' }]);
});
