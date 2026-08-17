import test from 'node:test';
import assert from 'node:assert/strict';
import { refillSlip, selectBets, isFriendly, nextSlip, keepableBets } from '../stake.mjs';

function mkCand(marketId, outcome, odds, conf) {
  return { marketId, market: '1X2', outcome, odds, recommendedMinOdds: 1.2, recommended: true, confidence: conf };
}

function mkMatch(id, tournament, candidates) {
  return {
    match: { eventId: id, homeTeam: 'A', awayTeam: 'B', tournament, startTime: '' },
    candidates,
  };
}

function mkBet(eventId, outcome, extra = {}) {
  return {
    eventId,
    homeTeam: 'A',
    awayTeam: 'B',
    tournament: 'League',
    startTime: '',
    marketId: '1',
    market: '1X2',
    outcome,
    odds: 2.0,
    minOdds: 1.2,
    confidence: 0.9,
    stake: 10,
    status: 'pending',
    ...extra,
  };
}

test('refillSlip replaces a skipped bet, never re-picking the attempted combo', () => {
  const report = {
    matches: [
      mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 2.0, 0.9)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 2.1, 0.8)]),
    ],
  };
  const slip = { stakePerBet: 10, bets: [mkBet('m1', 'Home', { status: 'skipped', error: 'odds drifted' })] };
  const { added, bets } = refillSlip(slip, report);
  assert.equal(added, 1);
  assert.equal(bets.length, 1);
  assert.equal(slip.bets.length, 1); // skipped pruned, one refilled
  assert.equal(slip.bets[0].eventId, 'm2'); // m1 combo was attempted -> never re-picked
  assert.equal(slip.bets[0].status, 'pending');
});

test('refillSlip keeps placed bets and fills up to MAX_BETS', () => {
  const report = {
    matches: [
      mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 2.0, 0.9)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 2.1, 0.85)]),
      mkMatch('m3', 'Premier League', [mkCand('1', 'Home', 2.2, 0.8)]),
      mkMatch('m4', 'Premier League', [mkCand('1', 'Home', 2.3, 0.7)]),
    ],
  };
  const slip = {
    stakePerBet: 10,
    bets: [mkBet('m1', 'Home', { status: 'placed' }), mkBet('m2', 'Home', { status: 'skipped' })],
  };
  const { added, exhausted } = refillSlip(slip, report);
  assert.equal(added, 2); // MAX_BETS=3, one kept -> two slots to fill
  assert.equal(slip.bets.length, 3);
  assert.equal(exhausted, false); // capacity was filled exactly; more refill is possible if those skip
  assert.deepEqual(slip.bets.map((b) => b.eventId).sort(), ['m1', 'm3', 'm4']);
  assert.equal(slip.bets[0].status, 'placed'); // untouched
});

test('refillSlip never picks friendlies', () => {
  const report = {
    matches: [mkMatch('m1', 'WORLD: Club Friendly', [mkCand('1', 'Home', 2.0, 0.95)])],
  };
  const slip = { stakePerBet: 10, bets: [mkBet('m1', 'Home', { status: 'skipped' })] };
  const { added, exhausted } = refillSlip(slip, report);
  assert.equal(added, 0);
  assert.equal(exhausted, true);
  assert.equal(slip.bets.length, 1); // skipped record kept when nothing to refill
  assert.equal(slip.bets[0].status, 'skipped');
});

test('refillSlip stops at zero capacity', () => {
  const report = {
    matches: [mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 2.0, 0.9)])],
  };
  const slip = {
    stakePerBet: 10,
    bets: [mkBet('m1', 'Home', { status: 'placed' }), mkBet('m2', 'Home', { status: 'placed' }), mkBet('m3', 'Home', { status: 'placed' })],
  };
  const { added } = refillSlip(slip, report);
  assert.equal(added, 0);
  assert.equal(slip.bets.length, 3);
});

test('isFriendly shared by refill path', () => {
  assert.equal(isFriendly('WORLD: Club Friendly'), true);
  assert.equal(isFriendly('Premier League'), false);
});

test('nextSlip preserves confirmed bets and never re-picks their matches', () => {
  const report = {
    matches: [
      mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 2.0, 0.9)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 2.1, 0.85)]),
      mkMatch('m3', 'Premier League', [mkCand('1', 'Home', 2.2, 0.8)]),
    ],
  };
  const existing = { stakePerBet: 10, bets: [mkBet('m1', 'Home', { status: 'confirmed' })] };
  const slip = nextSlip(existing, report);
  assert.equal(slip.preservedCount, 1);
  assert.equal(slip.bets.length, 3); // 1 preserved + 2 new (MAX_BETS=3, confirmed counts toward capacity)
  assert.equal(slip.bets[0].status, 'confirmed');
  assert.deepEqual(slip.bets.slice(1).map((b) => b.status), ['pending', 'pending']);
  // m1 was already picked -> never re-selected
  assert.ok(!slip.bets.slice(1).some((b) => b.eventId === 'm1'));
  assert.deepEqual(slip.bets.slice(1).map((b) => b.eventId).sort(), ['m2', 'm3']);
});

test('nextSlip keeps the settled ledger without consuming capacity', () => {
  const report = {
    matches: [
      mkMatch('m4', 'Premier League', [mkCand('1', 'Home', 2.0, 0.9)]),
      mkMatch('m5', 'Premier League', [mkCand('1', 'Home', 2.1, 0.85)]),
    ],
  };
  const existing = {
    stakePerBet: 10,
    bets: [
      mkBet('m1', 'Home', { status: 'settled', result: 'WON' }),
      mkBet('m2', 'Home', { status: 'confirmed' }),
      mkBet('m3', 'Home', { status: 'placed' }),
    ],
  };
  const slip = nextSlip(existing, report);
  assert.equal(slip.preservedCount, 3);
  assert.equal(slip.bets.length, 4); // settled is ledger-only, doesn't block the one remaining slot
  assert.equal(slip.bets[0].status, 'settled');
  assert.equal(slip.bets[1].status, 'confirmed');
  assert.equal(slip.bets[2].status, 'placed');
  assert.equal(slip.bets[3].status, 'pending');
  assert.equal(slip.bets[3].eventId, 'm4');
});

test('nextSlip with no existing slip builds a fresh slip', () => {
  const report = {
    matches: [
      mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 2.0, 0.9)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 2.1, 0.8)]),
    ],
  };
  const slip = nextSlip(null, report);
  assert.equal(slip.preservedCount, 0);
  assert.equal(slip.bets.length, 2);
  assert.ok(slip.bets.every((b) => b.status === 'pending'));
});

test('keepableBets drops only pending and skipped', () => {
  const slip = {
    bets: [
      mkBet('m1', 'Home', { status: 'pending' }),
      mkBet('m2', 'Home', { status: 'skipped' }),
      mkBet('m3', 'Home', { status: 'slip-ready', shareCode: 'ABC' }),
      mkBet('m4', 'Home', { status: 'placed' }),
      mkBet('m5', 'Home', { status: 'settled', result: 'LOST' }),
      mkBet('m6', 'Home', { status: 'cancelled' }),
      mkBet('m7', 'Home', { status: 'failed' }),
    ],
  };
  assert.deepEqual(keepableBets(slip).map((b) => b.eventId), ['m3', 'm4', 'm5', 'm6', 'm7']);
});

test('refillSlip ignores the settled ledger when computing capacity', () => {
  const report = {
    matches: [
      mkMatch('m3', 'Premier League', [mkCand('1', 'Home', 2.0, 0.9)]),
      mkMatch('m4', 'Premier League', [mkCand('1', 'Home', 2.1, 0.85)]),
      mkMatch('m5', 'Premier League', [mkCand('1', 'Home', 2.2, 0.8)]),
    ],
  };
  const slip = {
    stakePerBet: 10,
    bets: [mkBet('m1', 'Home', { status: 'settled', result: 'WON' }), mkBet('m2', 'Home', { status: 'skipped' })],
  };
  const { added, exhausted } = refillSlip(slip, report);
  assert.equal(added, 3); // settled ledger counts for nothing; MAX_BETS=3 all free
  assert.equal(exhausted, false);
  assert.equal(slip.bets.length, 4);
  assert.equal(slip.bets[0].status, 'settled'); // ledger untouched
  assert.deepEqual(slip.bets.slice(1).map((b) => b.status), ['pending', 'pending', 'pending']);
});