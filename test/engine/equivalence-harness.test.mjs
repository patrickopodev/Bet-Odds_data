import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  legacyCandidates,
  engineCandidates,
  compareCycle,
  runHarnessOnDb,
  runHarnessOverHistory,
} from '../../engine/equivalence-harness.mjs';
import { frozenFavBand } from '../../lib/favband.mjs';
import { sampleDb } from './_fixtures.mjs';

// Build a minimal SportyBet snapshot in the real on-disk format build-db.mjs
// ingests (1X2 + O/U outcomes carry their own marketId; the section is "1X2 /
// O/U"). `fav` is the 1X2 favorite odds used to drive the FAV_BAND selection.
function makeSnapshot(file, { scrapedAt, startTime, fav = 1.9, favSide = 'Home' }) {
  const sides = { Home: 4.0, Draw: 3.4, Away: 4.0 };
  sides[favSide] = fav;
  const outcomes = [
    { name: 'Home', odds: sides.Home, active: true, marketId: '1' },
    { name: 'Draw', odds: sides.Draw, active: true, marketId: '1' },
    { name: 'Away', odds: sides.Away, active: true, marketId: '1' },
    { name: 'Over 2.5', odds: 1.7, active: true, marketId: '18' },
    { name: 'Under 2.5', odds: 2.1, active: true, marketId: '18' },
  ];
  const data = {
    scrapedAt,
    source: 'sportybet.com/gh/m/',
    matches: [
      {
        eventId: 'sr:match:DAY1',
        homeTeam: 'HomeFC',
        awayTeam: 'AwayFC',
        startTime,
        matchStatus: 'Not start',
        tournament: 'TestLeague',
        category: 'Test',
        markets: { '1X2 / O/U': { marketId: '1+18', name: '1X2 / O/U', outcomes } },
      },
    ],
  };
  fs.writeFileSync(file, JSON.stringify(data));
}

// ── Single cycle on the real-shaped fixture DB ──────────────────────────────
test('harness: legacy == unified engine on identical frozen inputs (single cycle)', () => {
  const db = sampleDb();
  const now = Date.parse('2029-01-01T00:00:00Z');
  const rep = compareCycle({ db, now });

  assert.equal(rep.status, 'EQUIVALENT');
  assert.equal(rep.legacyOnlyCount, 0);
  assert.equal(rep.engineOnlyCount, 0);
  assert.equal(rep.exactMatches, rep.legacyCandidates);
  // Only 1X2 favorites in [1.8,2.2) qualify: E1 (Home 1.95), E2 (Away 2.10).
  assert.equal(rep.legacyCandidates, 2);
  assert.equal(rep.engineCandidates, 2);
  assert.ok(rep.fiveMarket.legacyAll1X2);
  assert.ok(rep.fiveMarket.engineAll1X2);
});

test('harness: legacy and engine selectors yield identical record shapes/values', () => {
  const db = sampleDb();
  const now = Date.parse('2029-01-01T00:00:00Z');
  const legacy = legacyCandidates(db, { now });
  const engine = engineCandidates(db, { now });
  const norm = (arr) => arr.map((r) => `${r.matchId}|${r.marketId}|${r.selection}|${r.odds}`).sort();
  assert.deepEqual(norm(engine), norm(legacy));
});

// ── Multi-day over synthetic frozen snapshots ──────────────────────────────
test('harness: multi-day proves EQUIVALENT across several frozen daily inputs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-harness-'));
  try {
    // Day 1: one in-band 1X2 favorite (Home 1.90).
    makeSnapshot(path.join(dir, 'snapshot-2026-08-20T12-00-00-000Z.json'), {
      scrapedAt: '2026-08-20T12:00:00.000Z',
      startTime: '2026-08-20T18:00:00.000Z',
      fav: 1.9,
    });
    // Day 2: one in-band 1X2 favorite (Away 2.05) and one out-of-band (Draw 1.5).
    makeSnapshot(path.join(dir, 'snapshot-2026-08-21T12-00-00-000Z.json'), {
      scrapedAt: '2026-08-21T12:00:00.000Z',
      startTime: '2026-08-21T18:00:00.000Z',
      fav: 2.05,
      favSide: 'Away',
    });

    const report = await runHarnessOverHistory({ dataDir: dir, maxDays: 10 });
    assert.equal(report.mode, 'multi-day');
    assert.equal(report.days, 2);
    assert.equal(report.status, 'EQUIVALENT');
    assert.equal(report.totals.legacyCandidates, 2); // one per day
    assert.equal(report.totals.engineCandidates, 2);
    assert.equal(report.totals.exactMatches, 2);
    assert.equal(report.totals.legacyOnlyCount, 0);
    assert.equal(report.totals.engineOnlyCount, 0);
    assert.ok(report.fiveMarketConsistent);
    assert.deepEqual(report.legacyOnlyKeys, []);
    assert.deepEqual(report.engineOnlyKeys, []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── Frozen band invariant ───────────────────────────────────────────────────
test('harness: legacy uses the frozen [1.8,2.2) band, never env', async () => {
  const band = frozenFavBand();
  assert.equal(band.lo, 1.8);
  assert.equal(band.hi, 2.2);
  // Legacy candidates must exclude a 1.5 favorite even if someone sets env.
  process.env.FAV_BAND_LO = '1.0';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eq-frozen-'));
  try {
    makeSnapshot(path.join(dir, 'snapshot-2026-08-22T12-00-00-000Z.json'), {
      scrapedAt: '2026-08-22T12:00:00.000Z',
      startTime: '2026-08-22T18:00:00.000Z',
      fav: 1.5,
    });
    const rep = await runHarnessOverHistory({ dataDir: dir, maxDays: 5 });
    assert.equal(rep.totals.legacyCandidates, 0, '1.5 favorite must be excluded by frozen band');
    assert.equal(rep.totals.engineCandidates, 0);
  } finally {
    delete process.env.FAV_BAND_LO;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── runHarnessOnDb wrapper ─────────────────────────────────────────────────
test('harness: runHarnessOnDb reports EQUIVALENT for the fixture DB', () => {
  const report = runHarnessOnDb({ db: sampleDb(), now: Date.parse('2029-01-01T00:00:00Z') });
  assert.equal(report.mode, 'single-db');
  assert.equal(report.status, 'EQUIVALENT');
  assert.ok(report.fiveMarketConsistent);
});
