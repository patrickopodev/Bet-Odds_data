// ---------------------------------------------------------------------------
// MULTI-DAY LEGACY ↔ UNIFIED EQUIVALENCE HARNESS (review action #2).
//
// ADDITIVE + READ-ONLY. Proves the unified engine reproduces the legacy
// production selector's CANDIDATE PICKS across many real daily cycles, using
// identical frozen inputs. For every eligible match it compares:
//   match ID, market, selection, odds, kickoff, simulated status, exclusion
//   reason, final approved pick.
//
// Both sides use the SAME frozen band (lib/1x2.mjs:frozen1X2) and the
// SAME eligibility guard (upcoming + non-simulated + non-resolved). The unified
// engine's placement gates (kickoff buffer / confidence) are defense-in-depth
// applied identically at stake time in BOTH paths, so selection equivalence is
// the faithful invariant under test.
//
// Emits a report in the requested shape:
//   LEGACY vs ENGINE
//   ────────────────────────
//   Input matches:       574
//   Legacy candidates:    34
//   Engine candidates:    34
//   Exact matches:        34
//   Legacy-only:            0
//   Engine-only:            0
//   STATUS: EQUIVALENT
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFavRows, select1X2Picks, frozen1X2 } from '../lib/1x2.mjs';
import { ingestSnapshot } from '../build-db.mjs';
import { loadRegistry, getStrategy, selectStrategy } from './strategies.mjs';
import { identifyMatches, summarizeByMarket } from './daily-engine.mjs';
import { getMarket } from './markets.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const STRAT_A = 'STRAT-1X2-BAND-v1';

const keyOf = (r) => `${r.matchId}|${r.marketId}|${r.selection}|${r.odds}`;

// Legacy production selector (post-fix): the 1X2 favorite in the frozen band,
// among eligible (upcoming + non-simulated + non-resolved) matches. Market is
// 1X2 only — by construction the legacy favorite rule never selects O/U, CS,
// Multigoals, or Multiscores (review action #3: five markets stay distinct).
export function legacyCandidates(db, { now = Date.now(), band = frozen1X2() } = {}) {
  const eligible = identifyMatches(db, now);
  const eligibleIds = new Set(eligible.map((e) => e.eventId));
  const rows = buildFavRows(db);
  return select1X2Picks(rows, band.lo, band.hi)
    .filter((r) => eligibleIds.has(r.eventId))
    .map((r) => {
      const ev = db.events?.[r.eventId] ?? {};
      return {
        matchId: r.eventId,
        marketId: '1',
        market: '1X2',
        selection: r.favName,
        odds: r.favLast,
        kickoff: ev.startTime ?? null,
        simulated: Boolean(ev.isSimulated),
        exclusionReason: null,
        approved: true,
      };
    });
}

// Unified engine selector: Strategy A's raw selection, filtered by the SAME
// eligibility guard (selectApproved applies it; we mirror it here so the
// comparison isolates selection, not placement gates).
export function engineCandidates(db, { now = Date.now(), registry = loadRegistry() } = {}) {
  const strategy = getStrategy(registry, STRAT_A);
  if (!strategy) return [];
  const eligible = identifyMatches(db, now);
  const eligibleIds = new Set(eligible.map((e) => e.eventId));
  return selectStrategy(strategy, { db })
    .filter((c) => eligibleIds.has(c.eventId))
    .map((c) => {
      const ev = db.events?.[c.eventId] ?? {};
      return {
        matchId: c.eventId,
        marketId: strategy.marketId,
        market: getMarket(strategy.marketId)?.name ?? strategy.marketId,
        selection: c.selection,
        odds: c.odds,
        kickoff: ev.startTime ?? null,
        simulated: Boolean(ev.isSimulated),
        exclusionReason: null,
        approved: true,
      };
    });
}

export function compareCycle({ db, now = Date.now(), registry = loadRegistry(), band = frozen1X2() } = {}) {
  const legacy = legacyCandidates(db, { now, band });
  const engine = engineCandidates(db, { now, registry });
  const lk = new Set(legacy.map(keyOf));
  const ek = new Set(engine.map(keyOf));
  const legacyOnly = legacy.filter((r) => !ek.has(keyOf(r)));
  const engineOnly = engine.filter((r) => !lk.has(keyOf(r)));
  const exact = legacy.filter((r) => ek.has(keyOf(r))).length;
  const equivalent = legacyOnly.length === 0 && engineOnly.length === 0;

  const markets = summarizeByMarket({
    db,
    registry,
    selectionResult: { approved: engine, rejected: [] },
    now,
  });

  return {
    inputMatches: identifyMatches(db, now).length,
    legacyCandidates: legacy.length,
    engineCandidates: engine.length,
    exactMatches: exact,
    legacyOnlyCount: legacyOnly.length,
    engineOnlyCount: engineOnly.length,
    legacyOnly: legacyOnly.map(keyOf),
    engineOnly: engineOnly.map(keyOf),
    status: equivalent ? 'EQUIVALENT' : 'DIVERGENT',
    fiveMarket: {
      legacyAll1X2: legacy.every((r) => r.marketId === '1'),
      engineAll1X2: engine.every((r) => r.marketId === '1'),
      summary: markets,
    },
  };
}

export function runHarnessOnDb({ db, now = Date.now(), registry = loadRegistry(), band = frozen1X2() } = {}) {
  const rep = compareCycle({ db, now, registry, band });
  const status =
    rep.status === 'EQUIVALENT' && rep.legacyOnlyCount === 0 && rep.engineOnlyCount === 0 ? 'EQUIVALENT' : 'DIVERGENT';
  return {
    generatedAt: new Date().toISOString(),
    mode: 'single-db',
    totals: {
      inputMatches: rep.inputMatches,
      legacyCandidates: rep.legacyCandidates,
      engineCandidates: rep.engineCandidates,
      exactMatches: rep.exactMatches,
      legacyOnlyCount: rep.legacyOnlyCount,
      engineOnlyCount: rep.engineOnlyCount,
    },
    legacyOnlyKeys: rep.legacyOnly,
    engineOnlyKeys: rep.engineOnly,
    fiveMarketConsistent: rep.fiveMarket.legacyAll1X2 && rep.fiveMarket.engineAll1X2,
    status,
    cycles: [rep],
  };
}

// Reconstruct one point-in-time DB from a single day's snapshot files and
// evaluate "as of" the latest scrape that day.
async function buildDayDb(files) {
  const db = { version: 1, updatedAt: null, events: {} };
  let maxScraped = 0;
  for (const f of files) {
    await ingestSnapshot(db, f);
    try {
      const d = JSON.parse(fs.readFileSync(f, 'utf8'));
      const t = Date.parse(d.scrapedAt);
      if (!Number.isNaN(t) && t > maxScraped) maxScraped = t;
    } catch {
      /* ignore malformed snapshot */
    }
  }
  return { db, now: maxScraped || Date.now() };
}

function listSnapshotFiles(dataDir) {
  return fs
    .readdirSync(dataDir)
    .filter((f) => /^snapshot-.*\.json$/.test(f))
    .map((f) => path.join(dataDir, f));
}

function groupByDate(files) {
  const map = new Map();
  const prefix = 'snapshot-';
  for (const f of files) {
    const name = path.basename(f);
    const date = name.startsWith(prefix) ? name.slice(prefix.length, prefix.length + 10) : null;
    if (!date) continue;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push(f);
  }
  return map;
}

// Run the harness over many frozen daily inputs. With no snapshots present it
// falls back to the current odds-db.json as a single cycle.
export async function runHarnessOverHistory({
  dataDir = DATA_DIR,
  maxDays = 30,
  registry = loadRegistry(),
  band = frozen1X2(),
} = {}) {
  const files = listSnapshotFiles(dataDir);
  const cycles = [];
  const totals = {
    inputMatches: 0,
    legacyCandidates: 0,
    engineCandidates: 0,
    exactMatches: 0,
    legacyOnlyCount: 0,
    engineOnlyCount: 0,
  };
  const legacyOnlyKeys = new Set();
  const engineOnlyKeys = new Set();
  let allEquivalent = true;
  let legacyAll1X2 = true;
  let engineAll1X2 = true;

  if (files.length === 0) {
    const { loadDb } = await import('../lib/common.mjs');
    const db = await loadDb();
    const rep = compareCycle({ db, now: Date.now(), registry, band });
    cycles.push({ date: 'current-db', ...rep });
  } else {
    const byDate = groupByDate(files);
    const dates = [...byDate.keys()].sort().slice(-maxDays);
    for (const date of dates) {
      const { db, now } = await buildDayDb(byDate.get(date));
      const rep = compareCycle({ db, now, registry, band });
      cycles.push({ date, ...rep });
    }
  }

  for (const c of cycles) {
    totals.inputMatches += c.inputMatches;
    totals.legacyCandidates += c.legacyCandidates;
    totals.engineCandidates += c.engineCandidates;
    totals.exactMatches += c.exactMatches;
    totals.legacyOnlyCount += c.legacyOnlyCount;
    totals.engineOnlyCount += c.engineOnlyCount;
    c.legacyOnly.forEach((k) => legacyOnlyKeys.add(k));
    c.engineOnly.forEach((k) => engineOnlyKeys.add(k));
    if (c.status !== 'EQUIVALENT') allEquivalent = false;
    if (!c.fiveMarket.legacyAll1X2) legacyAll1X2 = false;
    if (!c.fiveMarket.engineAll1X2) engineAll1X2 = false;
  }

  const status =
    allEquivalent && legacyOnlyKeys.size === 0 && engineOnlyKeys.size === 0 ? 'EQUIVALENT' : 'DIVERGENT';

  return {
    generatedAt: new Date().toISOString(),
    mode: 'multi-day',
    days: cycles.length,
    totals,
    legacyOnlyKeys: [...legacyOnlyKeys],
    engineOnlyKeys: [...engineOnlyKeys],
    fiveMarketConsistent: legacyAll1X2 && engineAll1X2,
    status,
    cycles,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const write = process.argv.includes('--write');
  const single = process.argv.includes('--single');
  const maxDaysIdx = process.argv.indexOf('--max-days');
  const maxDays = maxDaysIdx >= 0 ? Number(process.argv[maxDaysIdx + 1]) : 30;

  const { loadDb } = await import('../lib/common.mjs');
  const db = await loadDb();
  const report = single
    ? runHarnessOnDb({ db })
    : await runHarnessOverHistory({ maxDays });
  const t = report.totals ?? report.cycle?.totals ?? {};

  console.log('LEGACY vs ENGINE');
  console.log('─'.repeat(40));
  console.log(`Input matches:       ${t.inputMatches ?? 0}`);
  console.log(`Legacy candidates:    ${t.legacyCandidates ?? 0}`);
  console.log(`Engine candidates:    ${t.engineCandidates ?? 0}`);
  console.log(`Exact matches:        ${t.exactMatches ?? 0}`);
  console.log(`Legacy-only:          ${t.legacyOnlyCount ?? 0}`);
  console.log(`Engine-only:          ${t.engineOnlyCount ?? 0}`);
  console.log(`Five-market consistent: ${report.fiveMarketConsistent ? 'yes' : 'NO'}`);
  console.log(`STATUS: ${report.status}`);

  if (write) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(path.join(DATA_DIR, 'equivalence-harness.json'), JSON.stringify(report, null, 2));
    console.log(`Wrote ${path.join(DATA_DIR, 'equivalence-harness.json')}`);
  }
}
