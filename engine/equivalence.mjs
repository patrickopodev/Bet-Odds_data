// ---------------------------------------------------------------------------
// OBSERVATIONAL EQUIVALENCE HARNESS (spec Phase 2/3: "compare old selector
// output vs unified engine output").
//
// ADDITIVE + READ-ONLY. It never stakes, never edits workflows, and never
// mutates the registry. Run daily alongside the existing workflows to prove the
// new engine selects identically to the legacy Strategy A path under identical
// input data, and to quantify the delta introduced by freezing the band to the
// validated [1.8, 2.2) (the old FAV_BAND_LO=1.5 deployment adds 1.5–1.8 picks).
//
// Three sets are compared, all restricted to the SAME upcoming + non-simulated
// + non-resolved guard the engine applies, so the only remaining difference is
// the band definition itself:
//   - legacyDeployed : selectFavBand1X2Picks(db, 1.5, 2.2)  (what prod does now)
//   - legacyValidated: selectFavBand1X2Picks(db, 1.8, 2.2)  (band the engine uses)
//   - engine         : STRAT-1X2-FAVBAND-v1 via runEngine    (new path)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildFavRows, selectFavBand1X2Picks } from '../lib/favband.mjs';
import { loadRegistry } from './strategies.mjs';
import { identifyMatches, selectApproved } from './daily-engine.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const OUT_FILE = path.join(DATA_DIR, 'engine-equivalence.json');

const KEYS = (p) => `${p.eventId}|${p.selection}|${p.odds}`;
const toSet = (arr) => new Set(arr.map(KEYS));

export function compareStrategyA(db, { now = Date.now(), deployedLo = 1.5, deployedHi = 2.2 } = {}) {
  const registry = loadRegistry();
  const strategyA = registry.strategies.find((s) => s.strategyId === 'STRAT-1X2-FAVBAND-v1');
  const { lo: engineLo, hi: engineHi } = strategyA.parameters;

  // Eligible upcoming + non-simulated + non-resolved event ids (the engine guard).
  const eligible = new Set(identifyMatches(db, now).map((e) => e.eventId));
  const base = buildFavRows(db);

  const legacyDeployed = selectFavBand1X2Picks(base, deployedLo, deployedHi)
    .filter((r) => eligible.has(r.eventId))
    .map((r) => ({ eventId: r.eventId, selection: r.favName, odds: r.favLast }));

  const legacyValidated = selectFavBand1X2Picks(base, engineLo, engineHi)
    .filter((r) => eligible.has(r.eventId))
    .map((r) => ({ eventId: r.eventId, selection: r.favName, odds: r.favLast }));

  const { approved } = selectApproved({ db, registry, now });
  const enginePicks = approved
    .filter((p) => p.strategyId === 'STRAT-1X2-FAVBAND-v1')
    .map((p) => ({ eventId: p.matchId, selection: p.selection, odds: p.odds }));

  const engSet = toSet(enginePicks);
  const valSet = toSet(legacyValidated);

  // Equivalence holds iff engine picks == legacy picks at the SAME (validated) band.
  const equivalenceWithValidated = engSet.size === valSet.size && [...engSet].every((k) => valSet.has(k));

  // The production delta: picks prod currently takes (1.5 lo) that the engine
  // excludes because the validated band starts at 1.8.
  const depSet = toSet(legacyDeployed);
  const frozenOutDelta = [...depSet].filter((k) => !engSet.has(k));

  return {
    generatedAt: new Date().toISOString(),
    deployedBand: [deployedLo, deployedHi],
    engineBand: [engineLo, engineHi],
    counts: {
      legacyDeployed: legacyDeployed.length,
      legacyValidated: legacyValidated.length,
      engine: enginePicks.length,
    },
    equivalenceWithValidated,
    frozenOutDelta, // picks removed by the band freeze (expected, by design)
    picks: { legacyDeployed, legacyValidated, engine: enginePicks },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const write = process.argv.includes('--write');
  const { loadDb } = await import('../lib/common.mjs');
  const db = await loadDb();
  const report = compareStrategyA(db);
  console.log(`Deployed band ${JSON.stringify(report.deployedBand)} vs engine band ${JSON.stringify(report.engineBand)}`);
  console.log(`legacyDeployed=${report.counts.legacyDeployed} legacyValidated=${report.counts.legacyValidated} engine=${report.counts.engine}`);
  console.log(`Equivalence with validated band: ${report.equivalenceWithValidated ? 'MATCH ✅' : 'MISMATCH ❌'}`);
  console.log(`Picks removed by band freeze (1.5–1.8): ${report.frozenOutDelta.length}`);
  if (write) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
    console.log(`Wrote ${OUT_FILE}`);
  }
}
