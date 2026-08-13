import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE, loadDb, saveDb } from './lib/common.mjs';

async function loadOrCreateDb() {
  try {
    return await loadDb();
  } catch {
    return { version: 1, updatedAt: null, events: {} };
  }
}

function outcomeKey(marketId, name) {
  return `${marketId}|${name}`;
}

// A match is only resolvable against Flashscore if it has both teams and a
// kickoff time (our join key). Matches missing any of these can never be
// settled, so we keep them out of the DB entirely.
function hasJoinKey(m) {
  return !!(m.homeTeam && m.awayTeam && m.startTime);
}

// Record one play per distinct odds value, not one per snapshot. A price that
// holds for hours at a 30-min cadence used to append a play every snapshot
// (16k+ plays, ~2/3 at identical odds); now the first sighting wins and later
// snapshots just bump the last-seen stamp. `seenAt` stays the earliest
// observation so the play keeps its origin.
export function recordPlay(plays, odds, active, scrapedAt) {
  const existing = plays.find((p) => p.odds === odds);
  if (existing) {
    existing.active = active;
    existing.lastSeen = scrapedAt;
    return;
  }
  plays.push({ odds, active, seenAt: scrapedAt, lastSeen: scrapedAt });
}

// Compaction for pre-fix DBs: merge any plays already in the file that share
// an odds value into one play. Same rule as recordPlay, applied retroactively.
export function compactOutcome(plays) {
  const byOdds = new Map();
  for (const p of plays) {
    const existing = byOdds.get(p.odds);
    if (!existing) {
      byOdds.set(p.odds, { ...p });
      if (!('lastSeen' in p)) p.lastSeen = p.scrapedAt;
      continue;
    }
    existing.active = p.active ?? existing.active;
    existing.lastSeen = p.lastSeen ?? p.scrapedAt ?? existing.lastSeen;
  }
  return [...byOdds.values()];
}

// Merge a snapshot into the persistent DB. Plays are de-duplicated by
// (odds rounded to 2dp, scrapedAt) so re-runs and same-minute retries
// do not inflate the history.
async function ingestSnapshot(db, file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  const scrapedAt = data.scrapedAt;
  for (const m of data.matches ?? []) {
    if (!hasJoinKey(m)) continue;
    if (!db.events[m.eventId]) {
      db.events[m.eventId] = {
        eventId: m.eventId,
        homeTeam: m.homeTeam,
        awayTeam: m.awayTeam,
        tournament: m.tournament,
        category: m.category,
        startTime: m.startTime,
        firstSeen: scrapedAt,
        lastSeen: scrapedAt,
        finalScore: null,
        settledAt: null,
        outcomes: {},
      };
    }
    const ev = db.events[m.eventId];
    ev.eventId = m.eventId;
    if (scrapedAt < ev.firstSeen) ev.firstSeen = scrapedAt;
    if (scrapedAt > ev.lastSeen) ev.lastSeen = scrapedAt;
    for (const [key, market] of Object.entries(m.markets ?? {})) {
      if (!market) continue;
      for (const o of market.outcomes ?? []) {
        const marketId = o.marketId ?? market.marketId;
        const k = outcomeKey(marketId, o.name);
        if (!ev.outcomes[k]) {
          ev.outcomes[k] = { marketId, name: o.name, plays: [] };
        }
        recordPlay(ev.outcomes[k].plays, o.odds, o.active, scrapedAt);
      }
    }
  }
}

async function run() {
  const files = (await fs.readdir(DATA_DIR)).filter((f) => /^snapshot-.*\.json$/.test(f));
  console.log(`Found ${files.length} snapshot(s) in ${DATA_DIR}`);
  const db = await loadOrCreateDb();
  let seen = 0;
  for (const f of files.sort()) {
    await ingestSnapshot(db, path.join(DATA_DIR, f));
    seen++;
  }
  // Prune any pre-existing events that lack the join key (e.g. malformed
  // matches ingested before this guard existed).
  let pruned = 0;
  for (const id of Object.keys(db.events)) {
    const ev = db.events[id];
    if (!ev.homeTeam || !ev.awayTeam || !ev.startTime) {
      delete db.events[id];
      pruned++;
    }
  }
  // Compact plays from pre-fix snapshots: merge plays sharing an odds value so
  // the per-snapshot bloat (identical-odds repeats) collapses to one play each.
  let compacted = 0;
  for (const ev of Object.values(db.events)) {
    for (const o of Object.values(ev.outcomes ?? {})) {
      const before = o.plays.length;
      o.plays = compactOutcome(o.plays);
      compacted += before - o.plays.length;
    }
  }
  await saveDb(db);

  const events = Object.values(db.events);
  let plays = 0;
  let settled = 0;
  for (const ev of events) {
    for (const o of Object.values(ev.outcomes)) plays += o.plays.length;
    if (ev.finalScore) settled++;
  }
  console.log(`Merged ${seen} snapshot(s) -> ${events.length} event(s), ${plays} distinct-odds play(s).`);
  if (compacted) console.log(`Compacted ${compacted} duplicate-odds play(s) from prior snapshots.`);
  if (pruned) console.log(`Pruned ${pruned} unresolvable event(s) (missing team/startTime).`);
  console.log(`Settled events: ${settled}`);
  console.log(`DB: ${DB_FILE}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error(`build-db failed: ${e.message}`);
    process.exit(1);
  });
}
