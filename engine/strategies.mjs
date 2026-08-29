// ---------------------------------------------------------------------------
// STRATEGY REGISTRY + LIFECYCLE (spec #4, #5, #6, #7).
//
// This module is the engine's view of which strategies exist and whether they
// may produce LIVE picks. PAPER / TRAINING / HOLDOUT / FAILED strategies are
// EXCLUDED from live selection by construction (spec #8 step 3, #20).
//
// The validated selectors are imported UNCHANGED from the existing code:
//   - Strategy A  -> lib/1x2.mjs:select1X2Picks  (validated +16.8% OOS)
//   - Paper-B     -> paper-B.mjs:inSpec                      (frozen O/U H1 spec)
// Wrapping them (rather than re-implementing) guarantees the migration cannot
// silently alter the validated math (spec #6, #23).
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFavRows, select1X2Picks } from '../lib/1x2.mjs';
import { inSpec as ouH1InSpec } from '../paper-B.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REGISTRY_PATH = path.join(__dirname, 'strategy-registry.json');

// Explicit lifecycle states (spec #5). A strategy must walk these in order;
// the gates in the daily engine forbid DISCOVERED->LIVE or PAPER->LIVE jumps.
export const LIFECYCLE = [
  'DISCOVERED',
  'BACKTESTED',
  'HOLDOUT_TESTED',
  'PAPER',
  'ELIGIBLE_FOR_REVIEW',
  'VALIDATED',
  'LIVE',
  'FAILED',
];

// Only these statuses are allowed to produce LIVE approved picks.
const LIVE_OK = new Set(['VALIDATED', 'LIVE']);

export function loadRegistry(file = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function getStrategy(reg, id) {
  return reg.strategies.find((s) => s.strategyId === id) ?? null;
}

export function isLive(strategy) {
  return LIVE_OK.has(strategy.status);
}

export function getLiveStrategies(reg) {
  return reg.strategies.filter(isLive);
}

export function canPromote(strategy) {
  // PAPER -> ELIGIBLE_FOR_REVIEW only when its gate is met (caller supplies the
  // resolved/gate check). This module only enforces that a non-LIVE status can
  // NEVER yield a live pick.
  return isLive(strategy);
}

// ---------------------------------------------------------------------------
// EXISTING SELECTOR WRAPPERS — preserve validated logic verbatim.
// ---------------------------------------------------------------------------

// Strategy A: 1X2 favorite in the frozen band [lo, hi). Returns candidate rows
// exactly as the legacy selector does; the engine adds kickoff/simulated gates.
function select1X2A(strategy, ctx) {
  const rows = buildFavRows(ctx.db);
  const { lo, hi } = strategy.parameters;
  const picks = select1X2Picks(rows, lo, hi);
  return picks.map((r) => ({
    eventId: r.eventId,
    homeTeam: r.homeTeam,
    awayTeam: r.awayTeam,
    league: r.league,
    selection: r.favName,
    odds: r.favLast,
    line: null,
    kickoff: ctx.db.events?.[r.eventId]?.startTime ?? null,
  }));
}

// Paper-B: O/U 2.5 side in [lo, hi) — uses the FROZEN inSpec in paper-B.mjs.
// Returned ONLY for observation/paper tracking; never enters live approved picks
// because this strategy's status is PAPER (filtered by getLiveStrategies).
function selectOuH1(strategy, ctx) {
  const { line } = strategy.parameters;
  const out = [];
  for (const ev of Object.values(ctx.db.events ?? {})) {
    if (ev.finalScore) continue; // historical/resolved -> not a forward pick
    for (const o of Object.values(ev.outcomes ?? {}).filter((x) => x.marketId === strategy.marketId)) {
      const m = ouH1InSpec(o);
      if (!m) continue;
      out.push({
        eventId: ev.eventId,
        homeTeam: ev.homeTeam,
        awayTeam: ev.awayTeam,
        league: ev.tournament,
        selection: `${m.side} ${line}`,
        odds: m.odds,
        line,
        kickoff: ev.startTime,
      });
    }
  }
  return out;
}

const SELECTORS = {
  'STRAT-1X2-BAND-v1': select1X2A,
  'STRAT-OU-H1-v1': selectOuH1,
};

// Run a strategy's selector against the odds DB. Returns RAW candidates
// (pre-validation). Unknown strategies return [] — fail closed, never bet.
export function selectStrategy(strategy, ctx) {
  const fn = SELECTORS[strategy.strategyId];
  if (!fn) return [];
  return fn(strategy, ctx);
}
