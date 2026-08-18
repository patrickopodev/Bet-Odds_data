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

// News sentiment from the team's web snippets: negative words (injury,
// suspension, doubt) push confidence down, positive (returning, fit,
// available) push it up. Research feeds the score instead of being collected
// and ignored.
const NEGATIVE_NEWS = /\b(injur|suspended|suspension|doubtful|ruled out|out of|absent|banned|sidelin|doubt)\b/i;
const POSITIVE_NEWS = /\b(returns?|returning|back from|available|recover|fit|boost|cleared)\b/i;

function researchSignal(t: TeamInfo): number {
  const text = (t.research ?? []).join(' ').toLowerCase();
  if (!text) return 0;
  const neg = (text.match(NEGATIVE_NEWS) ?? []).length;
  const pos = (text.match(POSITIVE_NEWS) ?? []).length;
  return Math.max(-0.15, Math.min(0.15, (pos - neg) * 0.05));
}

// Player-intel signal from the dedicated injury/lineup queries plus the
// Flashscore last-5 stats. Injuries/suspensions are the strongest negative;
// a lineup naming key players is mildly positive; a deep recent scorer list
// nudges attack-relevant confidence slightly.
function playerSignal(t: TeamInfo): number {
  let score = 0;
  const injuryText = (t.injuries ?? []).join(' ').toLowerCase();
  const neg = (injuryText.match(NEGATIVE_NEWS) ?? []).length;
  if (neg > 0) score -= Math.min(0.15, neg * 0.06);
  const posInjury = (injuryText.match(POSITIVE_NEWS) ?? []).length;
  if (posInjury > 0) score += Math.min(0.05, posInjury * 0.02);
  if ((t.keyPlayers ?? []).length > 0) score += 0.03;
  if ((t.scorers ?? []).length > 0) score += 0.02;
  return score;
}

function teamConfidence(t: TeamInfo, base: number): number {
  let score = base;
  // Form scaled by how many games actually contributed (lastResults may be
  // short; the form string is the fallback count). 15 = WWWWW → full +0.15;
  // 0 = LLLLL → -0.15; the midpoint is a neutral 0, so a 3W2D team lands
  // slightly positive instead of a flat tier.
  const games = Math.max(1, t.lastResults.length || t.form.length);
  const formPct = t.formScore / (games * 3);
  score += (formPct - 0.5) * 0.3;
  if (t.position && t.position <= 2) score += 0.1;
  else if (t.position && t.position <= 4) score += 0.05;
  // Only trust the table when we know the team has played enough to make the
  // position meaningful (avoid a 2-game "1st" place being treated as elite).
  if (t.played && t.played >= 6 && t.position && t.position > 12) score -= 0.05;
  score += researchSignal(t);
  score += playerSignal(t);
  if (t.error) score -= 0.1;
  return Math.max(0.05, Math.min(1, score));
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
      if ((t.injuries ?? []).length) reason += `, ${t.injuries.length} injury note(s)`;
      if ((t.keyPlayers ?? []).length) reason += `, key players mentioned`;
      if ((t.scorers ?? []).length) {
        const top = t.scorers[0];
        reason += `, last5 scorer ${top.player} (${top.count})`;
      }
    }
    if (c.outcome === 'Draw') reason = 'draw, no team edge';
  } else if (c.marketId === '18') {
    const over = c.outcome.startsWith('Over');
    const line = parseFloat(c.outcome.replace(/^Over |^Under /, ''));
    const totals = [...m.home.lastResults, ...m.away.lastResults].map((r) => {
      const s = r.score.split('-').map(Number);
      return s[0] + s[1];
    });
    const avg = totals.length ? totals.reduce((x, y) => x + y, 0) / totals.length : 0;
    // Line-aware: confidence is about whether the historical average goals
    // actually clears (Over) or stays under (Under) the market line, not just
    // a monotone bump on avg. Gap of one goal either side of the line moves
    // confidence by ~0.08 per tenth of a goal.
    const gap = over ? avg - line : line - avg;
    confidence = Math.min(0.95, Math.max(0.05, 0.35 + gap * 0.8));
    reason = `avg last-5 total ${avg.toFixed(1)} vs ${over ? 'Over' : 'Under'} ${line}`;
  }

  // Officials (referee/venue) are match-level context that applies to every
  // market; surface them once so the report reads like real scouting.
  const off = m.officials;
  if (off && (off.referee || off.venue)) {
    const bits: string[] = [];
    if (off.referee) bits.push(`ref ${off.referee}`);
    if (off.venue) bits.push(`@${off.venue}`);
    if (off.attendance) bits.push(`att ${off.attendance}`);
    if (bits.length) reason += ` [${bits.join(', ')}]`;
  }

  // Historical record at a matched odds band is a strong signal, but only to
  // the extent the sample is big enough to trust it. Scale its influence by
  // the settled count so a 100% record over 4 matches can't swing a bet the
  // way the same record over 40 matches would.
  if (hist.winRate != null) {
    const sampleFactor = Math.min(1, hist.settled / 20);
    const sampleNote = hist.settled < 10 ? ' LOW SAMPLE' : '';
    if (edge != null && edge > 0) {
      confidence = Math.min(1, confidence + Math.min(0.25, edge) * sampleFactor);
      reason += `, hist ${(hist.winRate * 100).toFixed(0)}% @~${c.odds.toFixed(2)} (${hist.settled} settled${sampleNote})`;
    } else if (edge != null && edge < 0) {
      confidence -= Math.min(0.2, Math.abs(edge)) * sampleFactor;
      reason += `, hist below implied ${(hist.winRate * 100).toFixed(0)}% (${hist.settled} settled${sampleNote})`;
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