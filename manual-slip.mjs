import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE, fetchEventMarkets, isSimulated } from './lib/common.mjs';
import { buildFavRows, selectFavBand1X2Picks } from './lib/favband.mjs';
import { createShareCode, loadShareCode, shareUrl, ticketSummary } from './share-code.mjs';

// ---------------------------------------------------------------------------
// Manual betslip generator — the HUMAN-IN-THE-LOOP track.
//
// Selects from the SAME source (odds-db.json) with the SAME predicate
// (buildFavRows + selectFavBand1X2Picks) as the paper track, so every manual
// selection is a member of the exact set the paper track evaluates. It NEVER
// places a bet and does NOT depend on STAKE_AUTOPLACE_ENABLED.
//
// Each pick is recorded to data/manual-bets.json (status: GENERATED) so the
// manually-placed subset can later be compared against the 30+ paper track.
// The recorded `status` is what YOU did; the objective match outcome must come
// from the settlement source, never a hand-edited WON/LOST.
// ---------------------------------------------------------------------------

const MANUAL_FILE = path.join(DATA_DIR, 'manual-bets.json');
const FAV_MARKET = '1';

function loadManual() {
  try {
    return JSON.parse(fs.readFileSync(MANUAL_FILE, 'utf8'));
  } catch {
    return { bets: [] };
  }
}

function saveManual(obj) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(MANUAL_FILE, JSON.stringify(obj, null, 2));
}

async function resolveOutcomeId(eventId, favName) {
  const data = await fetchEventMarkets(eventId);
  for (const m of data?.markets ?? []) {
    if (String(m.id) !== FAV_MARKET) continue;
    const o = (m.outcomes ?? []).find(
      (x) => String(x.desc).trim().toLowerCase() === String(favName).trim().toLowerCase()
    );
    if (o) return { outcomeId: String(o.id), specifier: m.specifier ?? undefined };
  }
  return null;
}

const BAR = '─'.repeat(34);

// Five raw SportyBet markets. FAV_BAND only ever qualifies 1X2 (id 1); the rest
// are shown for coverage and will report 0 qualifying selections by construction.
const MARKET_SECTIONS = [
  { id: '1', label: '1X2' },
  { id: '18', label: 'O/U (Over/Under)' },
  { id: '41', label: 'Correct Score' },
  { id: '548', label: 'Multigoals' },
  { id: '551', label: 'Multiscores' },
];

async function main() {
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error(`manual-slip: cannot read ${DB_FILE}: ${e.message}`);
    process.exit(0);
  }

  const lo = process.env.FAV_BAND_LO ?? 1.8;
  const hi = process.env.FAV_BAND_HI ?? 2.2;
  const DAY = process.env.MANUAL_DAY; // optional UTC-date filter YYYY-MM-DD

  const byId = new Map(Object.entries(db.events ?? {}));

  // Strategy A — selector UNCHANGED; same set the paper track evaluates.
  let picks = selectFavBand1X2Picks(buildFavRows(db), lo, hi);

  // SAFETY: drop simulated (SRL) events — never stake virtual matches.
  const before = picks.length;
  picks = picks.filter((p) => {
    const e = byId.get(p.eventId);
    return !(isSimulated(e?.homeTeam) || isSimulated(e?.awayTeam) || isSimulated(e?.tournament));
  });
  const droppedSim = before - picks.length;

  if (DAY) picks = picks.filter((p) => (byId.get(p.eventId)?.startTime ?? '').startsWith(DAY));

  // --- Section coverage: all five markets, only 1X2 qualifies ---
  console.log(`\nSECTION COVERAGE — FAV_BAND [${lo}, ${hi})`);
  console.log(BAR);
  console.log('(UI merges 1X2 + O/U into one "1X2 / O/U" display section)');
  for (const s of MARKET_SECTIONS) {
    const n = s.id === '1' ? picks.length : 0;
    console.log(`${s.label.padEnd(18)} qualifying: ${n}`);
  }
  console.log(BAR);

  console.log(
    `\nFAV_BAND 1X2 CANDIDATES${DAY ? ' on ' + DAY : ''} (real matches only)`
  );
  console.log(`Excluded ${droppedSim} simulated match(es). Candidates: ${picks.length}`);
  console.log(BAR);
  if (!picks.length) {
    console.log('No qualifying picks right now.');
    console.log(BAR);
    return;
  }

  const W = { fx: 38, comp: 24, ko: 12, sel: 5, odds: 8, band: 8, sim: 4 };
  console.log(
    [
      'FIXTURE'.padEnd(W.fx),
      'COMPETITION'.padEnd(W.comp),
      'KICKOFF'.padEnd(W.ko),
      'SEL'.padEnd(W.sel),
      'ODDS'.padEnd(W.odds),
      'INBAND'.padEnd(W.band),
      'SIM'.padEnd(W.sim),
    ].join('')
  );
  console.log(BAR);
  for (const p of picks) {
    const e = byId.get(p.eventId) ?? {};
    const ko = (e.startTime ?? '').replace('T', ' ').replace(/\.\d+Z$/, 'Z').slice(0, 17);
    const fx = `${p.homeTeam} vs ${p.awayTeam}`.slice(0, W.fx);
    const inBand = p.favLast >= lo && p.favLast < hi ? 'YES' : 'NO';
    console.log(
      [
        fx.padEnd(W.fx),
        String(e.tournament ?? '').slice(0, W.comp).padEnd(W.comp),
        ko.padEnd(W.ko),
        p.favName.padEnd(W.sel),
        String(p.favLast).padEnd(W.odds),
        inBand.padEnd(W.band),
        'NO'.padEnd(W.sim),
      ].join('')
    );
  }
  console.log(BAR);
  console.log('All candidates are in the 1X2 section. Verify kickoff + live odds on SportyBet before staking.');

  if (process.env.NO_SHARE) {
    console.log('\nShare-code generation skipped (NO_SHARE set).');
    return;
  }

  const selections = [];
  const resolved = [];
  for (const p of picks) {
    const r = await resolveOutcomeId(p.eventId, p.favName).catch((e) => {
      console.error(`  - ${p.homeTeam} vs ${p.awayTeam}: ${e.message}`);
      return null;
    });
    if (!r) {
      console.error(`  - ${p.homeTeam} vs ${p.awayTeam} (${p.favName}): could not resolve outcome id`);
      continue;
    }
    selections.push({
      eventId: p.eventId,
      marketId: FAV_MARKET,
      outcomeId: r.outcomeId,
      ...(r.specifier ? { specifier: r.specifier } : {}),
    });
    resolved.push(p);
  }

  if (!selections.length) {
    console.error('No resolvable selections — no code generated.');
    console.log(BAR);
    return;
  }

  const { code } = await createShareCode(selections);
  const data = await loadShareCode(code);

  console.log('\nSPORTYBET BETSLIP');
  console.log(`CODE: ${code}`);
  console.log(`URL:  ${shareUrl(code)}`);
  console.log('Stake: [you choose]');
  console.log('Auto-stake: OFF');
  console.log(BAR);
  console.log(ticketSummary(data));

  // Record for later manual-vs-paper comparison. Dedup by event+outcome so
  // re-runs extend the ledger instead of duplicating.
  const manual = loadManual();
  const seen = new Set((manual.bets ?? []).map((b) => `${b.eventId}|${b.outcome}`));
  let added = 0;
  for (const p of resolved) {
    const key = `${p.eventId}|${p.favName}`;
    if (seen.has(key)) continue;
    manual.bets.push({
      generatedAt: new Date().toISOString(),
      eventId: p.eventId,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      market: '1X2',
      outcome: p.favName,
      odds: p.favLast,
      code,
      status: 'GENERATED',
    });
    seen.add(key);
    added++;
  }
  saveManual(manual);
  if (added) {
    console.log(`\nRecorded ${added} new pick(s) to ${MANUAL_FILE} (status GENERATED).`);
    console.log('Outcome must come from the objective settlement source, not a hand-edited WON/LOST.');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`manual-slip failed: ${e.message}`);
    process.exit(1);
  });
}
