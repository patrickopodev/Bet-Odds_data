// ---------------------------------------------------------------------------
// OBSERVATION LEDGER + READINESS GATE (spec Phase 2/3 -> Phase 4 handoff).
//
// ADDITIVE + READ-ONLY. Each daily engine run appends (per calendar day) a record
// of the Strategy A equivalence check. A readiness gate then reports — but NEVER
// triggers — whether enough evidence has accumulated to safely retire the legacy
// workflows. This is the "controlled observation" bridge: prove equivalence over
// real cycles, then a human flips the switch in Phase 4.
//
// Nothing here stakes, deletes, or mutates production. The gate only emits a
// boolean + counts so the migration stays fail-closed until intentionally advanced.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareStrategyA } from './equivalence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const LOG_FILE = path.join(DATA_DIR, 'engine-observation-log.json');

export const READINESS_DEFAULTS = {
  minDays: 14, // distinct daily cycles observed
  minDistinctPicks: 20, // distinct eligible Strategy A picks seen across cycles
  requireAllEquivalent: true,
};

export function loadLog(file = LOG_FILE) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

function pickKeys(report) {
  return report.picks.engine.map((p) => `${p.eventId}|${p.selection}|${p.odds}`).sort();
}

// Record today's run (one entry per calendar day; latest run of the day wins).
export function recordRun(report, { file = LOG_FILE, now = Date.now() } = {}) {
  const date = new Date(now).toISOString().slice(0, 10);
  const entry = {
    date,
    ts: new Date(now).toISOString(),
    equivalenceWithValidated: report.equivalenceWithValidated,
    engineCount: report.counts.engine,
    legacyDeployedCount: report.counts.legacyDeployed,
    legacyValidatedCount: report.counts.legacyValidated,
    frozenOutDeltaCount: report.frozenOutDelta.length,
    eligibleEnginePicks: pickKeys(report),
  };
  const log = loadLog(file);
  const i = log.findIndex((e) => e.date === date);
  if (i >= 0) log[i] = entry;
  else log.push(entry);
  log.sort((a, b) => a.date.localeCompare(b.date));
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(log, null, 2));
  return log;
}

// Evaluate whether enough evidence exists to propose Phase 4 retirement.
// Returns { ready, runs, distinctPicks, allEquivalent, trailingEquivalent, note }.
export function evaluateReadiness(log, { defaults = READINESS_DEFAULTS } = {}) {
  const { minDays, minDistinctPicks, requireAllEquivalent } = defaults;
  const runs = log.length;
  const distinct = new Set(log.flatMap((e) => e.eligibleEnginePicks)).size;
  const allEquivalent = log.every((e) => e.equivalenceWithValidated);
  // Trailing consecutive equivalent runs (most recent first).
  let trailing = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].equivalenceWithValidated) trailing++;
    else break;
  }
  const pass = (!requireAllEquivalent || allEquivalent) && runs >= minDays && distinct >= minDistinctPicks;
  const note = pass
    ? 'READY to propose Phase 4 (retire legacy) for human review'
    : [
        allEquivalent ? null : 'equivalence violation detected',
        runs >= minDays ? null : `observed ${runs}/${minDays} daily cycles`,
        distinct >= minDistinctPicks ? null : `distinct picks ${distinct}/${minDistinctPicks}`,
      ]
        .filter(Boolean)
        .join('; ');
  return { ready: pass, runs, distinctPicks: distinct, allEquivalent, trailingEquivalent: trailing, note };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { loadDb } = await import('../lib/common.mjs');
  const report = compareStrategyA(await loadDb());
  const log = recordRun(report);
  const r = evaluateReadiness(log);
  console.log(`Daily cycles observed: ${r.runs} | distinct eligible picks: ${r.distinctPicks} | all equivalent: ${r.allEquivalent}`);
  console.log(`Readiness for Phase 4: ${r.ready ? 'READY ✅' : 'NOT YET'} — ${r.note}`);
}
