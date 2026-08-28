// ---------------------------------------------------------------------------
// APPROVED PICK — the single object both manual and auto executors consume
// (spec #13). Guarantees the two execution paths can never diverge on WHICH
// bets were selected; only HOW they are placed differs.
//
// Also builds the audit trail (spec #21): every live candidate is traceable
// from match -> market -> strategy version -> params -> odds -> research ->
// gates -> approved/rejected -> execution mode -> stake -> result -> P/L.
// ---------------------------------------------------------------------------
import { randomUUID } from 'node:crypto';
import { getMarket, parseLineOutcome } from './markets.mjs';
import { getStrategy } from './strategies.mjs';

export function makePickId() {
  return 'pk_' + randomUUID().replace(/-/g, '').slice(0, 12);
}

// Construct one ApprovedPick from a strategy + raw candidate + gates result.
// `researchStatus` is the explicit SearchStatus (SEARCH_SUCCESS |
// SEARCH_NO_RESULTS | SEARCH_BLOCKED | SEARCH_ERROR) — never silently empty.
export function buildApprovedPick({ strategy, candidate, liveOdds = null, validation, researchStatus = 'SEARCH_NO_RESULTS', generatedAt = new Date().toISOString() }) {
  const market = getMarket(strategy.marketId);
  const parsed = market?.needsSpecifier ? parseLineOutcome(candidate.selection) : null;
  const line = candidate.line != null ? candidate.line : parsed?.line ?? null;
  const recommendedMinOdds = strategy.parameters?.lo != null ? strategy.parameters.lo : candidate.odds;

  return {
    pickId: makePickId(),
    matchId: candidate.eventId,
    marketId: strategy.marketId,
    marketName: market?.name ?? strategy.marketId,
    strategyId: strategy.strategyId,
    strategyVersion: strategy.version,
    selection: candidate.selection,
    line,
    odds: candidate.odds,
    liveOdds,
    recommendedMinOdds,
    kickoff: candidate.kickoff ?? null,
    competition: candidate.league ?? null,
    confidence: strategy.parameters?.confidence ?? candidate.confidence ?? null,
    isSimulated: Boolean(candidate.isSimulated),
    researchStatus,
    generatedAt,
    audit: {
      strategyStatus: strategy.status,
      strategyParams: strategy.parameters,
      validationGates: validation ?? null,
      executionMode: null, // filled by executor
      stake: null,
      result: null,
      pnl: null,
    },
  };
}

// Convenience: build the ApprovedPick and stamp the execution mode + outcome.
export function stampExecution(pick, { mode, stake = null, result = null, pnl = null }) {
  return {
    ...pick,
    audit: {
      ...pick.audit,
      executionMode: mode,
      stake,
      result,
      pnl,
    },
  };
}
