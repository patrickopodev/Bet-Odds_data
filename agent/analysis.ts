import type { Candidate, MatchResearch, Recommendation, TeamInfo } from './types.js';
import { historicalStats, outcomeHistory, type Db, type LatestMatch } from './db.js';

export interface CandidateSource {
  marketId: string;
  name: string;
  outcome: string;
  odds: number;
  active: boolean;
}

// Pull today's candidate outcomes from the scraped SportyBet data.
export function candidateSources(m: LatestMatch): CandidateSource[] {
  const out: CandidateSource[] = [];
  for (const markets of Object.values(m.markets ?? {})) {
    if (!markets) continue;
    for (const o of markets.outcomes ?? []) {
      if (!o.active || !o.marketId) continue;
      out.push({ marketId: o.marketId, name: markets.name, outcome: o.name, odds: o.odds, active: true });
    }
  }
  return out;
}

const RELEVANT_MARKETS = new Set(['1', '18', '548']);

function teamConfidence(t: TeamInfo, base: number): number {
  let score = base;
  if (t.formScore >= 9) score += 0.15; // 3+ wins in last 5
  else if (t.formScore >= 6) score += 0.07;
  if (t.position && t.position <= 2) score += 0.1;
  else if (t.position && t.position <= 4) score += 0.05;
  if (t.error) score -= 0.1;
  return Math.max(0, Math.min(1, score));
}

// Decide whether the historical record for this outcome is strong enough to
// back, and at what minimum odds the bet is still "value".
export function analyzeCandidate(
  m: MatchResearch,
  c: CandidateSource,
  stats: ReturnType<typeof historicalStats>
): Candidate {
  const implied = 1 / c.odds;
  const hist = outcomeHistory(stats, c.marketId, c.outcome, c.odds);
  let edge: number | null = null;
  if (hist.winRate != null) edge = hist.winRate - implied;

  let confidence = 0.35; // baseline for a plain scraped outcome
  let reason = `implied ${(implied * 100).toFixed(0)}%`;

  if (c.marketId === '1') {
    const isHome = c.outcome === 'Home';
    const isAway = c.outcome === 'Away';
    const t = isHome ? m.home : isAway ? m.away : null;
    if (t) {
      confidence = teamConfidence(t, 0.35);
      reason = `${t.name} form ${t.form || 'n/a'}`;
      if (t.position) reason += `, table #${t.position}`;
    }
    if (c.outcome === 'Draw') reason = 'draw, no team edge';
  } else if (c.marketId === '18') {
    const over = c.outcome.startsWith('Over');
    const totals = [...m.home.lastResults, ...m.away.lastResults].map((r) => {
      const s = r.score.split('-').map(Number);
      return s[0] + s[1];
    });
    const avg = totals.length ? totals.reduce((x, y) => x + y, 0) / totals.length : 0;
    confidence = Math.min(1, 0.3 + avg / 12);
    reason = `avg last-5 total ${avg.toFixed(1)}`;
  }

  // Historical record at a matched odds band is a strong signal.
  if (hist.winRate != null) {
    if (edge != null && edge > 0) {
      confidence = Math.min(1, confidence + Math.min(0.25, edge));
      reason += `, hist ${(hist.winRate * 100).toFixed(0)}% @~${c.odds.toFixed(2)} (${hist.settled})`;
    } else if (edge != null && edge < 0) {
      confidence -= Math.min(0.2, Math.abs(edge));
      reason += `, hist below implied (${(hist.winRate * 100).toFixed(0)}%)`;
    }
  }

  // Minimum odds the JS staker must respect: implied probability backed out of
  // the historical win rate, with a safety margin. If no history, fall back to
  // the scraped odds (must be >= 1.4 to even consider).
  let recommendedMinOdds: number;
  if (hist.winRate != null && hist.winRate > 0.05) {
    recommendedMinOdds = Number((1 / hist.winRate * 0.92).toFixed(2));
  } else {
    recommendedMinOdds = 1.4;
  }

  const relevant = RELEVANT_MARKETS.has(c.marketId);
  const recommended = relevant && confidence >= 0.5 && c.odds >= recommendedMinOdds && c.odds >= 1.3;

  return {
    marketId: c.marketId,
    outcome: c.outcome,
    odds: c.odds,
    impliedProb: implied,
    historicalWinRate: hist.winRate,
    historicalSettled: hist.settled,
    edge,
    confidence,
    recommendedMinOdds,
    recommended,
    reason,
  };
}

export function buildRecommendations(
  researched: MatchResearch[],
  matches: LatestMatch[],
  db: Db,
  marketNames: (marketId: string) => string
): Recommendation[] {
  const stats = historicalStats(db);
  const recs: Recommendation[] = [];
  for (const m of researched) {
    const src = matches.find((x) => x.eventId === m.eventId);
    if (!src) continue;
    const candidates = candidateSources(src)
      .filter((c) => RELEVANT_MARKETS.has(c.marketId))
      .map((c) => {
        const cand = analyzeCandidate(m, c, stats);
        cand.market = marketNames(c.marketId);
        return cand;
      })
      .sort((a, b) => b.confidence - a.confidence);
    recs.push({ match: m, candidates });
  }
  return recs;
}