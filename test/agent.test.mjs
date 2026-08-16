import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateOutcome as tsEvaluate, historicalStats, outcomeHistory } from '../dist/db.js';
import { evaluateOutcome as jsEvaluate } from '../analyze-odds.mjs';
import { analyzeCandidate, candidateSources, buildRecommendations } from '../dist/analysis.js';
import { selectBets, isFriendly } from '../stake.mjs';
import { resolveOutcome } from '../dist/sporty.js';
import { writeReport } from '../dist/monitor.js';

test('TS evaluateOutcome agrees with the JS analyzer (1X2 + O/U)', () => {
  const cases = [
    ['1', 'Home', { home: 2, away: 1 }],
    ['1', 'Draw', { home: 1, away: 1 }],
    ['1', 'Away', { home: 0, away: 3 }],
    ['18', 'Over 2.5', { home: 2, away: 1 }],
    ['18', 'Under 2.5', { home: 1, away: 1 }],
    ['18', 'Under 2', { home: 1, away: 1 }],
    ['548', '1-2', { home: 1, away: 1 }],
    ['548', 'No goal', { home: 0, away: 0 }],
    ['548', '7+', { home: 5, away: 2 }],
  ];
  for (const [m, n, s] of cases) {
    assert.equal(tsEvaluate(m, n, s), jsEvaluate(m, n, s), `${m} ${n}`);
  }
});

test('outcomeHistory matches the current odds band, not the whole outcome', () => {
  const stats = historicalStats({
    events: {
      a: {
        eventId: 'a',
        homeTeam: 'A',
        awayTeam: 'B',
        startTime: '',
        finalScore: '2:1',
        outcomes: {
          o1: { marketId: '1', name: 'Home', plays: [{ odds: 1.9 }, { odds: 2.0 }, { odds: 1.95 }] },
        },
      },
      b: {
        eventId: 'b',
        homeTeam: 'C',
        awayTeam: 'D',
        startTime: '',
        finalScore: '0:3',
        outcomes: {
          o1: { marketId: '1', name: 'Home', plays: [{ odds: 5.5 }] },
        },
      },
    },
  });
  // At current odds 2.0 the band [1.5, 2.6] covers the 1.9/2.0/1.95 plays (3 settled, all won).
  const near = outcomeHistory(stats, '1', 'Home', 2.0);
  assert.equal(near.settled, 3);
  assert.equal(near.winRate, 1);
  // At current odds 6.0 the band [4.5, 7.8] covers only the 5.5 play (1 sample → winRate null).
  const far = outcomeHistory(stats, '1', 'Home', 6.0);
  assert.equal(far.settled, 1);
  assert.equal(far.winRate, null);
});

test('candidateSources reads per-outcome marketIds from latest.json shape', () => {
  const m = {
    eventId: 'x',
    markets: {
      '1X2 / O/U': {
        marketId: '1+18',
        name: '1X2 / O/U',
        outcomes: [
          { name: 'Home', odds: 2.1, active: true, marketId: '1' },
          { name: 'Away', odds: 3.2, active: false, marketId: '1' },
          { name: 'Over 2.5', odds: 1.9, active: true, marketId: '18' },
        ],
      },
    },
  };
  const srcs = candidateSources(m);
  assert.equal(srcs.length, 2);
  assert.ok(srcs.every((s) => s.marketId === '1' || s.marketId === '18'));
});

test('analyzeCandidate only recommends sensible value', () => {
  const stats = historicalStats({ events: {} });
  const match = {
    eventId: 'x',
    homeTeam: 'A',
    awayTeam: 'B',
    tournament: 'T',
    startTime: '',
    venue: null,
    h2h: null,
    home: { name: 'A', flashscoreId: null, flashscoreUrl: null, position: 1, played: null, points: null, form: 'WWWWW', formScore: 15, lastResults: [], venue: null, research: [] },
    away: { name: 'B', flashscoreId: null, flashscoreUrl: null, position: 18, played: null, points: null, form: 'LLLLL', formScore: 0, lastResults: [], venue: null, research: [] },
  };
  const c = analyzeCandidate(match, { marketId: '1', name: '1X2', outcome: 'Home', odds: 1.6, active: true }, stats);
  assert.equal(c.recommended, true);
  assert.ok(c.confidence >= 0.5);
  const long = analyzeCandidate(match, { marketId: '1', name: '1X2', outcome: 'Away', odds: 9.0, active: true }, stats);
  assert.equal(long.recommended, false);
});

test('buildRecommendations keeps today matches and fills market names', () => {
  const matches = [
    {
      eventId: 'x',
      homeTeam: 'A',
      awayTeam: 'B',
      startTime: new Date(Date.now() + 3600_000).toISOString(),
      matchStatus: '',
      tournament: 'League',
      markets: {
        s: { marketId: '1+18', name: '1X2 / O/U', outcomes: [{ name: 'Home', odds: 1.9, active: true, marketId: '1' }] },
      },
    },
  ];
  const researched = [
    {
      eventId: 'x',
      homeTeam: 'A',
      awayTeam: 'B',
      tournament: 'League',
      startTime: matches[0].startTime,
      venue: null,
      h2h: null,
      home: { name: 'A', flashscoreId: 'id1', flashscoreUrl: 'a', position: 1, played: null, points: null, form: 'WWWWW', formScore: 15, lastResults: [], venue: null, research: [] },
      away: { name: 'B', flashscoreId: 'id2', flashscoreUrl: 'b', position: 18, played: null, points: null, form: 'LLLLL', formScore: 0, lastResults: [], venue: null, research: [] },
    },
  ];
  const recs = buildRecommendations(researched, matches, { events: {} }, (mid) => (mid === '1' ? '1X2' : mid));
  assert.equal(recs.length, 1);
  assert.ok(recs[0].candidates.some((c) => c.market === '1X2'));
});

test('selectBets skips friendlies unless allowed and caps at MAX_BETS', () => {
  assert.equal(isFriendly('WORLD: Club Friendly'), true);
  assert.equal(isFriendly('Premier League'), false);

  const mk = (id, tourney, outcome, odds, conf) => ({
    match: { eventId: id, homeTeam: 'A', awayTeam: 'B', tournament: tourney, startTime: '', home: {}, away: {} },
    candidates: [{ marketId: '1', market: '1X2', outcome, odds, recommendedMinOdds: 1.2, recommended: true, confidence: conf }],
  });
  const report = {
    matches: [
      mk('1', 'Premier League', 'Home', 2.0, 0.9),
      mk('2', 'Premier League', 'Home', 2.1, 0.85),
      mk('3', 'WORLD: Club Friendly', 'Home', 2.0, 0.95),
      mk('4', 'La Liga', 'Away', 2.2, 0.8),
    ],
  };
  const bets = selectBets(report);
  assert.equal(bets.length, 3); // MAX_BETS default
  assert.ok(bets.every((b) => b.match.tournament !== 'WORLD: Club Friendly'));
  assert.equal(bets[0].match.eventId, '1');
});

test('selectBets rejects trivial 1X2 odds', () => {
  const report = {
    matches: [
      { match: { eventId: '1', homeTeam: 'A', awayTeam: 'B', tournament: 'League', startTime: '' }, candidates: [{ marketId: '1', market: '1X2', outcome: 'Home', odds: 1.2, recommendedMinOdds: 1.0, recommended: true, confidence: 0.99 }] },
    ],
  };
  assert.equal(selectBets(report).length, 0);
});

test('resolveOutcome finds the O/U line via specifier and live odds', () => {
  const data = {
    markets: [
      { id: 18, desc: 'Over/Under', specifier: 'total=2.5', outcomes: [{ id: '12', desc: 'Over 2.5', odds: 1.43 }] },
      { id: 18, desc: 'Over/Under', specifier: 'total=3.5', outcomes: [{ id: '12', desc: 'Over 3.5', odds: 2.05 }] },
      { id: 18, desc: 'Over/Under', specifier: 'total=3.5', outcomes: [{ id: '13', desc: 'Under 3.5', odds: 1.81 }] },
    ],
  };
  const r = resolveOutcome(data, '18', 'Over 3.5');
  assert.ok(r);
  assert.equal(r.market.specifier, 'total=3.5');
  assert.equal(r.outcome.id, '12');
  assert.equal(r.currentOdds, 2.05);
  assert.equal(resolveOutcome(data, '18', 'Over 9.5'), null);
});

test('writeReport renders settled P&L rows', () => {
  const slip = {
    stakePerBet: 1,
    bets: [
      { homeTeam: 'Ajax', awayTeam: 'Heerenveen', market: 'Over/Under', outcome: 'Over 3.5', odds: 2.05, stake: 1, status: 'settled', result: 'WON', payout: 2.05, net: 1.05 },
      { homeTeam: 'A', awayTeam: 'B', market: '1X2', outcome: 'Home', odds: 1.6, stake: 1, status: 'settled', result: 'LOST', payout: 0, net: -1 },
      { homeTeam: 'C', awayTeam: 'D', market: '1X2', outcome: 'Draw', odds: 3.2, stake: 1, status: 'pending', result: null, payout: null, net: null },
    ],
  };
  const tmp = '/tmp/stake-results-test.md';
  writeReport(slip, tmp);
  const text = fs.readFileSync(tmp, 'utf8');
  assert.ok(text.includes('| Won | 1 |'));
  assert.ok(text.includes('| Lost | 1 |'));
  assert.ok(text.includes('| Open | 1 |'));
  assert.ok(text.includes('| Net P&L | 0.05 |'));
  fs.unlinkSync(tmp);
});