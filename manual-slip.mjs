import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, fetchEventMarkets } from './lib/common.mjs';
import { createShareCode, loadShareCode, shareUrl, ticketSummary } from './share-code.mjs';

// ---------------------------------------------------------------------------
// Manual betslip generator — the HUMAN-IN-THE-LOOP track.
//
// Consumes ONLY the FAV_BAND 1X2 picks already flagged by the agent (the exact
// same picks the paper track logs in paper-picks.json), resolves their
// SportyBet outcome ids, and produces a shareable betslip code. It NEVER
// places a bet and does NOT depend on STAKE_AUTOPLACE_ENABLED — that secret
// gates automatic staking only; this script is the independent manual path.
//
// Picks are recorded (status: GENERATED) to data/manual-bets.json so the
// manually-placed subset can later be compared against the 30+ paper track.
// This is measurement/usability tooling, not a strategy change.
// ---------------------------------------------------------------------------

const AGENT_FILE = path.join(DATA_DIR, 'agent-recommendations.json');
const MANUAL_FILE = path.join(DATA_DIR, 'manual-bets.json');
const FAV_MARKET = '1';

export function extractFavBandPicks(report) {
  const picks = [];
  for (const rec of report.matches ?? []) {
    const { match, candidates } = rec;
    for (const c of candidates ?? []) {
      if (
        c.marketId === FAV_MARKET &&
        c.recommended &&
        /FAVORITE VALUE band/i.test(c.reason ?? '')
      ) {
        picks.push({ match, candidate: c });
      }
    }
  }
  return picks;
}

async function resolveOutcomeId(eventId, outcomeName) {
  const data = await fetchEventMarkets(eventId);
  for (const m of data?.markets ?? []) {
    if (String(m.id) !== FAV_MARKET) continue;
    const o = (m.outcomes ?? []).find(
      (x) => String(x.desc).trim().toLowerCase() === String(outcomeName).trim().toLowerCase()
    );
    if (o) return { outcomeId: String(o.id), specifier: m.specifier ?? undefined };
  }
  return null;
}

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

const BAR = '─'.repeat(34);

async function main() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
  } catch (e) {
    console.error(`manual-slip: cannot read ${AGENT_FILE}: ${e.message}`);
    process.exit(0);
  }

  const lo = process.env.FAV_BAND_LO ?? 1.8;
  const hi = process.env.FAV_BAND_HI ?? 2.2;
  const picks = extractFavBandPicks(report);

  console.log(`\nPAPER RECOMMENDATIONS (FAV_BAND [${lo}, ${hi}))`);
  console.log(BAR);
  if (!picks.length) {
    console.log('No FAV_BAND 1X2 picks to slip right now.');
    console.log(BAR);
    return;
  }
  picks.forEach((p, i) => {
    const c = p.candidate;
    console.log(`${i + 1}. ${p.match.homeTeam} vs ${p.match.awayTeam}`);
    console.log(`   Pick: ${c.outcome}`);
    console.log(`   Odds: ${c.odds}`);
    console.log(`   Confidence: ${c.confidence != null ? c.confidence.toFixed(2) : 'n/a'}`);
  });
  console.log(`Selected: ${picks.length}`);
  console.log(BAR);

  const selections = [];
  const resolved = [];
  for (const p of picks) {
    const c = p.candidate;
    const r = await resolveOutcomeId(p.match.eventId, c.outcome).catch((e) => {
      console.error(`  - ${p.match.homeTeam} vs ${p.match.awayTeam} (${c.outcome}): ${e.message}`);
      return null;
    });
    if (!r) {
      console.error(`  - ${p.match.homeTeam} vs ${p.match.awayTeam} (${c.outcome}): could not resolve outcome id`);
      continue;
    }
    selections.push({
      eventId: p.match.eventId,
      marketId: FAV_MARKET,
      outcomeId: r.outcomeId,
      ...(r.specifier ? { specifier: r.specifier } : {}),
    });
    resolved.push({ match: p.match, candidate: c });
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
    const key = `${p.match.eventId}|${p.candidate.outcome}`;
    if (seen.has(key)) continue;
    manual.bets.push({
      generatedAt: new Date().toISOString(),
      eventId: p.match.eventId,
      homeTeam: p.match.homeTeam,
      awayTeam: p.match.awayTeam,
      market: p.candidate.market,
      outcome: p.candidate.outcome,
      odds: p.candidate.odds,
      confidence: p.candidate.confidence,
      code,
      status: 'GENERATED',
    });
    seen.add(key);
    added++;
  }
  saveManual(manual);
  if (added) {
    console.log(`\nRecorded ${added} new pick(s) to ${MANUAL_FILE} (status GENERATED).`);
    console.log('Update status to PLACED / WON / LOST once you act on them.');
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`manual-slip failed: ${e.message}`);
    process.exit(1);
  });
}
