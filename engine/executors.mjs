// ---------------------------------------------------------------------------
// EXECUTION ADAPTERS (spec #11, #13).
//
// The unified engine's ONLY live execution path is the MANUAL executor: it
// verifies each pick, builds a SportyBet share code, records intent, and STOPS.
// Real money is placed by a human loading that code (or, on the legacy path, by
// `stake-autoplace.mjs` behind the opt-in STAKE_AUTOPLACE_ENABLED gate).
//
// There is intentionally ONE auto-stake implementation (stake-autoplace.mjs). A
// second, parallel `autoExecute` was removed: it was never wired into
// `betting.yml` and would have been an untested-in-prod auto-stake. Keeping a
// single auto-stake path removes the risk of two divergent implementations.
//
// All selection logic flows through buildSelections(), so the manual executor
// can never alter *which* picks are chosen — it only maps an ApprovedPick to a
// share-selection spec (spec #20).
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { stampExecution } from './pick.mjs';

const DATA_DIR = process.env.DATA_DIR ?? 'data';

// Map an ApprovedPick -> a SportyBet share selection spec
// "eventId,marketId,outcomeId[,specifier]". `resolveOutcomeId` is injected so
// tests can avoid network; production passes a live-catalog resolver.
export function buildSelections(approvedPicks, resolveOutcomeId) {
  return approvedPicks.map((p) => {
    const outcomeId = resolveOutcomeId(p);
    const sel = { eventId: p.matchId, marketId: p.marketId, outcomeId };
    if (p.line != null) sel.specifier = String(p.line);
    return sel;
  });
}

// ---------------------------------------------------------------------------
// MANUAL EXECUTOR (spec #11): verify -> build slip -> generate share code ->
// record intent -> STOP. Must never place the bet.
// ---------------------------------------------------------------------------
export async function manualExecute(approvedPicks, { resolveOutcomeId, createShareCode = null, writeLedger = true } = {}) {
  if (!resolveOutcomeId) throw new Error('manualExecute requires resolveOutcomeId');
  const selections = buildSelections(approvedPicks, resolveOutcomeId);
  let code = null;
  if (createShareCode) {
    const res = await createShareCode(selections);
    code = res.code;
  }
  const stamped = approvedPicks.map((p) => stampExecution(p, { mode: 'MANUAL' }));
  if (writeLedger) {
    const ledgerPath = path.join(DATA_DIR, 'manual-bets.json');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const prev = JSON.parse(fs.readFileSync(ledgerPath, 'utf8').catch(() => '[]') || '[]');
    const next = prev.concat(stamped.map((p) => ({ pickId: p.pickId, mode: 'MANUAL', code, generatedAt: p.generatedAt })));
    fs.writeFileSync(ledgerPath, JSON.stringify(next, null, 2));
  }
  return { mode: 'MANUAL', stakes: false, selections, code, picks: stamped };
}

// ---------------------------------------------------------------------------
// SELECTION FIDELITY (spec #20).
//
// The manual executor MUST NOT drop or alter any pick: the selections it emits
// must equal buildSelections(approvedPicks) exactly. This guarantees execution
// can never diverge from the validated engine selection — there is no second
// code path that could reorder, skip, or rewrite a pick.
// ---------------------------------------------------------------------------
export function assertSelectionFidelity(approvedPicks, resolveOutcomeId, selections) {
  const expected = buildSelections(approvedPicks, resolveOutcomeId);
  const norm = (s) =>
    JSON.stringify(s.map((x) => [x.eventId, x.marketId, x.outcomeId, x.specifier ?? null]).sort());
  if (norm(expected) !== norm(selections)) {
    throw new Error('SELECTION_FIDELITY_VIOLATION: executor altered the engine selection');
  }
  return true;
}
