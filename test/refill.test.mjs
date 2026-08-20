import test from 'node:test';
import assert from 'node:assert/strict';
import { refillSlip, selectBets, isFriendly, nextSlip, keepableSlips, keepableBets, groupSlips, normalizeSlip, SINGLE_ODDS_MIN, BUNDLE_ODDS_MIN, BUNDLE_SIZE } from '../stake.mjs';

function mkCand(marketId, outcome, odds, conf) {
  return { marketId, market: '1X2', outcome, odds, recommendedMinOdds: 1.2, recommended: true, confidence: conf };
}

function mkMatch(id, tournament, candidates) {
  return {
    match: { eventId: id, homeTeam: 'A', awayTeam: 'B', tournament, startTime: '' },
    candidates,
  };
}

function mkSlip(slipId, type, legs, extra = {}) {
  return {
    slipId,
    type,
    stake: 10,
    combinedOdds: legs.reduce((a, l) => a * (l.odds ?? 2.0), 1),
    status: 'pending',
    shareCode: null,
    legs,
    ...extra,
  };
}

function mkLeg(eventId, outcome, extra = {}) {
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
    ...extra,
  };
}

test('isFriendly shared by refill path', () => {
  assert.equal(isFriendly('WORLD: Club Friendly'), true);
  assert.equal(isFriendly('Premier League'), false);
});

test('groupSlips splits singles >=3.00 from bundles <=2.99', () => {
  const picks = [
    { match: mkMatch('m1', 'League', []).match, candidate: mkCand('1', 'Home', 3.5, 0.9) },
    { match: mkMatch('m2', 'League', []).match, candidate: mkCand('1', 'Home', 1.9, 0.85) },
    { match: mkMatch('m3', 'League', []).match, candidate: mkCand('1', 'Home', 1.6, 0.8) },
    { match: mkMatch('m4', 'League', []).match, candidate: mkCand('1', 'Home', 2.2, 0.7) },
  ];
  const slips = groupSlips(picks);
  // 1 single + 1 bundle of 3 (leftover bundles are placed: "whatever qualifies")
  assert.equal(slips.length, 2);
  assert.equal(slips[0].type, 'single');
  assert.equal(slips[0].legs.length, 1);
  assert.equal(slips[1].type, 'multi');
  assert.equal(slips[1].legs.length, 3);
});

test('groupSlips bundles up to BUNDLE_SIZE legs', () => {
  const picks = [];
  for (let i = 0; i < 9; i++) {
    picks.push({ match: mkMatch(`m${i}`, 'League', []).match, candidate: mkCand('1', 'Home', 1.8, 0.8) });
  }
  const slips = groupSlips(picks);
  assert.equal(slips.length, 3); // 4 + 4 + 1
  assert.equal(slips[0].legs.length, 4);
  assert.equal(slips[1].legs.length, 4);
  assert.equal(slips[2].legs.length, 1);
  assert.equal(BUNDLE_SIZE, 4);
  assert.equal(SINGLE_ODDS_MIN, 3.0);
  assert.equal(BUNDLE_ODDS_MIN, 1.25);
});

test('nextSlip preserves confirmed slips and never re-picks their matches', () => {
  const report = {
    matches: [
      mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 3.2, 0.9)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 2.0, 0.85)]),
      mkMatch('m3', 'Premier League', [mkCand('1', 'Home', 1.8, 0.8)]),
    ],
  };
  const existing = { stakePerSlip: 10, slips: [mkSlip('s1', 'single', [mkLeg('m1', 'Home', { status: 'confirmed' })], { status: 'confirmed' })] };
  const slip = nextSlip(existing, report);
  assert.equal(slip.preservedCount, 1);
  assert.equal(slip.slips.length, 2); // 1 preserved + 1 new bundle (m2+m3)
  assert.equal(slip.slips[0].status, 'confirmed');
  assert.equal(slip.slips[1].status, 'pending');
  assert.equal(slip.slips[1].type, 'multi');
  assert.deepEqual(slip.slips[1].legs.map((l) => l.eventId).sort(), ['m2', 'm3']);
});

test('nextSlip keeps the settled ledger without consuming capacity', () => {
  const report = {
    matches: [
      mkMatch('m4', 'Premier League', [mkCand('1', 'Home', 3.1, 0.9)]),
      mkMatch('m5', 'Premier League', [mkCand('1', 'Home', 2.0, 0.85)]),
    ],
  };
  const existing = {
    stakePerSlip: 10,
    slips: [
      mkSlip('s1', 'single', [mkLeg('m1', 'Home')], { status: 'settled', result: 'WON' }),
      mkSlip('s2', 'single', [mkLeg('m2', 'Home')], { status: 'confirmed' }),
      mkSlip('s3', 'single', [mkLeg('m3', 'Home')], { status: 'placed' }),
    ],
  };
  const slip = nextSlip(existing, report);
  assert.equal(slip.preservedCount, 3);
  assert.equal(slip.slips.length, 5); // 3 preserved + m4 single (3.1) + m5 bundle (2.0)
  assert.equal(slip.slips[0].status, 'settled');
  assert.equal(slip.slips[1].status, 'confirmed');
  assert.equal(slip.slips[2].status, 'placed');
  assert.equal(slip.slips[3].type, 'single'); // m4 3.1 -> alone
  assert.equal(slip.slips[3].legs[0].eventId, 'm4');
  assert.equal(slip.slips[4].type, 'multi'); // m5 2.0 -> bundle of one
  assert.equal(slip.slips[4].legs[0].eventId, 'm5');
});

test('refillSlip replaces a skipped slip, never re-picking the attempted combo', () => {
  const report = {
    matches: [
      mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 3.5, 0.9)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 2.1, 0.8)]),
    ],
  };
  const slip = { stakePerSlip: 10, slips: [mkSlip('s1', 'single', [mkLeg('m1', 'Home')], { status: 'skipped', error: 'odds drifted' })] };
  const { added, slips } = refillSlip(slip, report);
  assert.equal(added, 1);
  assert.equal(slips.length, 1);
  assert.equal(slip.slips.length, 1); // skipped pruned, one refilled
  assert.equal(slip.slips[0].legs[0].eventId, 'm2'); // m1 combo was attempted -> never re-picked
  assert.equal(slip.slips[0].status, 'pending');
});

test('refillSlip keeps placed slips and adds fresh ones', () => {
  const report = {
    matches: [
      mkMatch('m1', 'Premier League', [mkCand('1', 'Home', 3.4, 0.9)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 2.0, 0.85)]),
      mkMatch('m3', 'Premier League', [mkCand('1', 'Home', 1.9, 0.8)]),
      mkMatch('m4', 'Premier League', [mkCand('1', 'Home', 1.8, 0.7)]),
    ],
  };
  const slip = {
    stakePerSlip: 10,
    slips: [mkSlip('s1', 'single', [mkLeg('m1', 'Home')], { status: 'placed' }), mkSlip('s2', 'single', [mkLeg('m5', 'Home')], { status: 'skipped' })],
  };
  const { added } = refillSlip(slip, report);
  assert.equal(added, 1); // m2+m3+m4 -> one bundle replacing the skipped slot
  assert.equal(slip.slips.length, 2);
  assert.equal(slip.slips[0].status, 'placed');
  assert.equal(slip.slips[1].type, 'multi');
  assert.deepEqual(slip.slips[1].legs.map((l) => l.eventId).sort(), ['m2', 'm3', 'm4']);
});

test('refillSlip never picks friendlies', () => {
  const report = {
    matches: [mkMatch('m1', 'WORLD: Club Friendly', [mkCand('1', 'Home', 3.0, 0.95)])],
  };
  const slip = { stakePerSlip: 10, slips: [mkSlip('s1', 'single', [mkLeg('m1', 'Home')], { status: 'skipped' })] };
  const { added, exhausted } = refillSlip(slip, report);
  assert.equal(added, 0);
  assert.equal(exhausted, true);
  assert.equal(slip.slips.length, 1); // skipped record kept when nothing to refill
  assert.equal(slip.slips[0].status, 'skipped');
});

test('refillSlip ignores the settled ledger when computing capacity', () => {
  const report = {
    matches: [
      mkMatch('m3', 'Premier League', [mkCand('1', 'Home', 3.3, 0.9)]),
      mkMatch('m4', 'Premier League', [mkCand('1', 'Home', 2.0, 0.85)]),
    ],
  };
  const slip = {
    stakePerSlip: 10,
    slips: [mkSlip('s1', 'single', [mkLeg('m1', 'Home')], { status: 'settled', result: 'WON' }), mkSlip('s2', 'single', [mkLeg('m2', 'Home')], { status: 'skipped' })],
  };
  const { added } = refillSlip(slip, report);
  assert.equal(added, 2); // m3 single (3.3) + m4 bundle (2.0); settled ledger counts for nothing
  assert.equal(slip.slips.length, 3);
  assert.equal(slip.slips[0].status, 'settled'); // ledger untouched
  assert.equal(slip.slips[1].status, 'pending');
  assert.equal(slip.slips[2].status, 'pending');
});

test('keepableSlips/keepableBets drop only pending and skipped', () => {
  const slip = {
    slips: [
      mkSlip('s1', 'single', [mkLeg('m1', 'Home')], { status: 'pending' }),
      mkSlip('s2', 'single', [mkLeg('m2', 'Home')], { status: 'skipped' }),
      mkSlip('s3', 'single', [mkLeg('m3', 'Home')], { status: 'slip-ready', shareCode: 'ABC' }),
      mkSlip('s4', 'single', [mkLeg('m4', 'Home')], { status: 'placed' }),
      mkSlip('s5', 'single', [mkLeg('m5', 'Home')], { status: 'settled', result: 'LOST' }),
      mkSlip('s6', 'single', [mkLeg('m6', 'Home')], { status: 'cancelled' }),
      mkSlip('s7', 'single', [mkLeg('m7', 'Home')], { status: 'failed' }),
    ],
  };
  assert.deepEqual(keepableSlips(slip).map((s) => s.slipId), ['s3', 's4', 's5', 's6', 's7']);
  assert.deepEqual(keepableBets(slip).map((l) => l.eventId), ['m3', 'm4', 'm5', 'm6', 'm7']);
});

test('normalizeSlip migrates the legacy flat bets ledger to slips', () => {
  const legacy = {
    stakePerBet: 10,
    bets: [{ eventId: 'm1', homeTeam: 'A', awayTeam: 'B', odds: 2.0, stake: 10, status: 'settled', result: 'WON' }],
  };
  const norm = normalizeSlip(legacy);
  assert.equal(norm.slips.length, 1);
  assert.equal(norm.slips[0].type, 'single');
  assert.equal(norm.slips[0].status, 'settled');
  assert.equal(norm.slips[0].legs[0].eventId, 'm1');
  assert.equal(norm.stakePerSlip, 10);
});

test('selectBets still skips friendlies and caps trivial odds', () => {
  const report = {
    matches: [
      mkMatch('m1', 'WORLD: Club Friendly', [mkCand('1', 'Home', 3.0, 0.95)]),
      mkMatch('m2', 'Premier League', [mkCand('1', 'Home', 1.2, 0.99)]),
      mkMatch('m3', 'Premier League', [mkCand('1', 'Home', 2.1, 0.85)]),
    ],
  };
  const picks = selectBets(report);
  assert.equal(picks.length, 1);
  assert.equal(picks[0].match.eventId, 'm3');
});