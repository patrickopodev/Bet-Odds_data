import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runDeepDiscovery,
  generatorsFor,
  dataQualityReport,
} from '../../engine/deep-discovery.mjs';

function ev(id, marketId, name, odds, finalScore, day) {
  return {
    eventId: id,
    startTime: new Date(2020, 0, 1 + day).toISOString(),
    finalScore,
    outcomes: { [`${marketId}|${name}`]: { marketId: String(marketId), name, plays: [{ odds }] } },
  };
}

function marketDb(marketId, outcomes, nEach, odds, finalScore) {
  const events = {};
  let i = 0;
  for (let r = 0; r < nEach; r++) {
    for (const name of outcomes) {
      events[`E${i}`] = ev(`E${i}`, marketId, name, odds, finalScore, i);
      i++;
    }
  }
  return { events };
}

test('generatorsFor returns labelled, market-specific families', () => {
  assert.equal(generatorsFor('41').length, 2);
  assert.equal(generatorsFor('41')[1].label, 'Score families');
  assert.equal(generatorsFor('548').length, 2);
  assert.equal(generatorsFor('548')[1].label, 'Goal ranges');
  assert.equal(generatorsFor('551').length, 2);
  assert.equal(generatorsFor('551')[1].label, 'Score groups');
  assert.equal(generatorsFor('18').length, 1);
});

test('richer CS family discovery finds a survivor on dense, positive data', () => {
  const db = marketDb('41', ['1-0'], 120, 3.5, '1:0'); // all WON, home-win family pools it
  const { report } = runDeepDiscovery(db);
  const cs = report.find((m) => m.marketId === '41');
  const survivors = cs.generators.reduce((a, g) => a + g.survivors, 0);
  assert.ok(survivors >= 1, 'home-win score family should survive the frozen holdout');
});

test('data-quality: Correct Score is flagged data-poor when cells are too sparse', () => {
  // 10 scores, 25 samples each (below MIN_TRAIN=30 after the 60/40 split), all LOST.
  const outcomes = ['1-0', '2-0', '3-0', '4-0', '0-1', '0-2', '1-2', '2-1', '3-1', '1-3'];
  const db = marketDb('41', outcomes, 25, 3.5, '0:0');
  const q = dataQualityReport(db).find((m) => m.marketId === '41');
  assert.equal(q.verdict, 'data-poor (insufficient resolution)');
  assert.ok(q.cellsGe30 < 5);
});

test('data-quality: Multigoals is flagged signal-poor when data is ample but no edge', () => {
  // 5 outcomes, 60 samples each (>=30), all LOST -> plenty of data, zero edge.
  const db = marketDb('548', ['1-2', '2-3', '3-4', '4-5', '5-6'], 60, 3.5, '0:0');
  const q = dataQualityReport(db).find((m) => m.marketId === '548');
  assert.equal(q.verdict, 'signal-poor (tested, no edge)');
  assert.ok(q.cellsGe30 >= 5);
  assert.equal(q.survivors, 0);
});

test('data-quality report covers all five markets with forced LIVE/PAPER verdicts', () => {
  const db = marketDb('41', ['1-0'], 120, 3.5, '1:0');
  const q = dataQualityReport(db);
  assert.equal(q.length, 5);
  assert.ok(q.find((m) => m.marketId === '1').verdict.includes('LIVE'));
  assert.ok(q.find((m) => m.marketId === '18').verdict.includes('PAPER'));
});

test('discovery is pure: re-running yields identical results', () => {
  const db = marketDb('41', ['1-0'], 120, 3.5, '1:0');
  const a = JSON.stringify(runDeepDiscovery(db).report);
  const b = JSON.stringify(runDeepDiscovery(db).report);
  assert.equal(a, b);
});
