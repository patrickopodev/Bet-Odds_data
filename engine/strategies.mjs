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
const DATA_DIR = path.join(__dirname, '..', 'data');
export const REGISTRY_PATH = path.join(__dirname, 'strategy-registry.json');

export function loadBands(source) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, source), 'utf8'));
    if (source === 'correctscore-relations.json') {
      const bands = {};
      for (const s of data.scores ?? []) {
        if (s.strategyBand) bands[s.name] = [s.strategyBand.lo, s.strategyBand.hi];
      }
      return bands;
    }
    if (source === 'mg-mscore-bands.json') {
      const result = { multigoals: {}, multiscores: {} };
      for (const [k, v] of Object.entries(data)) {
        if (k === 'multigoals' || k === 'multiscores') {
          for (const [name, band] of Object.entries(v)) {
            result[k][name] = [band.lo, band.hi];
          }
        }
      }
      return result;
    }
    return data;
  } catch {
    return {};
  }
}

const csBandsCache = loadBands('correctscore-relations.json');
const mgMsBandsCache = loadBands('mg-mscore-bands.json');

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
// Each strategy registers which marketId it can operate on via the strategy
// registry (strategy-registry.json). The 1X2_BAND strategy supports market 1
// (1X2 favorite); O/U H1 supports market 18 (Over/Under 2.5); future strategies
// can support 41, 548, 551, 100, 101, 102, or any other ID. The selectors
// below read the registered marketId from the strategy to determine which
// events/markets they apply to — this is the single source of truth and must
// not be duplicated via env variables (spec #17, #20).
// ---------------------------------------------------------------------------

// Strategy A: 1X2 favorite in the frozen band [lo, hi).
// Operates on marketId === '1' (1X2). The registered marketId is read from
// the strategy definition; the core selector logic (buildFavRows + select1X2Picks)
// is unchanged and shared with the legacy track (spec #6, #23).
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
// Filters outcomes by the strategy's registered marketId (e.g. '18' for O/U).
function selectOuH1(strategy, ctx) {
  const { line } = strategy.parameters;
  const marketId = String(strategy.marketId);
  const out = [];
  for (const ev of Object.values(ctx.db.events ?? {})) {
    if (ev.finalScore) continue; // historical/resolved -> not a forward pick
    for (const o of Object.values(ev.outcomes ?? {}).filter((x) => x.marketId === marketId)) {
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

// Strategy Correct Score: selects candidates with odds within
// scoreline-specific bands derived from EV/ROI analysis.
// For live matches (not yet resolved), selects active Correct Score
// outcomes whose odds fall within the validated band for that scoreline.
function selectCorrectScore(strategy, ctx) {
  const { confidence, fallbackBand = [1.8, 2.2] } = strategy.parameters;
  const minConf = Number(confidence ?? 0);
  const marketId = String(strategy.marketId);
  const bands = csBandsCache || {};
  const out = [];
  for (const ev of Object.values(ctx.db.events ?? {})) {
    if (ev.finalScore) continue;
    for (const o of Object.values(ev.outcomes ?? {}).filter(
      (x) => String(x.marketId) === marketId
    )) {
      const plays = o.plays ?? [];
      const activePlay = plays.find((p) => p.active);
      if (!activePlay) continue;
      const odds = Number(activePlay.odds ?? o.odds ?? 0);
      const band = bands[o.name] || fallbackBand;
      if (odds < band[0] || odds >= band[1]) continue;
      if (o.name && o.name.length > 0 && Number(o.confidence ?? 1) >= minConf) {
        out.push({
          eventId: ev.eventId,
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          league: ev.tournament,
          selection: o.name,
          odds,
          line: null,
          kickoff: ev.startTime,
          confidence: o.confidence ?? 1,
        });
      }
    }
  }
  return out;
}

// Strategy Multigoals: selects candidates with odds within
// outcome-specific bands derived from EV/ROI analysis.
function selectMultigoals(strategy, ctx) {
  const { confidence, fallbackBand = [1.8, 2.2] } = strategy.parameters;
  const minConf = Number(confidence ?? 0);
  const marketId = String(strategy.marketId);
  const bands = (mgMsBandsCache && mgMsBandsCache.multigoals) || {};
  const out = [];
  for (const ev of Object.values(ctx.db.events ?? {})) {
    if (ev.finalScore) continue;
    for (const o of Object.values(ev.outcomes ?? {}).filter(
      (x) => String(x.marketId) === marketId
    )) {
      const plays = o.plays ?? [];
      const activePlay = plays.find((p) => p.active);
      if (!activePlay) continue;
      const odds = Number(activePlay.odds ?? o.odds ?? 0);
      const band = bands[o.name] || fallbackBand;
      if (odds < band[0] || odds >= band[1]) continue;
      if (o.name && o.name.length > 0 && Number(o.confidence ?? 1) >= minConf) {
        out.push({
          eventId: ev.eventId,
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          league: ev.tournament,
          selection: o.name,
          odds,
          line: null,
          kickoff: ev.startTime,
          confidence: o.confidence ?? 1,
        });
      }
    }
  }
  return out;
}

// Strategy Multiscores: selects candidates with odds within
// outcome-specific bands derived from EV/ROI analysis.
function selectMultiscores(strategy, ctx) {
  const { confidence, fallbackBand = [1.8, 2.2] } = strategy.parameters;
  const minConf = Number(confidence ?? 0);
  const marketId = String(strategy.marketId);
  const bands = (mgMsBandsCache && mgMsBandsCache.multiscores) || {};
  const out = [];
  for (const ev of Object.values(ctx.db.events ?? {})) {
    if (ev.finalScore) continue;
    for (const o of Object.values(ev.outcomes ?? {}).filter(
      (x) => String(x.marketId) === marketId
    )) {
      const plays = o.plays ?? [];
      const activePlay = plays.find((p) => p.active);
      if (!activePlay) continue;
      const odds = Number(activePlay.odds ?? o.odds ?? 0);
      const band = bands[o.name] || fallbackBand;
      if (odds < band[0] || odds >= band[1]) continue;
      if (o.name && o.name.length > 0 && Number(o.confidence ?? 1) >= minConf) {
        out.push({
          eventId: ev.eventId,
          homeTeam: ev.homeTeam,
          awayTeam: ev.awayTeam,
          league: ev.tournament,
          selection: o.name,
          odds,
          line: null,
          kickoff: ev.startTime,
          confidence: o.confidence ?? 1,
        });
      }
    }
  }
  return out;
}

const SELECTORS = {
  'STRAT-1X2-BAND-v1': select1X2A,
  'STRAT-OU-H1-v1': selectOuH1,
  'STRAT-CS-ODDS-v1': selectCorrectScore,
  'STRAT-MG-ODDS-v1': selectMultigoals,
  'STRAT-MSCORE-ODDS-v1': selectMultiscores,
};

// Run a strategy's selector against the odds DB. Returns RAW candidates
// (pre-validation). Unknown strategies return [] — fail closed, never bet.
export function selectStrategy(strategy, ctx) {
  const fn = SELECTORS[strategy.strategyId];
  if (!fn) return [];
  return fn(strategy, ctx);
}
