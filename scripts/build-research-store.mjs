// ---------------------------------------------------------------------------
// Build the research stores (H2H + team-form) from the persistent odds-db.
//
// Best-effort, read-only companion to the collector: derives data/h2h.json and
// data/team-form.json from the settled events already in odds-db.json. These are
// the inputs the ablation harness consumes (--features=h2h.json, --form=team-form.json).
// The Flashscore feed (flashscore.ts) can later enrich team-form.json with real
// standings/position; this guarantees the artifacts always exist and accumulate.
//
// Run by .github/workflows/collector.yml after build-db.mjs. Never commits to main.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import { loadDb } from '../lib/common.mjs';
import { buildH2HFromDb, saveH2H } from '../lib/h2h.mjs';
import { buildTeamFormStoreFromDb, saveTeamForm } from '../lib/team-form.mjs';

const DATA_DIR = process.env.DATA_DIR ?? 'data';

async function main() {
  let db;
  try {
    db = await loadDb();
  } catch (e) {
    console.log(`[build-research-store] no odds-db.json (${e.message}); nothing to do`);
    return;
  }

  const h2h = buildH2HFromDb(db);
  saveH2H(h2h, `${DATA_DIR}/h2h.json`);
  console.log(`[build-research-store] wrote ${h2h.meetings.length} H2H meetings -> ${DATA_DIR}/h2h.json`);

  const formStore = buildTeamFormStoreFromDb(db);
  const teams = Object.keys(formStore).length;
  saveTeamForm(formStore, `${DATA_DIR}/team-form.json`);
  console.log(`[build-research-store] wrote team-form for ${teams} teams -> ${DATA_DIR}/team-form.json`);
}

main();
