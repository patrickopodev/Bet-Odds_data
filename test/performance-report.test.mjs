import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateDb, oddsReport } from '../analyze-odds.mjs';

function mkEvent(id, marketId, name, odds, finalScore) {
  return {
    eventId: id,
    homeTeam: 'A',
    awayTeam: 'B',
    startTime: '',
    finalScore,
    outcomes: { [`${marketId}|${name}`]: { marketId, name, plays: [{ odds }] } },
  };
}

test('oddsReport buckets 1-2 settled as insufficient and flags small samples', () => {
  const db = { events: {} };
  // Two settled Home results at 1.9 -> 2 settled, below the >=3 verdict bar.
  db.events.a = mkEvent('a', '1', 'Home', 1.9, '1:0');
  db.events.b = mkEvent('b', '1', 'Home', 1.9, '1:0');
  // Three settled Away results at 3.5 -> "good odds", but 3 < 10 => flagged.
  db.events.c = mkEvent('c', '1', 'Away', 3.5, '0:2');
  db.events.d = mkEvent('d', '1', 'Away', 3.5, '0:2');
  db.events.e = mkEvent('e', '1', 'Away', 3.5, '0:2');

  const report = oddsReport(aggregateDb(db));
  assert.match(report, /\*\*Insufficient data\*\* \(1-2 settled, no verdict\): 1/);
  assert.match(report, /Sample-size caveat/);
  assert.match(report, /won 3\/3 times \(100%\).*low sample/);
});

test('oddsReport does not flag verdicts with >=10 settled results', () => {
  const db = { events: {} };
  for (let i = 0; i < 10; i++) {
    db.events['h' + i] = mkEvent('h' + i, '1', 'Home', 1.9, '1:0');
  }
  const report = oddsReport(aggregateDb(db));
  assert.match(report, /won 10\/10 times \(100%\)/);
  assert.doesNotMatch(report, /won 10\/10 times \(100%\).*low sample/);
});