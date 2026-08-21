import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const AGENT_FILE = path.join(DATA_DIR, 'agent-recommendations.json');
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');

const STAKE_PER_BET = Number(process.env.STAKE_PER_BET ?? 10);
const ALLOW_FRIENDLIES = process.env.ALLOW_FRIENDLIES === 'true';
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE ?? 0.6);

// Slip composition rule (user-defined):
//  - odds >= SINGLE_ODDS_MIN  -> that match alone on its own slip
//  - odds in [BUNDLE_ODDS_MIN, SINGLE_ODDS_MIN) -> bundled, up to BUNDLE_SIZE
//    recommended matches per slip (fewer than BUNDLE_SIZE is allowed).
export const SINGLE_ODDS_MIN = 3.0;
export const BUNDLE_ODDS_MIN = 1.25;
export const BUNDLE_SIZE = 4;

function isFriendly(tournament) {
  return /friendly|friendlies|pre-season|preseason/i.test(tournament ?? '');
}

export { isFriendly };

function envInt(name) {
  const v = process.env[name];
  return v == null || v === '' ? null : Number(v);
}

// Cap the number of ACTIVE slips (money at risk) the pipeline may hold. The
// workflow passes STAKE_MAX_SLIPS as a safety floor; once a run has recorded a
// live bankroll (autoplace writes slip.bankroll.maxSlips), that tighter budget
// cap also applies. null means "no cap" for manual runs.
export function effectiveMaxSlips(slip) {
  const candidates = [envInt('STAKE_MAX_SLIPS'), slip?.bankroll?.maxSlips ?? null].filter(
    (x) => x != null && Number.isFinite(x) && x > 0
  );
  return candidates.length ? Math.min(...candidates) : null;
}

// Statuses that count toward the active-slip cap: money is at risk, is about to
// be placed, or a replacement still needs to be selected. 'unverified' counts
// too: the placement click may have gone through without a success toast, so
// the money must be treated as at risk until someone reconciles the bet
// history. Terminal ledger entries (settled/cancelled/failed) never consume
// capacity.
export const ACTIVE_BET_STATUSES = ['pending', 'skipped', 'slip-ready', 'confirmed', 'placed', 'unverified'];

// Slips that must survive a slip regeneration: anything past plain selection
// (share code out, placed, confirmed, settled...) stays on the ledger so the
// monitor can still settle it and results are never wiped between runs.
export function keepableSlips(slip) {
  const all = slip?.slips ?? [];
  return all.filter((s) => s.status !== 'pending' && s.status !== 'skipped');
}

// Backwards-compat: keepableBets reports the flat leg list of keepable slips.
export function keepableBets(slip) {
  return keepableSlips(slip).flatMap((s) => s.legs);
}

// Pick at most one bet per market per match, then rank matches by the best
// candidate's confidence. `opts.exclude` lets a refill skip matches/outcomes
// already attempted. Returns picks as { match, candidate }.
export function selectBets(report, opts = {}) {
  const picks = [];
  const exclude = opts.exclude ?? (() => false);
  for (const rec of report.matches ?? []) {
    const { match, candidates } = rec;
    if (!candidates || !candidates.length) continue;
    if (isFriendly(match.tournament) && !ALLOW_FRIENDLIES) continue;

    const recCands = candidates.filter(
      (c) => c.recommended && c.confidence >= MIN_CONFIDENCE && c.odds >= c.recommendedMinOdds
    );

    // Group into buckets that overlap, keep only the best of each bucket.
    const best = new Map(); // bucket key -> candidate
    for (const c of recCands) {
      const bucket =
        c.marketId === '1'
          ? '1X2'
          : c.marketId === '18'
            ? 'O/U'
            : c.marketId === '548'
              ? 'TG'
              : `m${c.marketId}`;
      const prev = best.get(bucket);
      if (!prev || c.confidence > prev.confidence) best.set(bucket, c);
    }

    const scored = [];
    for (const c of best.values()) {
      if (c.marketId === '1' && (c.odds < 1.4 || c.odds > 4.0)) continue;
      if (c.marketId === '18' && (c.odds < 1.4 || c.odds > 2.5)) continue;
      if (c.marketId === '548' && c.odds < 1.8) continue;
      scored.push(c);
    }
    if (scored.length) {
      const candidate = scored.sort((a, b) => b.confidence - a.confidence)[0];
      if (!exclude({ match, candidate })) picks.push({ match, candidate });
    }
  }

  picks.sort((a, b) => b.candidate.confidence - a.candidate.confidence);
  return picks;
}

function toLeg(match, candidate) {
  return {
    eventId: match.eventId,
    homeTeam: match.homeTeam,
    awayTeam: match.awayTeam,
    tournament: match.tournament,
    startTime: match.startTime,
    marketId: candidate.marketId,
    market: candidate.market,
    outcome: candidate.outcome,
    odds: candidate.odds,
    minOdds: candidate.recommendedMinOdds,
    confidence: candidate.confidence,
    result: null,
    finalScore: null,
    error: null,
  };
}

// Group ranked picks into slips per the composition rule: singles for odds >=
// SINGLE_ODDS_MIN, bundles of up to BUNDLE_SIZE for odds in
// [BUNDLE_ODDS_MIN, SINGLE_ODDS_MIN). A leftover bundle with fewer than
// BUNDLE_SIZE legs is still placed (user: "place with whatever qualifies").
export function groupSlips(picks) {
  const singles = picks.filter((p) => p.candidate.odds >= SINGLE_ODDS_MIN);
  const bundles = picks.filter(
    (p) => p.candidate.odds >= BUNDLE_ODDS_MIN && p.candidate.odds < SINGLE_ODDS_MIN
  );
  const slips = [];
  let n = 1;
  for (const p of singles) {
    slips.push(makeSlip(`slip-${n++}`, 'single', [p]));
  }
  for (let i = 0; i < bundles.length; i += BUNDLE_SIZE) {
    slips.push(makeSlip(`slip-${n++}`, 'multi', bundles.slice(i, i + BUNDLE_SIZE)));
  }
  return slips;
}

function makeSlip(slipId, type, pickLegs) {
  const legs = pickLegs.map(({ match, candidate }) => toLeg(match, candidate));
  const combinedOdds = Math.round(legs.reduce((acc, l) => acc * l.odds, 1) * 100) / 100;
  return {
    slipId,
    type, // 'single' | 'multi'
    stake: STAKE_PER_BET,
    combinedOdds,
    status: 'pending', // pending -> slip-ready -> placed -> confirmed -> settled
    shareCode: null,
    shareUrl: null,
    error: null,
    placedAt: null,
    settledAt: null,
    result: null,
    payout: null,
    net: null,
    legs,
  };
}

// Migrate the legacy flat `bets` ledger (each bet was its own single slip)
// into the `slips` grouping model.
export function normalizeSlip(slip) {
  if (!slip) return null;
  if (slip.slips) return slip;
  const bets = slip.bets ?? [];
  const slips = bets.map((b, i) => ({
    slipId: `legacy-${i + 1}`,
    type: 'single',
    stake: b.stake ?? STAKE_PER_BET,
    combinedOdds: b.odds ?? null,
    status: b.status ?? 'pending',
    shareCode: b.shareCode ?? null,
    shareUrl: b.shareUrl ?? null,
    error: b.error ?? null,
    placedAt: b.placedAt ?? null,
    settledAt: b.settledAt ?? null,
    result: b.result ?? null,
    payout: b.payout ?? null,
    net: b.net ?? null,
    legs: [{ ...b }],
  }));
  return { ...slip, slips, stakePerSlip: slip.stakePerBet ?? STAKE_PER_BET };
}

// Build the next slip without losing the money ledger: carry over every slip
// that has left the selection stage, never re-pick a match or combination
// already on the ledger, and select fresh slips only for the remaining
// capacity. `opts.maxSlips` caps the number of active slips (default: as many
// as the report allows).
export function nextSlip(existing, report, opts = {}) {
  const prev = normalizeSlip(existing);
  const maxSlips = opts.maxSlips ?? Infinity;
  const preserved = prev ? keepableSlips(prev) : [];
  const activeKept = preserved.filter((s) => ACTIVE_BET_STATUSES.includes(s.status)).length;
  const capacity = Math.max(0, maxSlips - activeKept);
  // A match or combo is never re-picked once it has appeared on ANY slip —
  // kept or not. Skipped/failed/pending slips drop out of the preserved set
  // (so a replacement can be selected), but their matches must stay excluded,
  // otherwise the same teams come back on new slips the next run: that's what
  // produced duplicate legs across the ledger.
  const allLegs = (prev?.slips ?? []).flatMap((s) => s.legs);
  const excludedMatches = new Set(allLegs.map((l) => l.eventId));
  const attemptedCombos = new Set(allLegs.map((l) => `${l.eventId}|${l.marketId}|${l.outcome}`));
  const picks = selectBets(report, {
    exclude: ({ match, candidate }) =>
      excludedMatches.has(match.eventId) ||
      attemptedCombos.has(`${match.eventId}|${candidate.marketId}|${candidate.outcome}`),
  });
  const fresh = groupSlips(picks);
  const used = fresh.slice(0, capacity);
  const slip = {
    createdAt: new Date().toISOString(),
    stakePerSlip: prev?.stakePerSlip ?? STAKE_PER_BET,
    currency: prev?.currency ?? 'GHS',
    source: prev?.source ?? 'agent-recommendations.json',
    slips: [...preserved, ...used],
  };
  slip.preservedCount = preserved.length;
  return slip;
}

// Re-fill a slip's skipped slots from the agent report — the pipeline's own
// ranking, never a hand-picked substitute. Keeps placed/slip-ready slips
// intact, never re-picks a match already selected or a combination already
// attempted, and caps the slip count at maxSlips. Skipped slips are only
// pruned when a replacement actually exists, so a refill that finds nothing
// keeps the skipped record for the audit trail.
export function refillSlip(slip, report, opts = {}) {
  const maxSlips = opts.maxSlips ?? Infinity;
  const all = normalizeSlip(slip)?.slips ?? [];
  const keep = all.filter((s) => s.status !== 'skipped');
  const attempted = new Set(all.flatMap((s) => s.legs.map((l) => `${l.eventId}|${l.marketId}|${l.outcome}`)));
  // A match once selected — even on a skipped slip — is never re-picked.
  const pickedMatch = new Set(all.flatMap((s) => s.legs.map((l) => l.eventId)));
  const activeKept = keep.filter((s) => ACTIVE_BET_STATUSES.includes(s.status)).length;
  const capacity = maxSlips - activeKept;
  if (capacity <= 0) return { added: 0, exhausted: true, slips: [] };

  const picks = selectBets(report, {
    exclude: ({ match, candidate }) =>
      pickedMatch.has(match.eventId) || attempted.has(`${match.eventId}|${candidate.marketId}|${candidate.outcome}`),
  });
  const fresh = groupSlips(picks);
  const addedSlips = fresh.slice(0, capacity);
  if (addedSlips.length) {
    slip.slips = [...keep, ...addedSlips];
    slip.refilledAt = new Date().toISOString();
    slip.refilledCount = (slip.refilledCount ?? 0) + addedSlips.length;
  }
  return { added: addedSlips.length, exhausted: capacity <= 0 || fresh.length < capacity, slips: addedSlips };
}

function main() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
  } catch (e) {
    console.error(`stake: cannot read ${AGENT_FILE}: ${e.message}`);
    process.exit(0); // no agent output yet -> nothing to do, not an error
  }

  if (process.argv[2] === '--refill') {
    let slip;
    try {
      slip = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
    } catch (e) {
      console.error(`stake --refill: cannot read ${SLIP_FILE}: ${e.message}`);
      process.exit(0);
    }
    const { added, exhausted, slips: addedSlips } = refillSlip(slip, report);
    if (added > 0) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
    }
    console.log(`[stake:refill] added ${added} slip(s)${exhausted ? ' (no candidates left)' : ''}`);
    for (const s of addedSlips) {
      const names = s.legs.map((l) => `${l.homeTeam} vs ${l.awayTeam} (${l.market} ${l.outcome} @${l.odds})`).join(' + ');
      console.log(`  ${s.slipId} [${s.type}] ${names} — combined @${s.combinedOdds}`);
    }
    return;
  }

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
  } catch {
    existing = null;
  }
  const cap = effectiveMaxSlips(existing);
  const slip = cap != null ? nextSlip(existing, report, { maxSlips: cap }) : nextSlip(existing, report);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));

  const newSlips = slip.slips.slice(slip.preservedCount);
  console.log(`[stake] slip: ${slip.preservedCount} preserved from previous runs, ${newSlips.length} new slip(s)`);
  for (const s of newSlips) {
    const names = s.legs.map((l) => `${l.homeTeam} vs ${l.awayTeam} (${l.market} ${l.outcome} @${l.odds})`).join(' + ');
    console.log(`  ${s.slipId} [${s.type}] ${names} — combined @${s.combinedOdds}`);
  }
  if (!newSlips.length) console.log('[stake] no new slips selected this cycle');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (e) {
    console.error(`stake failed: ${e.message}`);
    process.exit(1);
  }
}