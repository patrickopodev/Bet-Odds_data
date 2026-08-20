import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateOutcome as tsEvaluate, historicalStats, outcomeHistory } from '../dist/db.js';
import { evaluateOutcome as jsEvaluate } from '../lib/common.mjs';
import { analyzeCandidate, candidateSources, buildRecommendations } from '../dist/analysis.js';
import { extractSnippets, webResearch } from '../dist/research.js';
import { parseMatchFeed, aggregatePlayerStats } from '../dist/flashscore.js';
import { selectBets, isFriendly } from '../stake.mjs';
import { resolveOutcome } from '../dist/sporty.js';
import { writeReport } from '../dist/monitor.js';

test('compiled agent shares the lib evaluator (dist/db.js wired to lib/common.mjs)', () => {
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

test('analyzeCandidate scales the historical edge by sample size', () => {
  const mkStats = (n) => {
    const events = {};
    for (let i = 0; i < n; i++) {
      events['e' + i] = {
        eventId: 'e' + i,
        homeTeam: 'A',
        awayTeam: 'B',
        startTime: '',
        finalScore: '2:1',
        outcomes: { o: { marketId: '1', name: 'Home', plays: [{ odds: 1.9 }] } },
      };
    }
    return historicalStats({ events });
  };
  const mkMatch = () => ({
    eventId: 'x',
    homeTeam: 'A',
    awayTeam: 'B',
    tournament: 'T',
    startTime: '',
    venue: null,
    h2h: null,
    home: { name: 'A', flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null, form: 'WWWW', formScore: 12, lastResults: [], venue: null, research: [] },
    away: { name: 'B', flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null, form: 'LLLL', formScore: 0, lastResults: [], venue: null, research: [] },
  });
  const src = { marketId: '1', name: '1X2', outcome: 'Home', odds: 1.9, active: true };
  const small = analyzeCandidate(mkMatch(), src, mkStats(4)); // 4/4 won at ~1.9 → boost scaled by 0.4
  const large = analyzeCandidate(mkMatch(), src, mkStats(30)); // 30/30 won → boost at full strength
  assert.ok(small.reason.includes('LOW SAMPLE'));
  assert.ok(!large.reason.includes('LOW SAMPLE'));
  assert.ok(large.confidence > small.confidence);
  assert.equal(small.historicalSettled, 4);
  assert.equal(large.historicalSettled, 30);
});

test('parseMatchFeed extracts officials (referee/venue) and goal/assist events', () => {
  // Real df_sui feed shape captured from a finished match: goal + assistance in
  // one block (IE=8 after the scorer), a card block, and the MIT/MIV officials
  // block (repeated pairs — must be consumed as an ordered stream).
  const feed =
    'AC÷1st Half¬IG÷1¬IH÷0¬~' +
    'III÷dSFWQ1oT¬IA÷1¬IB÷16\'¬IE÷3¬INX÷1¬IOX÷0¬IF÷Borchgrevink C.¬IU÷/player/x/¬ICT÷¬IK÷Goal¬IM÷n3Y0L49e¬~' +
    'III÷KxHnam8j¬IA÷2¬IB÷54\'¬IE÷3¬INX÷1¬IOX÷1¬IF÷Duncan R.¬IU÷/player/y/¬ICT÷¬IK÷Goal¬IM÷MacOdskI¬IE÷8¬IF÷Devine D.¬IU÷/player/z/¬ICT÷¬IK÷Assistance¬IM÷0rsrbaLI¬~' +
    'III÷I9lgfoyp¬IA÷2¬IB÷39\'¬IE÷1¬IF÷Duncan R.¬IU÷/player/y/¬ICT÷¬IK÷Yellow Card¬IM÷MacOdskI¬~' +
    'MIT÷REF¬MIV÷Scott C.¬MIT÷RCO¬MIV÷199¬MIT÷VEN¬MIV÷Tynecastle Park¬MIT÷TWN¬MIV÷Edinburgh¬MIT÷ATT¬MIV÷15 327¬MIT÷CAP¬MIV÷19 852¬A1÷¬';
  const parsed = parseMatchFeed(feed);
  assert.equal(parsed.officials.referee, 'Scott C.');
  assert.equal(parsed.officials.venue, 'Tynecastle Park');
  assert.equal(parsed.officials.town, 'Edinburgh');
  assert.equal(parsed.officials.capacity, '19 852');
  assert.equal(parsed.officials.attendance, '15 327');
  const goals = parsed.events.filter((e) => e.type === 'goal');
  assert.equal(goals.length, 2);
  assert.equal(goals[0].player, 'Borchgrevink C.');
  assert.equal(goals[0].side, 'home');
  assert.equal(goals[1].player, 'Duncan R.');
  assert.equal(goals[1].side, 'away');
  const assists = parsed.events.filter((e) => e.type === 'assist');
  assert.equal(assists.length, 1);
  assert.equal(assists[0].player, 'Devine D.');
  const cards = parsed.events.filter((e) => e.type === 'card');
  assert.equal(cards.length, 1);
  assert.equal(cards[0].player, 'Duncan R.');
});

test('aggregatePlayerStats credits a team only its own side of each finished match', () => {
  const feeds = new Map([
    [
      'm1',
      {
        officials: { referee: null, venue: null, town: null, capacity: null, attendance: null },
        events: [
          { minute: "10'", type: 'goal', player: 'Ace', side: 'home', detail: 'Goal' },
          { minute: "20'", type: 'goal', player: 'Opp', side: 'away', detail: 'Goal' },
          { minute: "30'", type: 'assist', player: 'Helper', side: 'home', detail: 'Assistance' },
        ],
      },
    ],
  ]);
  const lastResults = [
    { opp: 'Rival', score: '1-1', result: 'D', eventId: 'm1', side: 'home' },
  ];
  const stats = aggregatePlayerStats(feeds, lastResults);
  assert.equal(stats.scorers.length, 1);
  assert.equal(stats.scorers[0].player, 'Ace');
  assert.equal(stats.scorers[0].count, 1);
  assert.equal(stats.assists.length, 1);
  assert.equal(stats.assists[0].player, 'Helper');
  assert.equal(stats.cards.length, 0);
});

test('injury news + missing key players lower 1X2 confidence; officials enter reason', () => {
  const stats = historicalStats({ events: {} });
  const match = {
    eventId: 'x',
    homeTeam: 'A',
    awayTeam: 'B',
    tournament: 'T',
    startTime: '',
    home: { name: 'A', flashscoreId: null, flashscoreUrl: null, position: 1, played: 20, points: null, form: 'WWWWW', formScore: 15, lastResults: [], research: [], researchAt: null, injuries: ['Star striker ruled out with hamstring injury'], keyPlayers: [], scorers: [], assists: [], cards: [] },
    away: { name: 'B', flashscoreId: null, flashscoreUrl: null, position: 18, played: 20, points: null, form: 'LLLLL', formScore: 0, lastResults: [], research: [], researchAt: null, injuries: [], keyPlayers: [], scorers: [], assists: [], cards: [] },
    officials: { referee: 'Scott C.', venue: 'Tynecastle Park', town: null, capacity: null, attendance: null },
  };
  const src = { marketId: '1', name: '1X2', outcome: 'Home', odds: 1.6, active: true };
  const c = analyzeCandidate(match, src, stats);
  assert.ok(c.reason.includes('ref Scott C.'), 'reason names the referee');
  assert.ok(c.reason.includes('@Tynecastle Park'), 'reason names the venue');
  assert.ok(c.reason.includes('injury note'), 'reason surfaces injury research');
});

test('research snippets feed confidence (injury news lowers it)', () => {
  const stats = historicalStats({ events: {} });
  const mk = (formScore, position, research) => ({
    eventId: 'x',
    homeTeam: 'A',
    awayTeam: 'B',
    tournament: 'T',
    startTime: '',
    home: { name: 'A', flashscoreId: null, flashscoreUrl: null, position, played: 20, points: null, form: 'WWWDW', formScore, lastResults: [], research, researchAt: null },
    away: { name: 'B', flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null, form: '', formScore: 0, lastResults: [], research: [], researchAt: null },
  });
  const src = { marketId: '1', name: '1X2', outcome: 'Home', odds: 1.8, active: true };
  const clean = analyzeCandidate(mk(15, 1, []), src, stats);
  const injured = analyzeCandidate(mk(15, 1, ['Key striker ruled out with a hamstring injury, suspended defender']), src, stats);
  assert.ok(injured.confidence < clean.confidence, 'negative news must reduce confidence');
  assert.ok(clean.reason.includes('form'), 'reason mentions team form');
});

test('O/U confidence is line-aware (gap vs the market line)', () => {
  const stats = historicalStats({ events: {} });
  const mk = (homeRes, awayRes) => ({
    eventId: 'x',
    homeTeam: 'A',
    awayTeam: 'B',
    tournament: 'T',
    startTime: '',
    home: { name: 'A', flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null, form: '', formScore: 0, lastResults: homeRes, research: [], researchAt: null },
    away: { name: 'B', flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null, form: '', formScore: 0, lastResults: awayRes, research: [], researchAt: null },
  });
  const highScoring = mk(
    [{ opp: 'x', score: '3-1', result: 'W' }, { opp: 'x', score: '2-2', result: 'D' }, { opp: 'x', score: '4-0', result: 'W' }],
    [{ opp: 'x', score: '2-2', result: 'D' }, { opp: 'x', score: '3-1', result: 'W' }, { opp: 'x', score: '2-3', result: 'L' }],
  ); // avg total = 4.0
  const lowScoring = mk(
    [{ opp: 'x', score: '1-0', result: 'W' }, { opp: 'x', score: '0-0', result: 'D' }, { opp: 'x', score: '1-1', result: 'D' }],
    [{ opp: 'x', score: '0-0', result: 'D' }, { opp: 'x', score: '1-0', result: 'W' }, { opp: 'x', score: '0-1', result: 'L' }],
  ); // avg total = 1.0
  const overHigh = analyzeCandidate(highScoring, { marketId: '18', name: 'O/U', outcome: 'Over 2.5', odds: 1.9, active: true }, stats);
  const overLow = analyzeCandidate(lowScoring, { marketId: '18', name: 'O/U', outcome: 'Over 2.5', odds: 1.9, active: true }, stats);
  const underHigh = analyzeCandidate(highScoring, { marketId: '18', name: 'O/U', outcome: 'Under 2.5', odds: 1.9, active: true }, stats);
  assert.ok(overHigh.confidence > overLow.confidence, 'higher avg goals → more confident Over');
  assert.ok(overHigh.reason.includes('vs Over 2.5'), 'reason names the line');
  assert.ok(underHigh.confidence < overHigh.confidence, 'same team, Under should be less confident than Over');
});

test('extractSnippets parses DDG html and dedupes', () => {
  const html =
    '<a class="result__a" href="/x">Hearts news</a>' +
    '<a class="result__snippet">Striker back in training</a>' +
    '<a class="result__a" href="/x">Hearts news</a>' +
    '<a class="result__snippet">Striker back in training</a>' +
    '<a class="result__a" href="/y">Other</a>';
  const out = extractSnippets(html, 3);
  assert.equal(out.length, 2);
  assert.ok(out[0].includes('Hearts news'));
});

test('webResearch returns per-side buckets (symmetric research)', async () => {
  const r = await webResearch('Fake Team Alpha', 'Fake Team Beta', 'Test League');
  assert.ok(Array.isArray(r.match));
  assert.ok(Array.isArray(r.home));
  assert.ok(Array.isArray(r.away));
  assert.ok(Array.isArray(r.homeInjuries));
  assert.ok(Array.isArray(r.awayInjuries));
  assert.ok(Array.isArray(r.homePlayers));
  assert.ok(Array.isArray(r.awayPlayers));
  assert.ok(Object.keys(r).length === 7);
});

test('selectBets skips friendlies unless allowed', () => {
  assert.equal(isFriendly('WORLD: Club Friendly'), true);
  assert.equal(isFriendly('Premier League'), false);

  const mk = (id, tourney, outcome, odds, conf) => ({
    match: { eventId: id, homeTeam: 'A', awayTeam: 'B', tournament: tourney, startTime: '', home: {}, away: {} },
    candidates: [{ marketId: '1', market: '1X2', outcome, odds, recommendedMinOdds: 1.2, recommended: true, confidence: conf }],
  });
  const report = {
    matches: [
      mk('1', 'Premier League', 'Home', 3.1, 0.9),
      mk('2', 'Premier League', 'Home', 2.1, 0.85),
      mk('3', 'WORLD: Club Friendly', 'Home', 2.0, 0.95),
      mk('4', 'La Liga', 'Away', 2.2, 0.8),
    ],
  };
  const bets = selectBets(report);
  assert.equal(bets.length, 3); // selectBets no longer caps; all non-friendly picks return
  assert.ok(bets.every((b) => b.match.tournament !== 'WORLD: Club Friendly'));
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
    stakePerSlip: 1,
    slips: [
      { slipId: 's1', type: 'single', stake: 1, combinedOdds: 2.05, status: 'settled', result: 'WON', payout: 2.05, net: 1.05, legs: [{ homeTeam: 'Ajax', awayTeam: 'Heerenveen', market: 'Over/Under', outcome: 'Over 3.5' }] },
      { slipId: 's2', type: 'single', stake: 1, combinedOdds: 1.6, status: 'settled', result: 'LOST', payout: 0, net: -1, legs: [{ homeTeam: 'A', awayTeam: 'B', market: '1X2', outcome: 'Home' }] },
      { slipId: 's3', type: 'single', stake: 1, combinedOdds: 3.2, status: 'pending', result: null, payout: null, net: null, legs: [{ homeTeam: 'C', awayTeam: 'D', market: '1X2', outcome: 'Draw' }] },
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