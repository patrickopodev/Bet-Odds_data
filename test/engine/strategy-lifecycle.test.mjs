import test from 'node:test';
import assert from 'node:assert/strict';
import { LIFECYCLE, loadRegistry, getLiveStrategies, isLive, getStrategy, selectStrategy } from '../../engine/strategies.mjs';
import { selectApproved, summarizeByMarket } from '../../engine/daily-engine.mjs';
import { MARKETS, listMarketIds } from '../../engine/markets.mjs';
import { sampleDb } from './_fixtures.mjs';

test('market isolation: 1X2 strategy cannot select O/U', () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const a = getStrategy(registry, 'STRAT-1X2-BAND-v1');
  const cands = selectStrategy(a, { db });
  assert.ok(cands.length > 0);
  for (const c of cands) {
    // 1X2 favorite picks must carry marketId '1' only.
    assert.equal(c.line, null);
  }
  // No O/U pick (marketId 18) can ever come from the 1X2 strategy.
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  for (const p of approved) {
    if (p.strategyId === 'STRAT-1X2-BAND-v1') assert.equal(p.marketId, '1');
  }
});

test('strategy isolation: VALIDATED strategy produces live picks', () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const live = getLiveStrategies(registry).map((s) => s.strategyId);
  assert.ok(live.includes('STRAT-1X2-BAND-v1'), '1X2 band must be LIVE');
  assert.ok(live.includes('STRAT-OU-H1-v1'), 'O/U H1 must be LIVE');

  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.ok(approved.some((p) => p.strategyId === 'STRAT-1X2-BAND-v1'), '1X2 picks must appear in approved');
  assert.ok(approved.some((p) => p.strategyId === 'STRAT-OU-H1-v1'), 'O/U picks must appear in approved');
  assert.ok(approved.some((p) => p.marketId === '18'), 'O/U live picks must exist');
});

test('lifecycle: only VALIDATED/LIVE statuses are live; order is enforced', () => {
  const order = LIFECYCLE;
  assert.deepEqual(order.indexOf('DISCOVERED'), 0);
  assert.ok(order.indexOf('VALIDATED') < order.indexOf('LIVE'));
  assert.ok(order.indexOf('PAPER') < order.indexOf('ELIGIBLE_FOR_REVIEW'));

  const a = getStrategy(loadRegistry(), 'STRAT-1X2-BAND-v1');
  assert.ok(isLive(a));

  // Promotion rule: PAPER cannot jump straight to LIVE.
  const b = getStrategy(loadRegistry(), 'STRAT-OU-H1-v1');
  assert.equal(b.status, 'VALIDATED');
  assert.ok(isLive(b));
});

test('five-market output distinguishes market-exists from validated-strategy-exists', () => {
  const db = sampleDb();
  const registry = loadRegistry();
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const summary = summarizeByMarket({ db, registry, selectionResult: { approved }, now: Date.parse('2029-01-01T00:00:00Z') });
  const byId = Object.fromEntries(summary.map((m) => [m.marketId, m]));
  // 1X2 has a LIVE strategy.
  assert.equal(byId['1'].liveStrategy, 'STRAT-1X2-BAND-v1');
  // O/U has LIVE strategy STRAT-OU-H1-v1.
  assert.equal(byId['18'].liveStrategy, 'STRAT-OU-H1-v1');
  // No PAPER strategies remain; observing is empty.
  assert.equal(byId['18'].observing, '');
  // All five markets are enumerated.
  assert.deepEqual(listMarketIds().sort(), ['1', '18', '41', '548', '551']);
  for (const id of listMarketIds()) assert.ok(byId[id], `market ${id} (${MARKETS[id].name}) present in output`);
});
