import fs from 'node:fs/promises';
import path from 'node:path';
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

// Merge a snapshot into the persistent DB. Plays are de-duplicated by
// (odds rounded to 2dp, scrapedAt) so re-runs and same-minute retries
// do not inflate the history.
async function ingestSnapshot(db, file) {
  const data = JSON.parse(await fs.readFile(file, 'utf8'));
  const scrapedAt = data.scrapedAt;
  for (const m of data.matches ?? []) {
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
        const play = ev.outcomes[k].plays.find(
          (p) => p.odds === o.odds && p.scrapedAt === scrapedAt
        );
        if (!play) {
          ev.outcomes[k].plays.push({ odds: o.odds, active: o.active, scrapedAt });
        }
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
  await saveDb(db);

  const events = Object.values(db.events);
  let plays = 0;
  let settled = 0;
  for (const ev of events) {
    for (const o of Object.values(ev.outcomes)) plays += o.plays.length;
    if (ev.finalScore) settled++;
  }
  console.log(`Merged ${seen} snapshot(s) -> ${events.length} event(s), ${plays} recorded odds play(s).`);
  console.log(`Settled events: ${settled}`);
  console.log(`DB: ${DB_FILE}`);
}

run().catch((e) => {
  console.error(`build-db failed: ${e.message}`);
  process.exit(1);
});
