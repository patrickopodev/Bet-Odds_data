import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const AGENT_FILE = path.join(DATA_DIR, 'agent-recommendations.json');
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');

const STAKE_PER_BET = Number(process.env.STAKE_PER_BET ?? 10);
const MAX_BETS = Number(process.env.MAX_BETS ?? 3);
const ALLOW_FRIENDLIES = process.env.ALLOW_FRIENDLIES === 'true';
const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE ?? 0.6);

function isFriendly(tournament) {
  return /friendly|friendlies|pre-season|preseason/i.test(tournament ?? '');
}

export { isFriendly };

// Statuses that count toward the MAX_BETS cap: money is at risk, is about to
// be placed, or a replacement still needs to be selected. Terminal ledger
// entries (settled/cancelled/failed) never consume capacity.
export const ACTIVE_BET_STATUSES = ['pending', 'skipped', 'slip-ready', 'confirmed', 'placed'];

// Bets that must survive a slip regeneration: anything past plain selection
// (share code out, placed, confirmed, settled...) stays on the ledger so the
// monitor can still settle it and results are never wiped between runs.
export function keepableBets(slip) {
  const all = slip?.bets ?? [];
  return all.filter((b) => b.status !== 'pending' && b.status !== 'skipped');
}

// Pick at most one bet per market per match, then rank matches by the best
// candidate's confidence and cap the total number of bets. `opts.exclude`
// lets a refill skip matches/outcomes already attempted; `opts.limit` caps the
// picks independently of MAX_BETS.
export function selectBets(report, opts = {}) {
  const picks = [];
  const exclude = opts.exclude ?? (() => false);
  const limit = opts.limit ?? MAX_BETS;
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
      // Reject lines that are trivial (odds too short to matter) or that mix
      // markets the user would not stake individually (e.g. 1X2 long shots).
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
  return picks.slice(0, limit);
}

function toBet(match, candidate) {
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
    stake: STAKE_PER_BET,
    status: 'pending',
    result: null,
    payout: null,
    net: null,
    error: null,
    placedAt: null,
    betReference: null,
  };
}

function buildSlip(bets, existing) {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    stakePerBet: existing?.stakePerBet ?? STAKE_PER_BET,
    currency: existing?.currency ?? 'GHS',
    source: existing?.source ?? 'agent-recommendations.json',
    bets: bets.map(({ match, candidate }) => toBet(match, candidate)),
  };
}

// Build the next slip without losing the money ledger: carry over every bet
// that has left the selection stage (share codes out, confirmed, placed,
// settled, ...), never re-pick a match or combination already on the ledger,
// and select fresh bets only for the remaining MAX_BETS capacity. Pending and
// skipped bets are dropped and replaced by this cycle's recommendations.
export function nextSlip(existing, report, opts = {}) {
  const maxBets = opts.maxBets ?? MAX_BETS;
  const preserved = keepableBets(existing);
  const activeKept = preserved.filter((b) => ACTIVE_BET_STATUSES.includes(b.status)).length;
  const capacity = Math.max(0, maxBets - activeKept);
  const excludedMatches = new Set(preserved.map((b) => b.eventId));
  const attemptedCombos = new Set(preserved.map((b) => `${b.eventId}|${b.marketId}|${b.outcome}`));
  const bets = selectBets(report, {
    limit: capacity,
    exclude: ({ match, candidate }) =>
      excludedMatches.has(match.eventId) || attemptedCombos.has(`${match.eventId}|${candidate.marketId}|${candidate.outcome}`),
  });
  const slip = buildSlip(bets, existing);
  slip.bets = [...preserved, ...slip.bets];
  slip.preservedCount = preserved.length;
  return slip;
}

// Re-fill a slip's skipped slots from the agent report — the pipeline's own
// ranking, never a hand-picked substitute. Keeps placed/slip-ready bets
// intact, never re-picks a match already selected or a combination that was
// already attempted (kept or skipped), and caps the slip at MAX_BETS.
// Skipped bets are only pruned when a replacement actually exists, so a
// refill that finds nothing keeps the skipped record for the audit trail.
export function refillSlip(slip, report, opts = {}) {
  const maxBets = opts.maxBets ?? MAX_BETS;
  const all = slip.bets ?? [];
  const keep = all.filter((b) => b.status !== 'skipped');
  const attempted = new Set(all.map((b) => `${b.eventId}|${b.marketId}|${b.outcome}`));
  const pickedMatch = new Set(keep.map((b) => b.eventId));
  // Only open/at-risk bets consume capacity; the settled ledger never blocks a refill.
  const activeKept = keep.filter((b) => ACTIVE_BET_STATUSES.includes(b.status)).length;
  const capacity = maxBets - activeKept;
  if (capacity <= 0) return { added: 0, exhausted: true, bets: [] };

  const picks = selectBets(report, {
    limit: capacity,
    exclude: ({ match, candidate }) =>
      pickedMatch.has(match.eventId) || attempted.has(`${match.eventId}|${candidate.marketId}|${candidate.outcome}`),
  });
  const addedBets = picks.map(({ match, candidate }) => toBet(match, candidate));
  if (addedBets.length) {
    slip.bets = [...keep, ...addedBets];
    slip.refilledAt = new Date().toISOString();
    slip.refilledCount = (slip.refilledCount ?? 0) + addedBets.length;
  }
  return { added: addedBets.length, exhausted: capacity <= 0 || picks.length < capacity, bets: addedBets };
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
    const { added, exhausted, bets: addedBets } = refillSlip(slip, report);
    if (added > 0) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
    }
    console.log(`[stake:refill] added ${added} bet(s)${exhausted ? ' (slip full or no candidates left)' : ''}`);
    for (const b of addedBets) {
      console.log(
        `  ${b.homeTeam} vs ${b.awayTeam} (${b.tournament}) — ${b.market} ${b.outcome} @${b.odds} conf ${(b.confidence * 100).toFixed(0)}%`
      );
    }
    return;
  }

  let existing = null;
  try {
    existing = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
  } catch {
    existing = null;
  }
  const slip = nextSlip(existing, report);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));

  const newBets = slip.bets.slice(slip.preservedCount);
  console.log(`[stake] slip: ${slip.preservedCount} preserved from previous runs, ${newBets.length} new bet(s)`);
  for (const b of newBets) {
    console.log(
      `  ${b.homeTeam} vs ${b.awayTeam} (${b.tournament}) — ${b.market} ${b.outcome} @${b.odds} conf ${(b.confidence * 100).toFixed(0)}%`
    );
  }
  if (!newBets.length) console.log('[stake] no new bets selected this cycle');
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