// ---------------------------------------------------------------------------
// FEATURE ABLATION BACKTEST HARNESS (research-only, additive).
//
// Answers the question the audit raised: which SIGNAL actually beats the house,
// independently? It does NOT promote anything — it only reports ROI + a
// deterministic CI and flags NO SIGNAL when the edge is not proven.
//
// Method (guards against the in-sample optimism the message warns about):
//   1. Chronological split: settled events sorted by kickoff; oldest `trainFrac`
//      train the historical stats, the newest `(1-trainFrac)` are the HOLDOUT.
//   2. The historical win-rate at an odds band is computed from TRAIN ONLY, so a
//      holdout pick never sees its own outcome (no leakage).
//   3. Each feature flag is tested (a) alone on top of the BAND_1X2 baseline and
//      (b) in the all-flags combination. Separately we compare the existing
//      BAND_1X2 selector against the 1X2 DB-history enrichment
//      (odds + historical win-rate + drift).
//   4. Signal requires n >= 30, ROI > HOUSE_MARGIN (-7.7%), and a CI lower bound
//      > 0. Otherwise the system says NO SIGNAL — the engine must be allowed to
//      say there is no edge.
//
// Feature flags:
//   favBand      existing LIVE rule: 1X2 favourite in [1.8, 2.2)   (baseline)
//   dbHistory    outcome has positive historical edge at its odds band (train)
//   drift        price shortened (steamed) today — money arriving
//   h2h          H2H feature rule passes (needs `features` data)
//   competition  competition-context rule passes (needs `features` data)
//   form         team form/position edge (needs `formDb` data, Suggestion 4)
//
// `features[eventId] = { homeTeam, awayTeam, meetings: Meeting[], competition? }`
// is OPTIONAL; h2h/competition combos are marked "NO DATA" when absent.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDb, parseScore, evaluateOutcome } from '../lib/common.mjs';
import { roi } from '../lib/settlement.mjs';
import { extractH2HFeatures, extractCompetitionContext } from './features.mjs';
import { extractTeamForm, teamStrengthEdge, teamAvgGoals } from './team-features.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';
export const RELEVANT_MARKETS = new Set(['1', '18', '548', '41', '551']);
const MARKET_NAMES = { '1': '1X2', '18': 'O/U', '548': 'Multigoals', '41': 'CorrectScore', '551': 'Multiscores' };
export const BAND_1X2 = { lo: 1.8, hi: 2.2 };
// Resolve a --features/--form/--standings path: accept an absolute/relative path
// as-is, but fall back to DATA_DIR so the files that ride along in the odds-data
// artifact (data/h2h.json, data/team-form.json) can be passed as just basenames.
function resolveDataPath(p) {
  return fs.existsSync(p) ? p : path.join(DATA_DIR, p);
}
// Load a team -> {position, points, played} standings map (the same league
// position data the Deep Research Agent caches). Used by the competition gate.
// Accepts two formats:
//   - team map:      { "Team Name": {position, points, played}, ... }
//   - agent cache:   { "<leagueUrl>": [ {teamId, teamName, rank}, ... ], ... }
//     (the Deep Research Agent's standings-cache.json) — flattened to team->rank.
export function loadStandings(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof raw !== 'object' || raw == null || Array.isArray(raw)) {
    throw new Error(`standings file ${file} must be a JSON object`);
  }
  const firstVal = Object.values(raw)[0];
  if (Array.isArray(firstVal)) {
    const out = {};
    for (const rows of Object.values(raw)) {
      if (!Array.isArray(rows)) continue;
      for (const r of rows) {
        const team = r.teamName ?? r.name;
        const pos = r.rank ?? r.position;
        if (team != null && pos != null) {
          out[team] = { position: pos, points: r.points ?? null, played: r.played ?? null };
        }
      }
    }
    return out;
  }
  return raw;
}
export const MIN_HISTORY_SAMPLE = 5;
export const HOUSE_MARGIN = -0.077; // bookmaker margin hurdle (~7.7%)

// ---- stats over TRAIN only ----
function outcomesList(ev) {
  return Object.values(ev.outcomes ?? {});
}
function marketNames(ev) {
  const m = new Map();
  for (const o of outcomesList(ev)) {
    if (!m.has(o.marketId)) m.set(o.marketId, []);
    m.get(o.marketId).push(o.name);
  }
  return m;
}
function buildTrainStats(trainEvents) {
  const grouped = new Map(); // `${marketId}|${name}` -> { [odds]: {won,settled} }
  for (const ev of trainEvents) {
    const score = parseScore(ev.finalScore);
    if (!score) continue;
    const byMarket = marketNames(ev);
    const resOf = new Map();
    for (const o of outcomesList(ev)) {
      const r = evaluateOutcome(o.marketId, o.name, score, byMarket.get(o.marketId));
      if (r) resOf.set(`${o.marketId}|${o.name}`, r);
    }
    const seen = new Set();
    for (const o of outcomesList(ev)) {
      const res = resOf.get(`${o.marketId}|${o.name}`);
      if (!res) continue;
      for (const p of o.plays ?? []) {
        const k = `${o.marketId}|${o.name}|${p.odds}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const gkey = `${o.marketId}|${o.name}`;
        let g = grouped.get(gkey);
        if (!g) { g = {}; grouped.set(gkey, g); }
        let cell = g[p.odds];
        if (!cell) { cell = { won: 0, settled: 0 }; g[p.odds] = cell; }
        if (res === 'WON') { cell.won++; cell.settled++; }
        else if (res === 'LOST' || res === 'VOID') { cell.settled++; }
      }
    }
  }
  return {
    edge(marketId, name, odds) {
      const lo = odds * 0.75, hi = odds * 1.3;
      const g = grouped.get(`${marketId}|${name}`);
      if (!g) return { winRate: null, settled: 0, edge: null };
      let won = 0, settled = 0;
      for (const [o, cell] of Object.entries(g)) {
        const od = Number(o);
        if (od < lo || od > hi) continue;
        won += cell.won; settled += cell.settled;
      }
      if (settled < 3) return { winRate: null, settled, edge: null };
      const winRate = won / settled;
      return { winRate, settled, edge: winRate - 1 / odds };
    },
  };
}

// ---- per-event helpers ----
// The "favourite" (shortest last-odds outcome) of a given market SECTION.
// For 1X2 this is the match favourite; for O/U it is the shorter of Over/Under;
// for Correct Score / Multigoals / Multiscores it is the single shortest-priced
// outcome in that section. Used as the generic BASE selector so every section
// can be ablated the same way 1X2 is.
function sectionFavorite(ev, marketId) {
  const sides = outcomesList(ev).filter((o) => o.marketId === marketId);
  let best = null;
  for (const s of sides) {
    const last = lastOdds(s);
    if (last == null) continue;
    if (!best || last < best.odds) best = { name: s.name, odds: last };
  }
  return best;
}
function lastOdds(o) {
  const plays = o.plays ?? [];
  if (!plays.length) return null;
  let b = null, bt = -Infinity;
  for (const p of plays) {
    const t = Date.parse(p.seenAt ?? p.scrapedAt ?? 0);
    if (t >= bt) { bt = t; b = p.odds; }
  }
  return b;
}
function driftOf(ev, marketId, name) {
  const o = ev.outcomes?.[`${marketId}|${name}`];
  const plays = o?.plays ?? [];
  if (plays.length < 3) return null;
  const sorted = [...plays].sort((a, b) => Date.parse(a.seenAt ?? a.scrapedAt ?? 0) - Date.parse(b.seenAt ?? b.scrapedAt ?? 0));
  const first = sorted[0].odds, last = sorted[sorted.length - 1].odds;
  return { drift: Number((last - first).toFixed(3)), first, last, samples: sorted.length };
}

// ---- deterministic CI (normal approx) so the NO-SIGNAL gate is testable ----
function mean(a) { return a.reduce((s, x) => s + x, 0) / a.length; }
function std(a) { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); }
export function normalCI(pnls) {
  const n = pnls.length;
  if (n < 2) return [0, 0];
  const m = mean(pnls);
  const se = std(pnls) / Math.sqrt(n);
  return [m - 1.96 * se, m + 1.96 * se];
}

// ---- selection under a flag set ----
// AND semantics: every enabled flag must pass. favBand is the BASE selector
// (the 1X2 favourite in the validated band); dbHistory / drift / h2h /
// competition are REFINEMENT GATES on it. So an "enriched" set is always a
// subset of the baseline — it can only drop bets, never add them. This is the
// correct framing for testing whether a feature IMPROVES the existing pick.
function isSelected(ev, marketId, name, odds, ctx, flags) {
  if (flags.favBand) {
    const fav = ctx.fav(ev, marketId);
    if (!fav || fav.name !== name) return false;
    // Only 1X2 has a validated price band; other sections just back the favourite.
    if (marketId === '1' && (odds < BAND_1X2.lo || odds >= BAND_1X2.hi)) return false;
  }
  if (flags.dbHistory) {
    const e = ctx.trainStats.edge(marketId, name, odds);
    if (e.winRate == null || e.edge <= 0 || e.settled < MIN_HISTORY_SAMPLE) return false;
  }
  if (flags.drift) {
    const d = driftOf(ev, marketId, name);
    if (!d || d.drift >= 0) return false; // require steamed
  }
  if (flags.h2h) {
    if (!ctx.h2hPasses(ctx.features, ev, marketId, name)) return false;
  }
  if (flags.competition) {
    if (!ctx.competitionPasses(ctx.standings, ev)) return false;
  }
  if (flags.form) {
    if (!ctx.formPasses(ctx.features, ctx.formDb, ev, marketId, name)) return false;
  }
  return true;
}

// Placeholder H2H rule (a HYPOTHESIS to be validated, never a live rule):
// back the in-form H2H side. Returns true if `name` is the side H2H favours.
function h2hPasses(features, ev, marketId, name) {
  const f = features?.[ev.eventId];
  if (!f || !f.meetings || !f.homeTeam || !f.awayTeam) return false;
  const h = extractH2HFeatures(f.meetings, f.homeTeam, f.awayTeam, { asOf: ev.startTime });
  if (h.totalMeetings === 0) return false;
  if (marketId !== '1') return false; // only defined for 1X2 in this harness
  if (h.homeWins > h.awayWins) return name === 'Home';
  if (h.awayWins > h.homeWins) return name === 'Away';
  return false;
}
// Position / league-context rule (a HYPOTHESIS to be validated, never a live
// rule): only consider events where at least one side sits in the top 4 of its
// table (strong-table context). Reads a team -> {position, points, played} map
// (the same standings the Deep Research Agent caches). It is event-level, NOT
// outcome-level, so it gates ALL 5 sections equally (any favourite of a top-4
// side is eligible, regardless of market). A null map means "no standings
// available" -> the gate cannot pass (data-quality verdict, not a signal).
function competitionPasses(standings, ev) {
  if (!standings) return false;
  const h = standings[ev.homeTeam];
  const a = standings[ev.awayTeam];
  const positions = [h?.position, a?.position].filter((p) => p != null);
  if (!positions.length) return false;
  return positions.some((p) => p <= 4);
}

// Placeholder FORM rule (a HYPOTHESIS to be validated, never a live rule): the
// favourite's side must be the stronger team on recent form/position. For 1X2
// that means the favourite (Home/Away) has the better teamStrengthEdge; Draw can
// never pass. For O/U it is the goal-total hypothesis: the section favourite is
// Over/Under; pass when recent team goal totals agree with that side. Pure
// extraction lives in engine/team-features.mjs; this only decides pass/fail.
function formPasses(features, formDb, ev, marketId, name) {
  const home = ev.homeTeam;
  const away = ev.awayTeam;
  if (!home || !away) return false;
  const homeForm = extractTeamForm(formDb, home, ev.startTime);
  const awayForm = extractTeamForm(formDb, away, ev.startTime);
  if (marketId === '1') {
    if (name === 'Draw') return false; // no team edge for a draw
    const edge = teamStrengthEdge(homeForm, awayForm);
    if (name === 'Home') return edge > 0; // home stronger
    if (name === 'Away') return edge < 0; // away stronger
    return false;
  }
  if (marketId === '18') {
    // Goal-total hypothesis: the O/U favourite (Over/Under) is refined by recent
    // team goals. Pass when the favourite side matches the goal trend.
    const isOver = /over/i.test(name);
    const hg = teamAvgGoals(homeForm);
    const ag = teamAvgGoals(awayForm);
    if (hg == null || ag == null) return false;
    const avg = (hg + ag) / 2;
    // Determine the line from the favourite's name (e.g. "Over 2.5").
    const lineM = name.match(/(\d+(?:\.\d+)?)/);
    const line = lineM ? Number(lineM[1]) : 2.5;
    return isOver ? avg > line : avg < line;
  }
  return false;
}

// ---- settled events (chronological) shared by every evaluator ----
export function settledEvents(db) {
  return Object.values(db.events ?? {})
    .filter((e) => e.finalScore && e.outcomes && Object.keys(e.outcomes).length)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
}

// Run the selection rule over ONE train/holdout split. Train stats are built
// from `train` ONLY, so a holdout pick never sees its own outcome (no leakage).
// Returns the list of placed bets plus a `needsData` flag (a feature requiring
// `features` was enabled but no features were supplied).
function scoreHoldout(train, holdout, { flags, features = null, formDb = null, standings = null, marketId = null, minBets = 30 }) {
  const trainStats = buildTrainStats(train);
  const ctx = {
    fav: (ev, mkt) => sectionFavorite(ev, mkt),
    trainStats,
    h2hPasses,
    competitionPasses,
    formPasses,
    features,
    formDb: formDb ?? features?.formDb ?? null,
    standings,
  };

  const needsData =
    (flags.h2h && !features) ||
    (flags.competition && !standings) ||
    (flags.form && !formDb);
  const bets = [];
  if (!needsData) {
    for (const ev of holdout) {
      const score = parseScore(ev.finalScore);
      const byMarket = marketNames(ev);
      for (const o of outcomesList(ev)) {
        if (!RELEVANT_MARKETS.has(o.marketId)) continue;
        if (marketId && o.marketId !== marketId) continue;
        const odds = lastOdds(o);
        if (odds == null) continue;
        if (!isSelected(ev, o.marketId, o.name, odds, ctx, flags)) continue;
        const r = evaluateOutcome(o.marketId, o.name, score, byMarket.get(o.marketId));
        const pnl = r === 'WON' ? odds - 1 : r === 'LOST' ? -1 : 0;
        bets.push({ eventId: ev.eventId, marketId: o.marketId, name: o.name, odds, result: r, pnl });
      }
    }
  }
  return { bets, needsData };
}

// Turn a list of bets into the standard verdict object. `method` tags the
// evaluator that produced it (used by the report).
function summarizeBets(bets, needsData, minBets = 30, { flags = null, method = 'split' } = {}) {
  const pnls = bets.map((b) => b.pnl);
  const n = bets.length;
  const won = bets.filter((b) => b.result === 'WON').length;
  const lost = bets.filter((b) => b.result === 'LOST').length;
  const roiVal = n ? roi(pnls) : 0;
  const ci = normalCI(pnls);
  const signal = n >= minBets && roiVal > HOUSE_MARGIN && ci[0] > 0;
  return {
    flags,
    method,
    n,
    won,
    lost,
    roi: roiVal,
    ci,
    signal,
    verdict: needsData ? 'NO DATA' : signal ? 'SIGNAL' : 'NO SIGNAL',
    noData: needsData,
    bets,
  };
}

// ---- run one flag set over a single (chronological) train/holdout split ----
export function runFeatureSet(db, { flags, features = null, formDb = null, standings = null, trainFrac = 0.7, minBets = 30, marketId = null, splits = null } = {}) {
  const all = settledEvents(db);
  let train, holdout;
  if (splits) {
    ({ train, holdout } = splits);
  } else {
    const cut = Math.floor(all.length * trainFrac);
    train = all.slice(0, cut);
    holdout = all.slice(cut);
  }
  const { bets, needsData } = scoreHoldout(train, holdout, { flags, features, formDb, standings, marketId, minBets });
  const r = summarizeBets(bets, needsData, minBets, { flags, method: 'split' });
  return r;
}

// Pool a list of pre-built {train, holdout} splits into ONE verdict: build
// train stats per fold (never across the whole DB), score the holdout, concat
// the bets, then compute one roi + normalCI over the pooled bets. This is the
// harness's answer to "is the verdict trustworthy" — a single 70/30 split on a
// small DB leaves a CI that spans zero; k-fold / expanding-window widen the
// holdout and tighten the pooled CI (see RESEARCH-PLAN.md Suggestion 1).
export function runSplitEval(db, { flags, features = null, formDb = null, standings = null, minBets = 30, marketId = null, splits, method = 'kfold' } = {}) {
  let pooledBets = [];
  let needsData = false;
  for (const { train, holdout } of splits) {
    const { bets, needsData: nd } = scoreHoldout(train, holdout, { flags, features, formDb, standings, marketId, minBets });
    if (nd) needsData = true;
    pooledBets = pooledBets.concat(bets);
  }
  return summarizeBets(pooledBets, needsData, minBets, { flags, method });
}

// k-fold OOS: holdout = fold f, train = everything else. Band/edge is re-selected
// on train each fold (never aggregated over the whole DB), mirroring the rigor of
// train-model-v5b.mjs. Non-overlapping holdouts cover the entire settled set.
export function runKfold(db, { flags, features = null, formDb = null, standings = null, minBets = 30, marketId = null, k = 5 } = {}) {
  const all = settledEvents(db);
  const splits = [];
  for (let f = 0; f < k; f++) {
    const train = all.filter((_, i) => i % k !== f);
    const holdout = all.filter((_, i) => i % k === f);
    splits.push({ train, holdout });
  }
  return runSplitEval(db, { flags, features, formDb, standings, minBets, marketId, splits, method: 'kfold' });
}

// Expanding-window OOS: train grows from fold to fold, each holdout is the NEXT
// chronological chunk (never the train). Mirrors how a live strategy would be
// re-fit on an ever-growing history and tested on what comes after.
export function runExpandingWindow(db, { flags, features = null, formDb = null, standings = null, minBets = 30, marketId = null, folds = 5 } = {}) {
  const all = settledEvents(db);
  const N = all.length;
  const splits = [];
  for (let f = 0; f < folds; f++) {
    const cut = Math.floor(((f + 1) / folds) * N);
    const nextCut = Math.floor(((f + 2) / folds) * N);
    const holdout = all.slice(cut, nextCut);
    if (!holdout.length) continue;
    const train = all.slice(0, cut);
    splits.push({ train, holdout });
  }
  return runSplitEval(db, { flags, features, formDb, standings, minBets, marketId, splits, method: 'expanding' });
}

// ---- full ablation ----
const FEATURE_FLAGS = ['dbHistory', 'drift', 'h2h', 'competition', 'form'];

export function runAblation(db, { features = null, formDb = null, standings = null, trainFrac = 0.7, method = 'split', k = 5, folds = 5 } = {}) {
  const runOne = (flags) => {
    if (method === 'kfold') return runKfold(db, { flags, features, formDb, standings, k });
    if (method === 'expanding') return runExpandingWindow(db, { flags, features, formDb, standings, folds });
    return runFeatureSet(db, { flags, features, formDb, standings, trainFrac });
  };
  const baseline = { favBand: true };
  const rows = [];
  const base = runOne(baseline);
  rows.push({ label: 'baseline (favourite, all sections)', ...summarizeRow(base) });
  for (const f of FEATURE_FLAGS) {
    const flags = { ...baseline, [f]: true };
    const r = runOne(flags);
    rows.push({ label: `+ ${f}`, ...summarizeRow(r) });
  }
  const allFlags = { favBand: true, dbHistory: true, drift: true, h2h: true, competition: true, form: true };
  const all = runOne(allFlags);
  rows.push({ label: '+ ALL', ...summarizeRow(all) });
  return { baseline: summarizeRow(base), rows, method };
}

function summarizeRow(r) {
  return {
    n: r.n,
    won: r.won,
    lost: r.lost,
    roi: Number((r.roi * 100).toFixed(1)),
    ciLow: Number((r.ci[0] * 100).toFixed(1)),
    ciHigh: Number((r.ci[1] * 100).toFixed(1)),
    verdict: r.noData ? 'NO DATA' : r.signal ? 'SIGNAL' : 'NO SIGNAL',
  };
}

// ---- headline: existing 1X2 selector vs DB-history enrichment ----
export function compare1X2Enrichment(db, { features = null, formDb = null, standings = null, trainFrac = 0.7, method = 'split', k = 5, folds = 5 } = {}) {
  return compareMarketEnrichment(db, { marketId: '1', features, formDb, standings, trainFrac, method, k, folds });
}

// Same comparison for ANY market section (O/U, Correct Score, Multigoals,
// Multiscores, ...). Each section's BASE selector is its own favourite; the
// enriched set is that favourite refined by positive DB odds-history + steam.
// We also report the raw historical signal (dbHistory only) so a researcher can
// see whether history alone is predictive in that section.
export function compareMarketEnrichment(db, { marketId, features = null, formDb = null, standings = null, trainFrac = 0.7, method = 'split', k = 5, folds = 5 } = {}) {
  const runOne = (flags) => {
    if (method === 'kfold') return runKfold(db, { flags, features, formDb, standings, marketId, k });
    if (method === 'expanding') return runExpandingWindow(db, { flags, features, formDb, standings, marketId, folds });
    return runFeatureSet(db, { flags, features, formDb, standings, trainFrac, marketId });
  };
  const baseline = runOne({ favBand: true });
  const dbHistoryOnly = runOne({ dbHistory: true });
  const enriched = runOne({ favBand: true, dbHistory: true, drift: true });
  const competition = runOne({ favBand: true, competition: true });
  return {
    marketId,
    method,
    baseline: summarizeRow(baseline),
    dbHistoryOnly: summarizeRow(dbHistoryOnly),
    enriched: summarizeRow(enriched),
    competition: summarizeRow(competition),
    deltaRoiPts: Number(((enriched.roi - baseline.roi) * 100).toFixed(1)),
  };
}

export function compareAllMarkets(db, { features = null, formDb = null, standings = null, trainFrac = 0.7, method = 'split', k = 5, folds = 5 } = {}) {
  return [...RELEVANT_MARKETS].map((m) => compareMarketEnrichment(db, { marketId: m, features, formDb, standings, trainFrac, method, k, folds }));
}

// ---- CLI ----
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  let db;
  try {
    db = await loadDb();
  } catch {
    console.log('[feature-backtest] no odds-db.json available — restore the odds-data artifact first.');
    process.exit(0);
  }
  const featuresFile = process.argv.find((a) => a.startsWith('--features='));
  let features = null;
  if (featuresFile) {
    const { loadFeatureData } = await import('./features.mjs');
    const fd = loadFeatureData(resolveDataPath(featuresFile.split('=')[1]));
    features = buildFeaturesById(db, fd);
  }
  const formFile = process.argv.find((a) => a.startsWith('--form='));
  let formDb = null;
  if (formFile) {
    const { loadTeamForm } = await import('../lib/team-form.mjs');
    formDb = loadTeamForm(resolveDataPath(formFile.split('=')[1]));
  }
  const standingsFile = process.argv.find((a) => a.startsWith('--standings='));
  let standings = null;
  if (standingsFile) {
    standings = loadStandings(resolveDataPath(standingsFile.split('=')[1]));
  }
  // Parse --flag=value or --flag value from argv.
  const argValue = (name, def) => {
    const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(`--${name}=`.length);
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : def;
  };
  const trainFrac = Number(argValue('train-frac', '0.7'));
  const method = argValue('method', 'split');
  const k = Number(argValue('k', '5'));
  const folds = Number(argValue('folds', '5'));

  console.log(`=== Feature ablation backtest (method=${method}, trainFrac=${trainFrac}) ===`);
  const ablation = runAblation(db, { features, formDb, standings, trainFrac, method, k, folds });
  for (const r of ablation.rows) {
    console.log(
      `${r.label.padEnd(22)} n=${String(r.n).padStart(4)}  ROI=${String(r.roi).padStart(6)}%  ` +
        `CI=[${r.ciLow}%,${r.ciHigh}%]  -> ${r.verdict}`
    );
  }
  const cmp = compare1X2Enrichment(db, { features, formDb, standings, trainFrac, method, k, folds });
  console.log('\n=== 1X2 DB-history enrichment vs existing BAND_1X2 selector ===');
  console.log(`baseline  n=${cmp.baseline.n}  ROI=${cmp.baseline.roi}%  ${cmp.baseline.verdict}`);
  console.log(`enriched  n=${cmp.enriched.n}  ROI=${cmp.enriched.roi}%  ${cmp.enriched.verdict}`);
  console.log(`delta ROI: ${cmp.deltaRoiPts > 0 ? '+' : ''}${cmp.deltaRoiPts} pts`);

  console.log('\n=== Per-section enrichment (favourite vs favourite + DB-history + steam) ===');
  const perMarket = compareAllMarkets(db, { features, formDb, standings, trainFrac, method, k, folds });
  for (const r of perMarket) {
    const name = MARKET_NAMES[r.marketId] ?? r.marketId;
    console.log(
      `${name.padEnd(12)} base n=${String(r.baseline.n).padStart(4)} ROI=${String(r.baseline.roi).padStart(6)}% ` +
        `${r.baseline.verdict.padEnd(9)} | +hist n=${String(r.dbHistoryOnly.n).padStart(4)} ROI=${String(r.dbHistoryOnly.roi).padStart(6)}% ` +
        `${r.dbHistoryOnly.verdict.padEnd(9)} | enrich n=${String(r.enriched.n).padStart(4)} ROI=${String(r.enriched.roi).padStart(6)}% ${r.enriched.verdict.padEnd(9)}` +
        `| +pos n=${String(r.competition.n).padStart(4)} ROI=${String(r.competition.roi).padStart(6)}% ${r.competition.verdict}`
    );
  }

  if (process.argv.includes('--write')) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(DATA_DIR, 'feature-backtest.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), trainFrac, method, ablation, enrichment: cmp, perMarket }, null, 2)
    );
    console.log('\nWrote data/feature-backtest.json');
  }
}

// Map loaded feature data (meetings + contexts) onto eventIds from the DB.
function buildFeaturesById(db, fd) {
  const out = {};
  for (const ev of Object.values(db.events ?? {})) {
    const found = (fd.meetings ?? []).filter(
      (m) => normEq(m.home, ev.homeTeam) && normEq(m.away, ev.awayTeam)
    );
    const ctx = Object.values(fd.contexts ?? {}).find(
      (c) => normEq(c.tournament, ev.tournament)
    );
    out[ev.eventId] = { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, meetings: found, competition: ctx };
  }
  return out;
}
function normEq(a, b) {
  return String(a ?? '').trim().toLowerCase() === String(b ?? '').trim().toLowerCase();
}
