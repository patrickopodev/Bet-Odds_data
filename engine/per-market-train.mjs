// ---------------------------------------------------------------------------
// PER-MARKET TRAINING SWEEP (spec: Phase 5 pipeline).
//
// One market-agnostic training/promotion framework. For each of the five markets
// it DISCOVERS a candidate strategy from raw resolved history, validates it on a
// FROZEN chronological holdout, and — only if it passes predefined criteria —
// mints an immutable PAPER strategy spec + an independent forward-paper ledger.
//
// It deliberately does NOT:
//   - promote anything to LIVE (human review only),
//   - invoke any staking executor,
//   - modify the existing LIVE 1X2 strategy (STRAT-1X2-FAVBAND-v1),
//   - modify Paper-B's frozen H1 specification (STRAT-OU-H1-v1),
//   - duplicate O/U H1 if the sweep re-discovers the exact existing rule.
//
// Discovery reproduces the candidate from raw data + chronological split; it does
// NOT convert a Stage-1 ROI number straight into a PAPER strategy (that would be
// a backdoor into the registry).
//
// Run modes:
//   --dry-run (default) : discover + validate + PRINT candidates, mutate nothing.
//   --apply             : mint PAPER specs, register in strategy-registry.json
//                         (append-only), create independent forward ledgers.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScore, evaluateOutcome } from '../lib/common.mjs';
import { loadRegistry, REGISTRY_PATH } from './strategies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';

const MARKET_NAMES = { '1': '1X2', '18': 'O/U', '41': 'Correct Score', '548': 'Multigoals', '551': 'Multiscores' };
const ID_PREFIX = { '1': 'STRAT-1X2', '18': 'STRAT-OU', '41': 'STRAT-CS', '548': 'STRAT-MG', '551': 'STRAT-MS' };

// Odds bands scanned during discovery (same family as the validated FAV_BAND scan).
export const BANDS = [[1.0, 1.3], [1.3, 1.5], [1.5, 1.8], [1.8, 2.2], [2.2, 3.0], [3.0, 4.0], [4.0, 6.0]];
export const MIN_TRAIN = 30; // resolved samples to trust a discovery
export const MIN_HOLDOUT = 20; // resolved samples to trust the frozen holdout
const GATE_RESOLVED = 30; // forward-paper promotion gate (mirrors Paper-B)

// --- raw history extraction --------------------------------------------------
export function resolvedRows(db) {
  const rows = [];
  for (const ev of Object.values(db.events ?? {})) {
    if (!ev.finalScore) continue;
    const score = parseScore(ev.finalScore);
    if (!score) continue;
    const t = ev.startTime ? Date.parse(ev.startTime) : 0;
    const byMarket = new Map();
    for (const o of Object.values(ev.outcomes ?? {})) {
      if (!byMarket.has(o.marketId)) byMarket.set(o.marketId, []);
      byMarket.get(o.marketId).push(o.name);
    }
    const evRows = [];
    for (const o of Object.values(ev.outcomes ?? {})) {
      const result = evaluateOutcome(o.marketId, o.name, score, byMarket.get(o.marketId));
      if (!result) continue;
      for (const p of o.plays ?? []) {
        evRows.push({ marketId: String(o.marketId), name: o.name, odds: p.odds, result, t });
      }
    }
    rows.push({ eventId: ev.eventId, t, rows: evRows });
  }
  return rows;
}

export function chronologicalSplit(events, trainFrac = 0.6) {
  const sorted = [...events].sort((a, b) => a.t - b.t);
  const cut = Math.floor(sorted.length * trainFrac);
  return { train: sorted.slice(0, cut), test: sorted.slice(cut) };
}

function pnlOf(result, odds) {
  if (result === 'WON') return odds - 1;
  if (result === 'LOST') return -1;
  return 0; // VOID
}
export { pnlOf };
export function roiOf(rows) {
  const settled = rows.filter((r) => r.result !== 'VOID');
  if (!settled.length) return { roi: null, n: 0, won: 0, lost: 0 };
  const pnl = settled.reduce((a, r) => a + pnlOf(r.result, r.odds), 0);
  return { roi: pnl / settled.length, n: settled.length, won: settled.filter((r) => r.result === 'WON').length, lost: settled.filter((r) => r.result === 'LOST').length };
}

// Discover the best (outcome, band) candidate per market from TRAIN rows only.
export function discoverCandidate(marketId, trainEvents, { bands = BANDS, minTrain = MIN_TRAIN } = {}) {
  const rows = trainEvents.flatMap((e) => e.rows).filter((r) => r.marketId === String(marketId));
  const names = [...new Set(rows.map((r) => r.name))];
  let best = null;
  for (const name of names) {
    for (const [lo, hi] of bands) {
      const inBand = rows.filter((r) => r.name === name && r.odds >= lo && r.odds < hi);
      const m = roiOf(inBand);
      if (m.n >= minTrain && m.roi != null && m.roi > 0) {
        if (!best || m.roi > best.trainRoi) {
          best = { marketId, selection: name, lo, hi, trainRoi: m.roi, trainN: m.n };
        }
      }
    }
  }
  return best;
}

// Validate the discovered candidate on the FROZEN holdout (never used for discovery).
export function validateHoldout(candidate, testEvents) {
  if (!candidate) return { holdoutRoi: null, holdoutN: 0, pass: false };
  const rows = testEvents.flatMap((e) => e.rows).filter(
    (r) => r.marketId === String(candidate.marketId) && r.name === candidate.selection && r.odds >= candidate.lo && r.odds < candidate.hi
  );
  const m = roiOf(rows);
  const pass = m.n >= MIN_HOLDOUT && m.roi != null && m.roi > 0 && candidate.trainN >= MIN_TRAIN;
  return { holdoutRoi: m.roi, holdoutN: m.n, pass };
}

function nextStrategyId(registry, marketId) {
  const prefix = ID_PREFIX[marketId];
  let i = 1;
  const have = new Set(registry.strategies.map((s) => s.strategyId));
  let id;
  do {
    id = `${prefix}-H${i}-v1`;
    i++;
  } while (have.has(id));
  return id;
}

// Recognize an existing equivalent PAPER spec so we never duplicate it.
export function findExistingEquivalent(registry, marketId, candidate) {
  return registry.strategies.find(
    (s) => s.marketId === String(marketId) && s.parameters?.selection === candidate.selection && s.parameters?.lo === candidate.lo && s.parameters?.hi === candidate.hi
  );
}

export function mintPaperStrategy(marketId, candidate, holdout, { registry, now = new Date().toISOString() } = {}) {
  const strategyId = nextStrategyId(registry, marketId);
  const specId = `${strategyId}#${Math.abs(hashStr(strategyId + JSON.stringify(candidate))).toString(36)}`;
  const strategy = {
    strategyId,
    version: 1,
    marketId: String(marketId),
    marketName: MARKET_NAMES[marketId],
    status: 'PAPER',
    validationStatus: 'HOLDOUT_TESTED',
    parameters: { selection: candidate.selection, lo: candidate.lo, hi: candidate.hi, gate: GATE_RESOLVED },
    source: 'engine/per-market-train.mjs chronological train/holdout',
    frozen: true,
    createdAt: now,
    specId,
    holdout: { roi: holdout.holdoutRoi, n: holdout.holdoutN },
    promotionRule: 'ELIGIBLE_FOR_HUMAN_REVIEW only when resolved>=30 AND ROI>0; never auto-LIVE.',
  };
  return strategy;
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// Append-only registry write: never touch existing entries.
export function registerStrategy(registry, strategy, { file = REGISTRY_PATH } = {}) {
  const reg = JSON.parse(JSON.stringify(registry));
  if (reg.strategies.some((s) => s.strategyId === strategy.strategyId)) return reg; // protect existing
  reg.strategies.push(strategy);
  return reg;
}

function ledgerPathFor(strategyId) {
  return path.join(DATA_DIR, `paper-${strategyId}.json`);
}

// Create the independent forward-paper ledger (preserve if it already exists).
export function createLedger(strategy, { write = true } = {}) {
  const file = ledgerPathFor(strategy.strategyId);
  if (fs.existsSync(file)) return file; // preserve existing ledger
  const ledger = {
    spec: {
      strategyId: strategy.strategyId,
      specId: strategy.specId,
      marketId: strategy.marketId,
      marketName: strategy.marketName,
      selection: strategy.parameters.selection,
      lo: strategy.parameters.lo,
      hi: strategy.parameters.hi,
      gate: strategy.parameters.gate,
    },
    startedAt: new Date().toISOString(),
    updatedAt: null,
    picks: [],
  };
  if (write) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(ledger, null, 2));
  }
  return file;
}

// --- orchestration ----------------------------------------------------------
export function runSweep(db, { apply = false, now = new Date().toISOString() } = {}) {
  const registry = loadRegistry();
  const events = resolvedRows(db);
  const { train, test } = chronologicalSplit(events);
  const discovered = [];

  for (const marketId of Object.keys(MARKET_NAMES)) {
    const state = (() => {
      const s = registry.strategies.find((x) => x.marketId === marketId);
      return s ? s.status : 'TRAINING';
    })();

    // 1X2 is LIVE — never touched.
    if (marketId === '1') {
      discovered.push({ marketId, market: MARKET_NAMES[marketId], state, action: 'Continue monitoring (LIVE)', candidate: null });
      continue;
    }
    // O/U H1 already exists — preserve, never duplicate.
    if (marketId === '18' && registry.strategies.some((s) => s.strategyId === 'STRAT-OU-H1-v1')) {
      discovered.push({ marketId, market: MARKET_NAMES[marketId], state: 'PAPER', action: 'Preserve existing H1; continue 30-pick forward test', candidate: null, preserved: 'STRAT-OU-H1-v1' });
      continue;
    }

    const candidate = discoverCandidate(marketId, train);
    const holdout = validateHoldout(candidate, test);
    if (!candidate || !holdout.pass) {
      discovered.push({
        marketId, market: MARKET_NAMES[marketId], state,
        action: 'No candidate passed holdout — keep collecting',
        candidate, holdout,
      });
      continue;
    }
    const existing = findExistingEquivalent(registry, marketId, candidate);
    if (existing) {
      discovered.push({ marketId, market: MARKET_NAMES[marketId], state: existing.status, action: 'Equivalent PAPER already registered', candidate, holdout, preserved: existing.strategyId });
      continue;
    }
    const strategy = mintPaperStrategy(marketId, candidate, holdout, { registry, now });
    if (apply) {
      const updated = registerStrategy(registry, strategy);
      fs.writeFileSync(REGISTRY_PATH, JSON.stringify(updated, null, 2));
      createLedger(strategy);
    }
    discovered.push({ marketId, market: MARKET_NAMES[marketId], state: 'TRAINING', action: apply ? `Minted PAPER ${strategy.strategyId}` : `WOULD mint PAPER ${strategy.strategyId}`, candidate, holdout, strategyId: strategy.strategyId });
  }
  return { discovered, registry };
}

// --- CLI --------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const apply = process.argv.includes('--apply');
  const { loadDb } = await import('../lib/common.mjs');
  const { discovered } = runSweep(await loadDb(), { apply });
  console.log('# Per-Market Training Sweep' + (apply ? ' (APPLY)' : ' (DRY-RUN — nothing registered)'));
  console.log('| Market | Current state | Next action |');
  console.log('|---|---|---|');
  for (const d of discovered) {
    console.log(`| ${d.market} | ${d.state} | ${d.action} |`);
  }
  console.log('\n## Discovered candidates');
  for (const d of discovered) {
    if (!d.candidate) continue;
    const h = d.holdout;
    console.log(`- ${d.market}: ${d.candidate.selection} @ [${d.candidate.lo}, ${d.candidate.hi}) | trainROI ${(d.candidate.trainRoi * 100).toFixed(1)}% (n=${d.candidate.trainN}) | holdoutROI ${h.holdoutRoi == null ? 'n/a' : (h.holdoutRoi * 100).toFixed(1) + '%'} (n=${h.holdoutN}) | ${d.action}`);
  }
  if (!apply) console.log('\n(Re-run with --apply to mint PAPER strategies + ledgers.)');
}
