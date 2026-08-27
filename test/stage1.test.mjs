import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateHistoricalStats } from '../lib/common.mjs';
import { naiveMarketRollup, classify } from '../stage1-market-roi.mjs';

// --- synthetic DB helpers (mirror the v1 schema aggregateHistoricalStats reads) ---
function db(events) {
  return { version: 1, events };
}
function ev(id, finalScore, outcomes) {
  return { eventId: id, homeTeam: 'H', awayTeam: 'A', tournament: 'T', finalScore, outcomes };
}
function o(marketId, name, odds) {
  return { marketId: String(marketId), name, plays: [{ odds, at: '2026-01-01T00:00:00Z' }] };
}

// A single finished match (2:1) covering four raw markets, used to verify the
// rollup counts each market independently.
const SAMPLE_EVENT = ev('e1', '2:1', {
  '1|Home': o(1, 'Home', 1.9),
  '1|Draw': o(1, 'Draw', 3.4),
  '1|Away': o(1, 'Away', 4.0),
  '18|Over 2.5': o(18, 'Over 2.5', 1.9),
  '18|Under 2.5': o(18, 'Under 2.5', 1.9),
  '41|2:1': o(41, '2:1', 10.0),
  '41|1:0': o(41, '1:0', 8.0),
  '548|1-2': o(548, '1-2', 2.0),
  '548|No goal': o(548, 'No goal', 5.0),
  '551|1:0, 2:0 or 3:0': o(551, '1:0, 2:0 or 3:0', 3.0),
  '551|Draw': o(551, 'Draw', 3.0),
});

function rollupOf(event) {
  return naiveMarketRollup(aggregateHistoricalStats(db({ e1: event })));
}
function byLabel(rows) {
  return Object.fromEntries(rows.map((r) => [r.label, r]));
}

// ---------------------------------------------------------------------------
// naiveMarketRollup
// ---------------------------------------------------------------------------

test('counts resolved outcomes per market', () => {
  const r = byLabel(rollupOf(SAMPLE_EVENT));
  assert.equal(r['1X2'].resolved, 3);
  assert.equal(r['O/U'].resolved, 2);
  assert.equal(r['Correct Score'].resolved, 2);
  assert.equal(r['Multigoals'].resolved, 2);
  assert.equal(r['Multiscores'].resolved, 2);
});

test('counts wins and losses correctly', () => {
  const r = byLabel(rollupOf(SAMPLE_EVENT));
  // 2:1 -> Home wins; Over 2.5 (total 3) wins; 2:1 exact scores; etc.
  assert.equal(r['1X2'].won, 1);
  assert.equal(r['1X2'].lost, 2);
  assert.equal(r['O/U'].won, 1);
  assert.equal(r['O/U'].lost, 1);
});

test('does not mix markets (1X2 stays independent of O/U)', () => {
  const r = byLabel(rollupOf(SAMPLE_EVENT));
  // If markets bled together, 1X2 would pick up O/U's 2 outcomes.
  assert.equal(r['1X2'].resolved, 3);
  assert.equal(r['1X2'].resolved + r['O/U'].resolved, 5);
});

test('win rate is wins / (wins + losses), excluding voids', () => {
  const r = byLabel(rollupOf(SAMPLE_EVENT));
  assert.ok(Math.abs(r['1X2'].winRate - 1 / 3) < 1e-9);
  assert.ok(Math.abs(r['O/U'].winRate - 0.5) < 1e-9);
});

test('ROI = profit / staked (voids excluded from stake)', () => {
  const r = byLabel(rollupOf(SAMPLE_EVENT));
  // 1X2: Home won @1.9 (+0.9), Draw lost (-1), Away lost (-1) => profit -1.1 / 3 = -0.3667
  assert.ok(Math.abs(r['1X2'].roi - -1.1 / 3) < 1e-9);
  // O/U: Over won +0.9, Under lost -1 => -0.1 / 2 = -0.05
  assert.ok(Math.abs(r['O/U'].roi - -0.1 / 2) < 1e-9);
});

test('unresolved matches do not inflate counts', () => {
  // Second event with no finalScore: its outcomes must contribute 0 settled.
  const second = ev('e2', undefined, {
    '1|Home': o(1, 'Home', 1.5),
    '1|Draw': o(1, 'Draw', 4.0),
    '1|Away': o(1, 'Away', 6.0),
  });
  const rows = naiveMarketRollup(aggregateHistoricalStats(db({ e1: SAMPLE_EVENT, e2: second })));
  const r = byLabel(rows);
  // Still only e1's 3 resolved 1X2 outcomes; e2 adds nothing.
  assert.equal(r['1X2'].resolved, 3);
});

test('invalid finalScore is treated as unresolved (safe)', () => {
  const bad = ev('e3', 'not-a-score', {
    '1|Home': o(1, 'Home', 1.5),
    '1|Draw': o(1, 'Draw', 4.0),
    '1|Away': o(1, 'Away', 6.0),
  });
  const rows = naiveMarketRollup(aggregateHistoricalStats(db({ e1: SAMPLE_EVENT, e3: bad })));
  const r = byLabel(rows);
  assert.equal(r['1X2'].resolved, 3);
});

test('an event with no settled outcomes yields zero resolved, not NaN', () => {
  const empty = ev('e4', '1:1', {});
  const rows = naiveMarketRollup(aggregateHistoricalStats(db({ e4: empty })));
  for (const r of rows) {
    assert.equal(r.resolved, 0);
    assert.equal(r.won, 0);
    assert.equal(r.lost, 0);
    assert.equal(r.roi, null);
    assert.equal(r.winRate, null);
  }
});

// ---------------------------------------------------------------------------
// classify — boundary conditions (sample size + ROI, Stage-1 screening only)
// ---------------------------------------------------------------------------

test('0 samples -> INSUFFICIENT EVIDENCE', () => {
  assert.equal(classify({ resolved: 0, roi: null }), 'INSUFFICIENT EVIDENCE');
  assert.equal(classify({ resolved: 0, roi: 0.5 }), 'INSUFFICIENT EVIDENCE');
});

test('below threshold (29) -> INSUFFICIENT EVIDENCE regardless of ROI', () => {
  assert.equal(classify({ resolved: 29, roi: 0.9 }), 'INSUFFICIENT EVIDENCE');
  assert.equal(classify({ resolved: 29, roi: -0.5 }), 'INSUFFICIENT EVIDENCE');
});

test('exactly 30 with positive ROI -> CANDIDATE FOR STAGE 2 (boundary)', () => {
  assert.equal(classify({ resolved: 30, roi: 0.1 }), 'CANDIDATE FOR STAGE 2');
});

test('exactly 30 with non-positive ROI -> NEGATIVE HISTORICAL EDGE', () => {
  assert.equal(classify({ resolved: 30, roi: -0.1 }), 'NEGATIVE HISTORICAL EDGE');
  assert.equal(classify({ resolved: 30, roi: 0 }), 'NEGATIVE HISTORICAL EDGE');
  assert.equal(classify({ resolved: 30, roi: null }), 'NEGATIVE HISTORICAL EDGE');
});

test('large sample negative ROI -> NEGATIVE HISTORICAL EDGE', () => {
  assert.equal(classify({ resolved: 1000, roi: -0.2 }), 'NEGATIVE HISTORICAL EDGE');
});

test('large sample positive ROI -> CANDIDATE FOR STAGE 2 (not validated)', () => {
  const v = classify({ resolved: 1000, roi: 0.15 });
  assert.equal(v, 'CANDIDATE FOR STAGE 2');
  assert.notEqual(v, 'VALIDATED');
});
