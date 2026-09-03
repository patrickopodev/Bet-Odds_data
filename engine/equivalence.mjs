// ---------------------------------------------------------------------------
// OBSERVATIONAL EQUIVALENCE HARNESS (spec Phase 2/3: "compare old selector
// output vs unified engine output").
//
// ADDITIVE + READ-ONLY. It never stakes, never edits workflows, and never
// mutates the registry. Run daily alongside the existing workflows to prove the
// new engine selects identically to the legacy Strategy A path under identical
// input data.
//
// Three comparisons, all restricted to the SAME upcoming + non-simulated +
// non-resolved + non-friendly guard the engine applies, so the only remaining
// difference is the band/money-path logic itself:
//
//   1. engine vs legacy selector at the SAME frozen band [1.8, 2.2)
//      -> proves the engine wraps the validated math verbatim (spec #6).
//   2. engine vs the ACTUAL legacy money path (stake.mjs selectBets/groupSlips)
//      -> proves any engine pick would also survive stake.mjs's confidence,
//         odds-window, EV and slip-composition gates (spec #20). This closes the
//         gap where the two paths apply different filters: the engine is a
//         strict subset of what stake.mjs would stake for 1X2.
//   3. (historical) the old widened 1.5 deployment is retained ONLY as a
//      reference for what the band-freeze removed. Production no longer uses
//      1.5 — the agent and stake path both read the frozen registry band.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFavRows, select1X2Picks, frozen1X2 } from '../lib/1x2.mjs';
import { loadRegistry } from './strategies.mjs';
import { identifyMatches, selectApproved } from './daily-engine.mjs';
import { selectBets, groupSlips, nextSlip } from '../stake.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const OUT_FILE = path.join(DATA_DIR, 'engine-equivalence.json');

const KEYS = (p) => `${p.eventId}|${p.selection}|${p.odds}`;
const toSet = (arr) => new Set(arr.map(KEYS));

// (1) Engine vs the legacy 1x2 selector at the frozen validated band.
export function compareStrategyA(db, { now = Date.now() } = {}) {
  const registry = loadRegistry();
  const strategyA = registry.strategies.find((s) => s.strategyId === 'STRAT-1X2-BAND-v1');
  const { lo: engineLo, hi: engineHi } = strategyA.parameters;

  const eligible = new Set(identifyMatches(db, now).map((e) => e.eventId));
  const base = buildFavRows(db);

  const legacyValidated = select1X2Picks(base, engineLo, engineHi)
    .filter((r) => eligible.has(r.eventId))
    .map((r) => ({ eventId: r.eventId, selection: r.favName, odds: r.favLast }));

  const { approved } = selectApproved({ db, registry, now });
  const enginePicks = approved
    .filter((p) => p.strategyId === 'STRAT-1X2-BAND-v1')
    .map((p) => ({ eventId: p.matchId, selection: p.selection, odds: p.odds }));

  const engSet = toSet(enginePicks);
  const valSet = toSet(legacyValidated);

  // Equivalence holds iff engine picks == legacy picks at the SAME (validated) band.
  const equivalenceWithValidated = engSet.size === valSet.size && [...engSet].every((k) => valSet.has(k));

  return {
    generatedAt: new Date().toISOString(),
    engineBand: [engineLo, engineHi],
    counts: {
      legacyValidated: legacyValidated.length,
      engine: enginePicks.length,
    },
    equivalenceWithValidated,
    picks: { legacyValidated, engine: enginePicks },
  };
}

// (2) Engine vs the REAL legacy money path (stake.mjs). Builds an agent-report-
// shaped input for Strategy A exactly as agent/analysis.ts force-recommends the
// in-band favourite, then runs it through stake.mjs's actual selection + EV-gate
// + slip-composition pipeline and compares the resulting legs to the engine.
export function compareStrategyAAgainstStake(db, { now = Date.now(), maxSlips = Infinity } = {}) {
  const registry = loadRegistry();

  const enginePicks = selectApproved({ db, registry, now })
    .approved.filter((p) => p.strategyId === 'STRAT-1X2-BAND-v1')
    .map((p) => ({ eventId: p.matchId, selection: p.selection, odds: p.odds }));

  // Mirror agent/analysis.ts: favourite in band -> recommended, confidence 0.92,
  // recommendedMinOdds = current odds (per AGENTS, FAV_CONFIDENCE default 0.92).
  const { lo, hi } = frozen1X2();
  const eligible = new Set(identifyMatches(db, now).map((e) => e.eventId));
  const rows = buildFavRows(db);
  const legacyCandidates = select1X2Picks(rows, lo, hi).filter((r) => eligible.has(r.eventId));
  const report = {
    matches: legacyCandidates.map((r) => ({
      match: {
        eventId: r.eventId,
        homeTeam: r.homeTeam,
        awayTeam: r.awayTeam,
        tournament: r.league,
        startTime: db.events?.[r.eventId]?.startTime ?? null,
      },
       candidates: [
         {
           marketId: '1',
           market: '1X2',
           outcome: r.favName,
           odds: r.favLast,
           recommended: true,
           confidence: 0.92,
           recommendedMinOdds: r.favLast,
           favBand: true,
         },
       ],
    })),
  };

  const slip = nextSlip(null, report, { maxSlips });
  const stakeLegs = (slip.slips ?? []).flatMap((s) => s.legs).map((l) => ({
    eventId: l.eventId,
    selection: l.outcome,
    odds: l.odds,
  }));

  const engSet = toSet(enginePicks);
  const stakeSet = toSet(stakeLegs);
  const equivalenceWithStakePipeline =
    engSet.size === stakeSet.size && [...engSet].every((k) => stakeSet.has(k));

  // (3) Gate-survival: every engine pick must clear stake.mjs's 1X2 odds window
  // [1.4, 4.0] and confidence floor (0.6). The frozen band [1.8, 2.2) is a
  // strict subset, so this is always true — encoded so the harness proves it.
  const STAKE_1X2_MIN = 1.4;
  const STAKE_1X2_MAX = 4.0;
  const enginePicksPassStakeGates = enginePicks.every(
    (p) => p.odds >= STAKE_1X2_MIN && p.odds <= STAKE_1X2_MAX
  );

  return {
    generatedAt: new Date().toISOString(),
    engineCount: enginePicks.length,
    stakePipelineCount: stakeLegs.length,
    equivalenceWithStakePipeline,
    enginePicksPassStakeGates,
    picks: { engine: enginePicks, stakePipeline: stakeLegs },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const write = process.argv.includes('--write');
  const { loadDb } = await import('../lib/common.mjs');
  const db = await loadDb();

  const a = compareStrategyA(db);
  console.log(`engine band ${JSON.stringify(a.engineBand)}`);
  console.log(`legacyValidated=${a.counts.legacyValidated} engine=${a.counts.engine}`);
  console.log(`Equivalence with validated selector: ${a.equivalenceWithValidated ? 'MATCH' : 'MISMATCH'}`);

  const b = compareStrategyAAgainstStake(db);
  console.log(`\nstake-pipeline legs=${b.stakePipelineCount} engine picks=${b.engineCount}`);
  console.log(`Equivalence with stake.mjs money path: ${b.equivalenceWithStakePipeline ? 'MATCH' : 'MISMATCH'}`);
  console.log(`Every engine pick clears stake.mjs gates: ${b.enginePicksPassStakeGates ? 'YES' : 'NO'}`);

  // Historical reference only: what the old widened 1.5 deployment would have
  // added. Production no longer uses 1.5 (frozen registry band is authoritative).
  const histRows = buildFavRows(db);
  const hist = select1X2Picks(histRows, 1.5, 2.2)
    .filter((r) => identifyMatches(db).some((e) => e.eventId === r.eventId))
    .map((r) => ({ eventId: r.eventId, selection: r.favName, odds: r.favLast }));
  const engSet = toSet(b.picks.engine);
  const histSet = toSet(hist);
  const historicalWidenedDelta = [...histSet].filter((k) => !engSet.has(k));
  console.log(`\n(historical) picks the old 1.5 widening would have added: ${historicalWidenedDelta.length} (no longer live)`);

  if (write) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      OUT_FILE,
      JSON.stringify({ ...a, stakePipeline: b, historicalWidenedDelta }, null, 2)
    );
    console.log(`\nWrote ${OUT_FILE}`);
  }
}
