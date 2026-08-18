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
// observations just bump the last-seen stamp. `seenAt` stays the earliest
// observation and `lastSeen` the latest, regardless of ingest order, so the
// 5-min pre-match logs and 30-min snapshots can merge without drift.
export function recordPlay(plays, odds, active, scrapedAt) {
  const existing = plays.find((p) => p.odds === odds);
  if (existing) {
    existing.active = active;
    if (scrapedAt < existing.seenAt) existing.seenAt = scrapedAt;
    if (scrapedAt > existing.lastSeen) existing.lastSeen = scrapedAt;
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
export async function ingestSnapshot(db, file) {
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
    // Stop recording odds once the match kicks off. The scheduled kickoff is
    // the hard stop: a snapshot scraped at/after startTime must not append
    // plays for a match that has already started (the "73 post-kickoff
    // events" bug). The match record itself is still kept so it can settle.
    const kickoff = m.startTime ? new Date(m.startTime).getTime() : null;
    if (kickoff !== null && new Date(scrapedAt).getTime() >= kickoff) continue;
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

// Merge a pre-match monitor log (data/prematch-<eventId>.json) into the DB.
// The log holds one change entry per odds change in the final pre-match window
// (a 5-min cadence that only saves sections whose odds actually changed). Each
// entry is stamped `at` and carries the same section->outcome shape as a
// snapshot, so we ingest it the same way recordPlay dedups by odds value.
// Plays at/after kickoff are dropped (the monitor already stops at LIVE/kickoff,
// this guards against any late entries).
export async function ingestPrematchLog(db, file) {
  const log = JSON.parse(await fs.readFile(file, 'utf8'));
  const kickoff = log.kickoff ? new Date(log.kickoff).getTime() : null;
  if (!log.eventId || !log.homeTeam || !log.awayTeam) return;
  if (!db.events[log.eventId]) {
    db.events[log.eventId] = {
      eventId: log.eventId,
      homeTeam: log.homeTeam,
      awayTeam: log.awayTeam,
      tournament: null,
      category: null,
      startTime: kickoff !== null ? new Date(kickoff).toISOString() : null,
      firstSeen: null,
      lastSeen: null,
      finalScore: null,
      settledAt: null,
      outcomes: {},
    };
  }
  const ev = db.events[log.eventId];
  for (const ch of log.changes ?? []) {
    if (!ch.at || !ch.sections) continue;
    const atMs = new Date(ch.at).getTime();
    if (kickoff !== null && atMs >= kickoff) continue;
    if (ev.firstSeen === null || atMs < new Date(ev.firstSeen).getTime()) ev.firstSeen = ch.at;
    if (ev.lastSeen === null || atMs > new Date(ev.lastSeen).getTime()) ev.lastSeen = ch.at;
    for (const [key, market] of Object.entries(ch.sections)) {
      if (!market) continue;
      for (const o of market.outcomes ?? []) {
        const marketId = o.marketId ?? market.marketId;
        const k = outcomeKey(marketId, o.name);
        if (!ev.outcomes[k]) {
          ev.outcomes[k] = { marketId, name: o.name, plays: [] };
        }
        recordPlay(ev.outcomes[k].plays, o.odds, o.active, ch.at);
      }
    }
  }
}

async function run() {
  const files = (await fs.readdir(DATA_DIR)).filter((f) => /^snapshot-.*\.json$/.test(f));
  const prematchFiles = (await fs.readdir(DATA_DIR)).filter((f) => /^prematch-.*\.json$/.test(f));
  console.log(`Found ${files.length} snapshot(s) and ${prematchFiles.length} pre-match log(s) in ${DATA_DIR}`);
  const db = await loadOrCreateDb();
  let seen = 0;
  for (const f of files.sort()) {
    await ingestSnapshot(db, path.join(DATA_DIR, f));
    seen++;
  }
  let prematchSeen = 0;
  for (const f of prematchFiles.sort()) {
    await ingestPrematchLog(db, path.join(DATA_DIR, f));
    prematchSeen++;
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
  // Enforce "recording stops at kickoff" retroactively. Any play first sighted
  // at/after startTime never existed pre-match and is dropped; plays first seen
  // before kickoff have their lastSeen clamped to kickoff so no observation
  // extends past the moment the match started.
  let dropped = 0;
  let clamped = 0;
  for (const ev of Object.values(db.events)) {
    const kickoff = ev.startTime ? new Date(ev.startTime).getTime() : null;
    if (kickoff === null) continue;
    const kickoffIso = ev.startTime;
    for (const o of Object.values(ev.outcomes ?? {})) {
      const before = o.plays.length;
      o.plays = o.plays.filter((p) => !p.seenAt || new Date(p.seenAt).getTime() < kickoff);
      dropped += before - o.plays.length;
      for (const p of o.plays) {
        if (p.lastSeen && new Date(p.lastSeen).getTime() > kickoff) {
          p.lastSeen = kickoffIso;
          clamped++;
        }
      }
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
  console.log(`Merged ${seen} snapshot(s) + ${prematchSeen} pre-match log(s) -> ${events.length} event(s), ${plays} distinct-odds play(s).`);
  if (compacted) console.log(`Compacted ${compacted} duplicate-odds play(s) from prior snapshots.`);
  if (dropped) console.log(`Dropped ${dropped} post-kickoff play(s) (recording stops at kickoff).`);
  if (clamped) console.log(`Clamped ${clamped} play(s) to kickoff (no observation past start).`);
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
