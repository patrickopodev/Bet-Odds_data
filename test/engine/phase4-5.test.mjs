import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOutcomeId } from '../../engine/resolve-outcome.mjs';
import { manualExecute } from '../../engine/executors.mjs';
import { registerMarket, MARKETS, listMarketIds } from '../../engine/markets.mjs';
import { evaluatePromotionGate, proposePromotion } from '../../engine/promotion.mjs';

// --- Real bet-code generation via the engine (spec #11/#13) ---
const fakeResolver = (p) => `${p.marketId}_${p.selection.replace(/\s/g, '')}`;
const fakeCreate = async (sels) => ({ code: `CODE(${sels.length})` });

test('engine generates a share code from approved picks (manual, no stake)', async () => {
  const picks = [
    { pickId: 'p1', matchId: 'E1', marketId: '1', strategyId: 'STRAT-1X2-BAND-v1', selection: 'Home', odds: 1.95, line: null, kickoff: '2030-01-01T12:00:00Z', competition: 'L', confidence: 0.92, isSimulated: false, researchStatus: 'SEARCH_NO_RESULTS', recommendedMinOdds: 1.8, generatedAt: '2030-01-01T00:00:00Z', audit: { strategyStatus: 'VALIDATED', strategyParams: { lo: 1.8, hi: 2.2 }, validationGates: { ok: true, failures: [] }, executionMode: null, stake: null, result: null, pnl: null } },
  ];
  const res = await manualExecute(picks, { resolveOutcomeId: fakeResolver, createShareCode: fakeCreate, writeLedger: false });
  assert.equal(res.stakes, false);
  assert.equal(res.code, 'CODE(1)');
  assert.equal(res.picks[0].audit.executionMode, 'MANUAL');
});

test('resolveOutcomeId maps selection -> outcomeId via live catalog (fake)', async () => {
  const fakeFetch = async (eventId) => ({
    markets: [{ id: '1', outcomes: [{ id: '42', desc: 'Home' }] }],
  });
  const id = await resolveOutcomeId({ matchId: 'E1', marketId: '1', selection: 'Home' }, { fetchMarkets: fakeFetch });
  assert.equal(id, '42');
});

// --- Phase 5: add a 6th market by definition only ---
test('phase 5: a 6th market registers without changing execution', () => {
  const before = listMarketIds().length;
  const m = registerMarket({ id: '100', name: 'Corners', kind: 'corners', needsSpecifier: true });
  assert.equal(MARKETS['100'], m);
  assert.equal(listMarketIds().length, before + 1);
  // The new market has no strategy/selector; it must not appear in any LIVE pick
  // path. Execution parity + isolation tests elsewhere still hold.
  assert.equal(m.needsSpecifier, true);
});

// --- Promotion pipeline: proposal-only, never auto-promotes ---
test('promotion gate: eligible at >=30 resolved AND positive ROI but NOT auto-promoted', () => {
  const gate = evaluatePromotionGate({ resolved: 35, roi: 8.2 });
  assert.equal(gate.eligible, true);
  const proposal = proposePromotion('STRAT-OU-H1-v1', { resolved: 35, roi: 8.2 }, { file: 'data/test-promo.json' });
  assert.equal(proposal.autoPromoted, false);
  assert.match(proposal.gate.reason, /ELIGIBLE_FOR_HUMAN_REVIEW/);
});

test('promotion gate: below threshold is not eligible', () => {
  const gate = evaluatePromotionGate({ resolved: 12, roi: 5 });
  assert.equal(gate.eligible, false);
});
