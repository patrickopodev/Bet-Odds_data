// ---------------------------------------------------------------------------
// UNIFIED DAILY ENGINE (spec #8, #10, #15, #16).
//
// Entry point that turns the odds database + research status + strategy registry
// into a single list of APPROVED PICKS, with a five-market output that
// distinguishes "market exists" from "validated strategy exists" (spec #10).
//
// Pipeline (spec #8):
//   1. identify matches: kickoff > now AND isSimulated === false
//   2. retrieve all supported markets (1X2, O/U, Correct Score, Multigoals,
//      Multiscores)
//   3. retrieve applicable strategies: ONLY status === LIVE (PAPER/TRAINING/
//      HOLDOUT/FAILED excluded)
//   4. apply each strategy independently per market
//   5. attach research (informational only; never changes the selection)
//
// No leakage (spec #16): live picks use the LAST_KNOWN_GOOD (frozen) strategy
// definition; today's results never feed today's strategy selection.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDb } from '../lib/common.mjs';
import { listMarkets, getMarket, registerExtensionMarkets } from './markets.mjs';
import { loadRegistry, getLiveStrategies, selectStrategy } from './strategies.mjs';
import { validatePick, GATE_DEFAULTS } from './validation.mjs';
import { buildApprovedPick } from './pick.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const APPROVED_FILE = path.join(DATA_DIR, 'approved-picks.json');

function isUpcoming(ev, now) {
  const k = ev.startTime ? Date.parse(ev.startTime) : null;
  if (k === null || Number.isNaN(k)) return false;
  return k > now;
}

// Identify matches eligible for live selection.
export function identifyMatches(db, now = Date.now()) {
  const out = [];
  for (const ev of Object.values(db.events ?? {})) {
    if (ev.finalScore) continue; // resolved -> not a live candidate
    if (ev.isSimulated) continue; // simulated fixtures excluded (spec #8/#16)
    if (!isUpcoming(ev, now)) continue; // kickoff must be in the future
    out.push(ev);
  }
  return out;
}

// Produce approved picks for LIVE strategies only.
export function selectApproved({ db, registry, researchStatus = {}, now = Date.now(), limits = GATE_DEFAULTS }) {
  const live = getLiveStrategies(registry);
  const approved = [];
  const rejected = [];

  for (const strategy of live) {
    const candidates = selectStrategy(strategy, { db });
    for (const c of candidates) {
      const ev = db.events?.[c.eventId];
      // Enforce upcoming + non-simulated at the engine level too.
      if (!ev || ev.finalScore || ev.isSimulated || !isUpcoming(ev, now)) {
        rejected.push({ candidate: c, reason: 'NOT_UPCOMING_OR_SIMULATED' });
        continue;
      }
      const rstatus = researchStatus[c.eventId] ?? 'SEARCH_NO_RESULTS';
      const pick = buildApprovedPick({ strategy, candidate: c, researchStatus: rstatus, generatedAt: new Date().toISOString() });
      const v = validatePick(pick, { strategy, now, limits });
      pick.audit.validationGates = v;
      if (v.ok) approved.push(pick);
      else rejected.push({ pick, reason: v.failures.join(';') });
    }
  }
  return { approved, rejected, liveStrategies: live.map((s) => s.strategyId) };
}

// Five-market output (spec #10): market exists vs validated strategy exists.
export function summarizeByMarket({ db, registry, selectionResult, now = Date.now() }) {
  const liveStrategies = getLiveStrategies(registry);
  const paperStrategies = registry.strategies.filter((s) => s.status === 'PAPER');

  const approvedByMarket = {};
  for (const p of selectionResult.approved) {
    approvedByMarket[p.marketId] = (approvedByMarket[p.marketId] ?? 0) + 1;
  }

  return listMarkets().map((mkt) => {
    const live = liveStrategies.filter((s) => s.marketId === mkt.id);
    const paper = paperStrategies.filter((s) => s.marketId === mkt.id);
    return {
      marketId: mkt.id,
      market: mkt.name,
      liveStrategy: live.length ? live.map((s) => s.strategyId).join(', ') : 'none LIVE',
      liveCandidates: approvedByMarket[mkt.id] ?? 0,
      observing: paper.length ? `Paper: ${paper.map((s) => s.strategyId).join(', ')} (observing only)` : '',
    };
  });
}

export function runEngine({ db, registry, researchStatus = {}, now = Date.now(), write = false } = {}) {
  if (process.env.ENGINE_ENABLE_EXTENSION_MARKETS) registerExtensionMarkets();
  const matches = identifyMatches(db, now);
  const selection = selectApproved({ db, registry, researchStatus, now });
  const byMarket = summarizeByMarket({ db, registry, selectionResult: selection, now });

  const report = {
    generatedAt: new Date().toISOString(),
    date: new Date(now).toISOString().slice(0, 10),
    upcomingMatches: matches.length,
    liveStrategies: selection.liveStrategies,
    approvedCount: selection.approved.length,
    rejectedCount: selection.rejected.length,
    markets: byMarket,
    approved: selection.approved,
    rejected: selection.rejected.map((r) => ({ pickId: r.pick?.pickId ?? null, reason: r.reason })),
  };

  if (write) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(APPROVED_FILE, JSON.stringify(report, null, 2));
  }
  return report;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const write = process.argv.includes('--write');
  const db = await loadDb();
  const registry = loadRegistry();
  const report = runEngine({ db, registry, write });
  console.log(`TODAY — ${report.date}`);
  for (const m of report.markets) {
    console.log(`${m.market}`);
    console.log(` ├─ Strategy: ${m.liveStrategy}`);
    console.log(` └─ ${m.liveCandidates} live candidates${m.observing ? `  (${m.observing})` : ''}`);
  }
  console.log(`\nApproved: ${report.approvedCount}  Rejected: ${report.rejectedCount}  Upcoming matches: ${report.upcomingMatches}`);
  if (write) console.log(`Wrote ${APPROVED_FILE}`);
}
