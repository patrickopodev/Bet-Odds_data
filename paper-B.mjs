// ---------------------------------------------------------------------------
// PAPER-B — forward paper track for the pre-specified O/U H1 hypothesis.
//
// This is an INDEPENDENT experiment from Strategy A (1X2 1X2_BAND). It never
// reads or writes paper-picks.json and never interacts with Strategy A.
//
// Frozen hypothesis (Stage 1.5b, untouched holdout +10.8% ROI / 373 bets):
//   Market: O/U (market id 18)
//   Line:   2.5   (Over 2.5 or Under 2.5)
//   Odds:   [1.80, 2.20)
// No mining, no tuning. The SPEC below is IMMUTABLE for this experiment.
//
// Behavior:
//   default  -> record FORWARD picks (kickoff in the future, not yet resolved)
//               + settle any OPEN picks whose match has since resolved.
//   --backtest -> read-only audit: recompute H1 over all resolved O/U 2.5 bets
//               (60/40 chronological split) to confirm this selector equals the
//               holdout that justified the experiment. Writes nothing.
//
// Gate: >= SPEC.gate resolved picks AND positive ROI -> ELIGIBLE FOR HUMAN
// REVIEW only. This script NEVER promotes H1 into any staking path.
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE, loadDb, parseScore, evaluateOutcome } from './lib/common.mjs';
import { roi, ci } from './lib/settlement.mjs';

// === FROZEN H1 SPEC — DO NOT EDIT DURING THE EXPERIMENT =====================
const SPEC = {
  id: 'H1',
  market: 'O/U',
  marketId: '18',
  line: 2.5,
  side: 'either', // Over 2.5 or Under 2.5
  oddsLo: 1.8,
  oddsHi: 2.2,
  gate: 30,
  defined: '2026-08-27',
  source: 'Stage 1.5b pre-specified O/U band holdout: untouched test +10.8% ROI over 373 bets',
  frozen: true,
  note: 'Immutable for the forward experiment. Do not tune to results.',
};
// ===========================================================================
const OU = SPEC.marketId;
const LEDGER = path.join(DATA_DIR, 'paper-B-picks.json');

function lineSide(name) {
  const m = String(name).match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
  return m ? { side: m[1], line: parseFloat(m[2]) } : null;
}
function lastOdds(outcome) {
  let best = null;
  let bestT = -Infinity;
  for (const p of outcome.plays ?? []) {
    const t = new Date(p.lastSeen ?? p.scrapedAt ?? 0).getTime();
    if (t >= bestT) {
      bestT = t;
      best = p.odds;
    }
  }
  return best;
}
// Returns {side, odds} if the outcome matches the frozen spec, else null.
export function inSpec(outcome) {
  const ls = lineSide(outcome.name);
  if (!ls) return null;
  if (ls.line !== SPEC.line) return null;
  if (SPEC.side !== 'either' && ls.side !== SPEC.side) return null;
  const o = lastOdds(outcome);
  if (o == null) return null;
  if (o < SPEC.oddsLo || o >= SPEC.oddsHi) return null;
  return { side: ls.side, odds: o };
}

// ---------- ledger ----------
function loadLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
    if (j.spec && j.spec.id === SPEC.id) return j;
  } catch {
    /* fresh */
  }
  return { spec: SPEC, startedAt: new Date().toISOString(), updatedAt: null, picks: [] };
}
function saveLedger(l) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(LEDGER, JSON.stringify(l, null, 2));
}

// ---------- forward run ----------
async function runForward() {
  const db = await loadDb();
  const now = Date.now();
  const ledger = loadLedger();
  const seen = new Set(ledger.picks.map((p) => `${p.eventId}:${p.side}`));
  let added = 0;

  for (const ev of Object.values(db.events ?? {})) {
    if (ev.finalScore) continue; // historical/resolved -> not a forward pick
    if (!(new Date(ev.startTime).getTime() > now)) continue; // only upcoming
    for (const o of Object.values(ev.outcomes ?? {}).filter((o) => o.marketId === OU)) {
      const m = inSpec(o);
      if (!m) continue;
      const key = `${ev.eventId}:${m.side}`;
      if (seen.has(key)) continue;
      ledger.picks.push({
        eventId: ev.eventId,
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        league: ev.tournament,
        market: SPEC.market,
        line: SPEC.line,
        side: m.side,
        odds: m.odds,
        marketId: OU,
        kickoff: ev.startTime,
        addedAt: new Date().toISOString(),
        status: 'OPEN',
        result: null,
        pnl: null,
        specId: SPEC.id,
      });
      seen.add(key);
      added++;
    }
  }

  // settle OPEN picks whose match has resolved
  const byId = new Map(Object.entries(db.events ?? {}));
  let scored = 0;
  for (const p of ledger.picks) {
    if (p.status !== 'OPEN') continue;
    const ev = byId.get(p.eventId);
    if (!ev || !ev.finalScore) continue;
    const score = parseScore(ev.finalScore);
    if (!score) continue;
    const sib = Object.values(ev.outcomes ?? {})
      .filter((o) => o.marketId === OU)
      .map((o) => o.name);
    const r = evaluateOutcome(OU, `${p.side} ${p.line}`, score, sib);
    if (r === 'WON') {
      p.status = 'WON';
      p.result = 'WON';
      p.pnl = p.odds - 1;
      scored++;
    } else if (r === 'LOST') {
      p.status = 'LOST';
      p.result = 'LOST';
      p.pnl = -1;
      scored++;
    } else if (r === 'VOID') {
      p.status = 'VOID';
      p.result = 'VOID';
      p.pnl = 0;
      scored++;
    }
  }

  ledger.updatedAt = new Date().toISOString();
  saveLedger(ledger);
  printSummary(ledger, added, scored);
}

// ---------- read-only backtest (audit) ----------
async function runBacktest() {
  const db = await loadDb();
  const bets = [];
  for (const ev of Object.values(db.events ?? {})) {
    const score = ev.finalScore ? parseScore(ev.finalScore) : null;
    if (!score) continue;
    const ou = Object.values(ev.outcomes ?? {}).filter((o) => o.marketId === OU);
    if (!ou.length) continue;
    const sib = ou.map((o) => o.name);
    const evRes = new Map();
    for (const o of ou) {
      const r = evaluateOutcome(OU, o.name, score, sib);
      if (r) evRes.set(o.name, r);
    }
    const seen = new Set();
    for (const o of ou) {
      const res = evRes.get(o.name);
      if (!res) continue;
      for (const p of o.plays ?? []) {
        const key = `${o.name}|${p.odds}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const m = inSpec(o);
        if (!m) continue;
        bets.push({ odds: p.odds, result: res, t: new Date(ev.startTime).getTime() });
      }
    }
  }
  bets.sort((a, b) => a.t - b.t);
  const cut = Math.floor(bets.length * 0.6);
  const agg = (arr) => {
    const pnls = arr.map((b) => (b.result === 'WON' ? b.odds - 1 : b.result === 'LOST' ? -1 : 0));
    const n = arr.filter((b) => b.result !== 'VOID').length;
    return { n, roi: n ? roi(pnls) : null, ci: n ? ci(pnls) : [0, 0] };
  };
  const tr = agg(bets.slice(0, cut));
  const te = agg(bets.slice(cut));
  const all = agg(bets);
  console.log(`Backtest H1 over ${bets.length} resolved O/U 2.5 bets (frozen spec).`);
  console.log(
    `TRAIN (old 60%): n=${tr.n} ROI=${(tr.roi * 100).toFixed(1)}% CI=[${(tr.ci[0] * 100).toFixed(1)}%,${(tr.ci[1] * 100).toFixed(1)}%]`
  );
  console.log(
    `TEST  (new 40%): n=${te.n} ROI=${(te.roi * 100).toFixed(1)}% CI=[${(te.ci[0] * 100).toFixed(1)}%,${(te.ci[1] * 100).toFixed(1)}%]`
  );
  console.log(`ALL   (in-sample ref): n=${all.n} ROI=${(all.roi * 100).toFixed(1)}%`);
}

// ---------- summary ----------
export function summarize(picks) {
  const settledArr = picks.filter((p) => p.status === 'WON' || p.status === 'LOST');
  const voids = picks.filter((p) => p.status === 'VOID');
  const won = settledArr.filter((p) => p.status === 'WON').length;
  const lost = settledArr.length - won;
  const pnls = settledArr.map((p) => p.pnl);
  const staked = won + lost;
  const pnl = pnls.reduce((a, b) => a + b, 0);
  const roiVal = staked ? roi(pnls) : null;
  const hit = staked ? won / staked : null;
  const avgOdds = staked ? settledArr.reduce((a, p) => a + p.odds, 0) / staked : null;
  const edge = hit != null && avgOdds ? hit - 1 / avgOdds : null;
  const resolved = settledArr.length + voids.length;
  const [lo, hi] = staked ? ci(pnls) : [0, 0];
  return { resolved, settled: settledArr.length, won, lost, voids: voids.length, pnl, roiVal, hit, avgOdds, edge, lo, hi };
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
function r2(x) {
  return x == null ? 'n/a' : Number(x).toFixed(2);
}

function printSummary(ledger, added, scored) {
  const s = summarize(ledger.picks);
  const open = ledger.picks.filter((p) => p.status === 'OPEN').length;
  console.log('# Paper-B — O/U H1 forward track', '');
  console.log(`Spec: ${SPEC.id} | ${SPEC.market} line ${SPEC.line} | odds [${SPEC.oddsLo}, ${SPEC.oddsHi}) | side ${SPEC.side}`);
  console.log(`Started: ${ledger.startedAt} | updated: ${ledger.updatedAt}`);
  console.log(`Picks: total=${ledger.picks.length} open=${open} resolved=${s.resolved} (added this run=${added}, scored=${scored})`);
  console.log('');
  console.log('## Performance (resolved picks)', '');
  console.log(`Resolved: ${s.resolved}  Wins: ${s.won}  Losses: ${s.lost}  Voids: ${s.voids}`);
  console.log(`Hit rate: ${pct(s.hit)}  Avg odds: ${r2(s.avgOdds)}  Edge (obs−implied): ${r2(s.edge)}`);
  console.log(`P/L (1u/stake): ${s.pnl >= 0 ? '+' : ''}${s.pnl.toFixed(2)}  ROI: ${pct(s.roiVal)}  Yield: ${pct(s.roiVal)}`);
  if (s.staked) console.log(`ROI 95% CI: [${pct(s.lo)}, ${pct(s.hi)}]`);
  console.log('');
  const gateMet = s.resolved >= SPEC.gate && (s.roiVal ?? -1) > 0;
  console.log(
    `## Gate (>=${SPEC.gate} resolved AND positive ROI): ${s.resolved}/${SPEC.gate} resolved, ROI ${pct(s.roiVal)} -> ` +
      (gateMet ? 'ELIGIBLE FOR HUMAN REVIEW (NOT auto-promoted)' : 'not yet met')
  );
  console.log('Ledger: ' + LEDGER);
}

// ---------- CLI ----------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const main = args.includes('--backtest') ? runBacktest : runForward;
  main().catch((e) => {
    console.error(`paper-B failed: ${e.message}`);
    process.exit(1);
  });
}
