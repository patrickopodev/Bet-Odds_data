// ---------------------------------------------------------------------------
// EXECUTION ADAPTERS (spec #11, #12, #13).
//
// ManualExecutor and AutoExecutor consume the SAME approvedPicks array. The
// only difference is HOW the bet is placed: manual emits a SportyBet share code
// and STOPS; auto runs the safety gates then (opt-in) stakes real money.
//
// Both adapters derive their selections through the SAME buildSelections()
// function, which is what makes execution parity enforceable (spec #20):
// given identical inputs + identical outcome-id resolver, the selection sets
// MUST be byte-identical before any execution divergence.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { stampExecution } from './pick.mjs';
import { validatePick, withinStakeLimits, GATE_DEFAULTS } from './validation.mjs';
import { isLive } from './strategies.mjs';

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
// AUTO EXECUTOR (spec #12): validate -> STAKE_AUTOPLACE_ENABLED? -> safety gates
// -> stake. Fail-closed: if autoplace is OFF, or no placeStake injected, it only
// builds the slip (no real money). placeStake is injected so tests never touch
// the browser; production injects a wrapper around stake-autoplace.mjs.
// ---------------------------------------------------------------------------
export async function autoExecute(
  approvedPicks,
  { resolveOutcomeId, stakeAutoplaceEnabled = false, placeStake = null, limits = GATE_DEFAULTS, now = Date.now() } = {}
) {
  if (!resolveOutcomeId) throw new Error('autoExecute requires resolveOutcomeId');

  const selections = buildSelections(approvedPicks, resolveOutcomeId);
  const strategyById = new Map(); // not needed but documents parity
  void strategyById;

  // Re-run the shared gate on every pick (defense in depth, even if the engine
  // already gated — auto path must never trust the engine blindly).
  const gated = approvedPicks.map((p) => {
    const v = validatePick(p, { strategy: { status: p.audit.strategyStatus, parameters: p.audit.strategyParams }, liveOdds: p.liveOdds, now, limits });
    return { pick: p, ok: v.ok, failures: v.failures };
  });
  const passed = gated.filter((g) => g.ok).map((g) => g.pick);

  const limitCheck = withinStakeLimits(passed.map((p) => ({ status: 'pending' })), { limits });
  const mayStake = stakeAutoplaceEnabled && limitCheck.ok && passed.length > 0;

  let staked = false;
  let stakeResult = null;
  if (mayStake) {
    if (typeof placeStake !== 'function') {
      // Fail closed: enabled but no staking adapter wired -> do NOT stake.
      stakeResult = { staked: false, reason: 'NO_STAKE_ADAPTER' };
    } else {
      stakeResult = await placeStake(passed, selections);
      staked = Boolean(stakeResult?.staked);
    }
  }

  const stamped = approvedPicks.map((p) => {
    const g = gated.find((x) => x.pick === p);
    if (!g.ok) return stampExecution(p, { mode: 'AUTO_SKIPPED', result: 'REJECTED:' + g.failures.join(';') });
    return stampExecution(p, { mode: mayStake && staked ? 'AUTO' : 'AUTO_PENDING', stake: mayStake ? p.odds : null });
  });

  return {
    mode: 'AUTO',
    stakes: staked,
    autoplaceEnabled: stakeAutoplaceEnabled,
    limitOk: limitCheck.ok,
    selections,
    stakeResult,
    picks: stamped,
  };
}

// Parity assertion (spec #20): manual and auto must derive identical selections.
export function assertExecutionParity(manualSelections, autoSelections) {
  const norm = (s) => JSON.stringify(s.map((x) => [x.eventId, x.marketId, x.outcomeId, x.specifier ?? null]).sort());
  if (norm(manualSelections) !== norm(autoSelections)) {
    throw new Error('EXECUTION_PARITY_VIOLATION: manual and auto selections diverge');
  }
  return true;
}
