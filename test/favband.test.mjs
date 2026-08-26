import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFavRows, selectFavBand1X2Picks } from '../lib/favband.mjs';

// Build a minimal odds-db event with 1X2 sides (Home/Draw/Away last odds).
function ev(id, homeOdds, drawOdds, awayOdds, opts = {}) {
  const { home = 'Home', away = 'Away', score = null, tournament = 'L' } = opts;
  const mk = (name, odds) => ({ marketId: '1', name, plays: [{ odds }] });
  return {
    eventId: id,
    homeTeam: home,
    awayTeam: away,
    tournament,
    finalScore: score,
    outcomes: {
      '1|Home': mk('Home', homeOdds),
      '1|Draw': mk('Draw', drawOdds),
      '1|Away': mk('Away', awayOdds),
    },
  };
}

function dbOf(...events) {
  return { events: Object.fromEntries(events.map((e) => [e.eventId, e])) };
}

test('boundary: 1.49 reject, 1.50 accept, 1.77 accept, 2.19 accept, 2.20 reject', () => {
  const d = dbOf(
    ev('e1', 1.49, 3.5, 4.0), // fav Home 1.49 -> reject
    ev('e2', 1.5, 3.5, 4.0), // fav Home 1.50 -> accept
    ev('e3', 1.77, 3.5, 4.0), // accept
    ev('e4', 2.19, 3.5, 4.0), // accept
    ev('e5', 2.2, 3.5, 4.0) // fav Home 2.20 -> reject (upper bound exclusive)
  );
  const picks = selectFavBand1X2Picks(buildFavRows(d), 1.5, 2.2);
  assert.deepEqual(
    picks.map((p) => p.eventId).sort(),
    ['e2', 'e3', 'e4']
  );
});

test('favorite is the lowest-odds 1X2 side, not hardcoded to Home', () => {
  const d = dbOf(
    ev('a', 3.0, 3.2, 1.8, { home: 'A', away: 'B' }), // fav Away 1.8 -> accept
    ev('b', 2.0, 3.2, 1.9, { home: 'C', away: 'D' }), // fav Away 1.9 -> accept
    ev('c', 2.3, 3.2, 2.1, { home: 'E', away: 'F' }) // fav Away 2.1 -> accept
  );
  const picks = selectFavBand1X2Picks(buildFavRows(d), 1.5, 2.2);
  assert.deepEqual(picks.map((p) => p.eventId).sort(), ['a', 'b', 'c']);
  assert.equal(picks.find((p) => p.eventId === 'a').favName, 'Away');
});

test('resolved events are excluded from the track', () => {
  const d = dbOf(
    ev('r', 1.8, 3.5, 4.0, { score: '2:1' }), // resolved -> excluded
    ev('u', 1.8, 3.5, 4.0) // unresolved -> included
  );
  const picks = selectFavBand1X2Picks(buildFavRows(d), 1.5, 2.2);
  assert.deepEqual(picks.map((p) => p.eventId), ['u']);
});

test('O/U, correct-score, totals are never selected (only 1X2 favorite)', () => {
  // Tempting odds in other markets, but the 1X2 favorite is out of band.
  const e = {
    eventId: 'x',
    homeTeam: 'H',
    awayTeam: 'A',
    tournament: 'L',
    finalScore: null,
    outcomes: {
      '1|Home': { marketId: '1', name: 'Home', plays: [{ odds: 3.0 }] },
      '1|Draw': { marketId: '1', name: 'Draw', plays: [{ odds: 3.2 }] },
      '1|Away': { marketId: '1', name: 'Away', plays: [{ odds: 3.1 }] },
      '18|Over 2.5': { marketId: '18', name: 'Over 2.5', plays: [{ odds: 1.5 }] },
      '41|2:2': { marketId: '41', name: '2:2', plays: [{ odds: 1.6 }] },
      '548|3+': { marketId: '548', name: '3+', plays: [{ odds: 1.7 }] },
    },
  };
  // Favorite is Home @3.0 -> outside [1.5,2.2) -> nothing selected.
  const picks = selectFavBand1X2Picks(buildFavRows(dbOf(e)), 1.5, 2.2);
  assert.equal(picks.length, 0);
});

test('shared selector is identical for paper and manual paths', () => {
  // Both call selectFavBand1X2Picks(buildFavRows(db), lo, hi) -> same set by construction.
  const d = dbOf(
    ev('p1', 1.67, 3.4, 4.0),
    ev('p2', 2.15, 3.4, 4.0),
    ev('p3', 1.4, 3.4, 4.0), // below band -> excluded
    ev('p4', 2.3, 3.4, 4.0) // above band -> excluded
  );
  const lo = 1.5;
  const hi = 2.2;
  const paper = selectFavBand1X2Picks(buildFavRows(d), lo, hi);
  const manual = selectFavBand1X2Picks(buildFavRows(d), lo, hi);
  assert.deepEqual(
    paper.map((p) => p.eventId).sort(),
    manual.map((p) => p.eventId).sort()
  );
  assert.deepEqual(paper.map((p) => p.eventId).sort(), ['p1', 'p2']);
});
