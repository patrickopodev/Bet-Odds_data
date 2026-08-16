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

// Pick at most one bet per market per match, then rank matches by the best
// candidate's confidence and cap the total number of bets.
export function selectBets(report) {
  const picks = [];
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
    if (scored.length) picks.push({ match, candidate: scored.sort((a, b) => b.confidence - a.confidence)[0] });
  }

  picks.sort((a, b) => b.candidate.confidence - a.candidate.confidence);
  return picks.slice(0, MAX_BETS);
}

function buildSlip(bets) {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    stakePerBet: STAKE_PER_BET,
    currency: 'GHS',
    source: 'agent-recommendations.json',
    bets: bets.map(({ match, candidate }) => ({
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
    })),
  };
}

function main() {
  let report;
  try {
    report = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
  } catch (e) {
    console.error(`stake: cannot read ${AGENT_FILE}: ${e.message}`);
    process.exit(0); // no agent output yet -> nothing to do, not an error
  }

  const bets = selectBets(report);
  const slip = buildSlip(bets);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));

  console.log(`[stake] selected ${slip.bets.length} bet(s)`);
  for (const b of slip.bets) {
    console.log(
      `  ${b.homeTeam} vs ${b.awayTeam} (${b.tournament}) — ${b.market} ${b.outcome} @${b.odds} conf ${(b.confidence * 100).toFixed(0)}%`
    );
  }
  if (!slip.bets.length) console.log('[stake] no bets selected this cycle');
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