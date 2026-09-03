import test from 'node:test';
import assert from 'node:assert/strict';
import { loadRegistry, selectStrategy, loadBands } from '../../engine/strategies.mjs';
import { validatePick, GATE_DEFAULTS } from '../../engine/validation.mjs';
import { selectApproved } from '../../engine/daily-engine.mjs';
import { makeEvent } from './_fixtures.mjs';

const future = '2030-01-01T12:00:00Z';

test('loadBands: loads per-scoreline bands from correctscore-relations.json', () => {
  const bands = loadBands('correctscore-relations.json');
  assert.ok(Object.keys(bands).length > 0, 'should load scoreline bands');
  assert.ok('0:0' in bands, 'scoreline 0:0 should exist');
  const band = bands['0:0'];
  assert.equal(band.length, 2, 'band should be [lo, hi]');
  assert.ok(band[0] >= 1.8 && band[0] < band[1], 'band lo/hi should be valid');
});

test('loadBands: loads per-outcome bands from mg-mscore-bands.json', () => {
  const bands = loadBands('mg-mscore-bands.json');
  assert.ok('multigoals' in bands, 'should have multigoals');
  assert.ok('multiscores' in bands, 'should have multiscores');
  assert.ok(Object.keys(bands.multigoals).length > 0, 'should have MG outcome bands');
  assert.ok(Object.keys(bands.multiscores).length > 0, 'should have MSCORE outcome bands');
});

test('selectCorrectScore: picks scorelines within per-scoreline bands', () => {
  const registry = loadRegistry();
  const cs = registry.strategies.find((s) => s.strategyId === 'STRAT-CS-ODDS-v1');
  assert.ok(cs, 'CS strategy must exist');

  const db = {
    events: {
      E1: makeEvent('E1', { cs: { '0:0': [5, 6], '1:0': [15, 16] }, startTime: future }),
    },
  };
  const candidates = selectStrategy(cs, { db });
  assert.ok(candidates.length > 0, 'should select CS candidates');
  for (const c of candidates) {
    const band = loadBands('correctscore-relations.json')[c.selection];
    if (band) {
      assert.ok(c.odds >= band[0] && c.odds < band[1], `${c.selection} odds ${c.odds} should be in band ${band}`);
    }
  }
});

test('selectCorrectScore: uses fallbackBand when scoreline not in data', () => {
  const registry = loadRegistry();
  const cs = registry.strategies.find((s) => s.strategyId === 'STRAT-CS-ODDS-v1');
  const db = {
    events: {
      E1: makeEvent('E1', { cs: { '9:9': [1.9, 1.95] }, startTime: future }),
    },
  };
  const candidates = selectStrategy(cs, { db });
  assert.ok(candidates.length > 0, 'fallback band should allow in-band odds');
  assert.ok(candidates.every((c) => c.odds >= 1.8 && c.odds < 2.2));
});

test('selectCorrectScore: rejects scorelines outside their band', () => {
  const registry = loadRegistry();
  const cs = registry.strategies.find((s) => s.strategyId === 'STRAT-CS-ODDS-v1');
  const db = {
    events: {
      E1: makeEvent('E1', { cs: { '0:0': [2.0, 2.0] }, startTime: future }),
    },
  };
  const candidates = selectStrategy(cs, { db });
  assert.equal(candidates.length, 0, 'out-of-band odds should be rejected');
});

test('selectCorrectScore: requires active play', () => {
  const registry = loadRegistry();
  const cs = registry.strategies.find((s) => s.strategyId === 'STRAT-CS-ODDS-v1');
  const db = {
    events: {
      E1: {
        eventId: 'E1', homeTeam: 'H', awayTeam: 'A', tournament: 'T',
        startTime: future, isSimulated: false, finalScore: null,
        outcomes: {
          '41|0:0': { marketId: '41', name: '0:0', plays: [{ odds: 15, active: false }] },
        },
      },
    },
  };
  const candidates = selectStrategy(cs, { db });
  assert.equal(candidates.length, 0, 'no active play should produce no candidates');
});

test('selectMultigoals: selects outcomes within per-outcome bands', () => {
  const registry = loadRegistry();
  const mg = registry.strategies.find((s) => s.strategyId === 'STRAT-MG-ODDS-v1');
  assert.ok(mg, 'MG strategy must exist');

  const mgDb = {
    events: {
      E1: {
        eventId: 'E1', homeTeam: 'H', awayTeam: 'A', tournament: 'T',
        startTime: future, isSimulated: false, finalScore: null,
        outcomes: {
          '548|5-6': { marketId: '548', name: '5-6', plays: [{ odds: 6.7, active: true }] },
        },
      },
    },
  };
  const candidates = selectStrategy(mg, { db: mgDb });
  assert.ok(candidates.length > 0, 'should select MG candidates in band');
});

test('selectMultiscores: selects outcomes within per-outcome bands', () => {
  const registry = loadRegistry();
  const ms = registry.strategies.find((s) => s.strategyId === 'STRAT-MSCORE-ODDS-v1');
  assert.ok(ms, 'MSCORE strategy must exist');

  const mgDb = {
    events: {
      E1: {
        eventId: 'E1', homeTeam: 'H', awayTeam: 'A', tournament: 'T',
        startTime: future, isSimulated: false, finalScore: null,
        outcomes: {
          '551|Draw': { marketId: '551', name: 'Draw', plays: [{ odds: 3.5, active: true }] },
        },
      },
    },
  };
  const candidates = selectStrategy(ms, { db: mgDb });
  assert.ok(candidates.length > 0, 'should select MSCORE candidates in band');
});

test('daily engine: CS picks approved across all markets', () => {
  const registry = loadRegistry();
  const db = {
    events: {
      E1: makeEvent('E1', {
        sides: { Home: 1.95, Draw: 3.4, Away: 4.0 },
        cs: { '0:0': [5, 6], '1:0': [15, 16] },
        startTime: future,
      }),
      E2: makeEvent('E2', { sides: { Home: 2.5, Draw: 3.2, Away: 2.8 }, startTime: future }),
    },
  };
  const { approved, rejected } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const csApproved = approved.filter((p) => p.marketId === '41');
  assert.ok(csApproved.length > 0, 'should approve CS picks');
  assert.ok(approved.some((p) => p.marketId === '1'), 'should approve 1X2 picks');
  assert.ok(approved.every((p) => p.strategyId), 'all picks must have strategyId');
});

test('daily engine: all five markets represented in approved picks', () => {
  const registry = loadRegistry();
  const allMarkets = ['1', '18', '41', '548', '551'];
  const db = {
    events: {
      E1: makeEvent('E1', {
        sides: { Home: 1.95, Draw: 3.4, Away: 4.0 },
        ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 },
        cs: { '0:0': [5, 6], '1:0': [15, 16] },
        mg: { '5-6': [6.7] },
        mscore: { 'Draw': [3.5] },
        startTime: future,
      }),
      E2: makeEvent('E2', {
        sides: { Home: 2.5, Draw: 3.2, Away: 2.8 },
        ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 },
        mg: { '5-6': [6.7] },
        mscore: { 'Draw': [3.5] },
        startTime: future,
      }),
    },
  };
  const { approved } = selectApproved({ db, registry, now: Date.parse('2029-01-01T00:00:00Z') });
  const markets = new Set(approved.map((p) => p.marketId));
  for (const m of allMarkets) {
    assert.ok(markets.has(m), `market ${m} must have approved picks`);
  }
});

test('MIN_WIN_RATE: pick without historicalWinRate passes validation', () => {
  const registry = loadRegistry();
  const a = registry.strategies.find((s) => s.strategyId === 'STRAT-1X2-BAND-v1');
  const pick = {
    matchId: 'E1', marketId: '1', strategyId: a.strategyId, selection: 'Home', odds: 1.95,
    kickoff: '2030-01-01T12:00:00Z', confidence: 0.92, isSimulated: false, recommendedMinOdds: 1.8,
  };
  const v = validatePick(pick, { strategy: a, now: Date.parse('2029-01-01T00:00:00Z') });
  assert.equal(v.ok, true, 'pick without historicalWinRate should pass');
});