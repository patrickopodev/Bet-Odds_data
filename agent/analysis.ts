import type { Candidate, MatchResearch, Recommendation, TeamInfo } from './types.js';
import { historicalStats, outcomeHistory, oddsDrift, MIN_DRIFT_PLAYS, type Db, type LatestMatch } from './db.js';
import { frozen1X2 } from '../lib/1x2.mjs';

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

// All four scraped sections are candidates. 1X2/O/U and Total Goals also get
// team-form signals; Correct Score (41) and Multiscores (551) rely purely on
// the odds-db history: their base confidence (0.35) only clears the 0.5
// recommendation bar when a trusted odds-band record adds up to +0.25 — i.e.
// the DB itself must prove the price wins before the agent backs it.
const RELEVANT_MARKETS = new Set(['1', '18', '548', '41', '551']);

// History is only trusted once enough matches have settled to separate signal
// from variance. Below this threshold the win rate stays informational (shown
// with a LOW SAMPLE note) but cannot move confidence or set the minimum odds —
// a 100% record over 3-4 matches is most likely noise, and letting it raise
// confidence to ~100% and back out a min odds of ~0.92 was a real hole.
const MIN_HISTORY_SAMPLE = 5;

// The 1X2 favorite priced in [BAND_LO, BAND_HI) is the validated, out-of-sample
// value pick (train-model-v5b.mjs: +16.8% ROI, CI excludes zero). When present we
// force-recommend it as the primary pick, overriding the heuristic confidence.
// The band is FROZEN from STRAT-1X2-BAND-v1 ([1.8, 2.2)); not env-tunable.
const { lo: BAND_LO, hi: BAND_HI } = frozen1X2();
const FAV_CONFIDENCE = Number(process.env.FAV_CONFIDENCE ?? 0.92);

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
  stats: ReturnType<typeof historicalStats>,
  movement: ReturnType<typeof oddsDrift> = null
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
    const totals = [...m.home.lastResults, ...m.away.lastResults].map((r) => {
      const s = r.score.split('-').map(Number);
      return s[0] + s[1];
    });
    const avg = totals.length ? totals.reduce((x, y) => x + y, 0) / totals.length : 0;
    confidence = Math.min(1, 0.3 + avg / 12);
    reason = `avg last-5 total ${avg.toFixed(1)}`;
  }

  // Historical record at a matched odds band is a strong signal, but only to
  // the extent the sample is big enough to trust it. Scale its influence by
  // the settled count so a 100% record over 4 matches can't swing a bet the
  // way the same record over 40 matches would. Below MIN_HISTORY_SAMPLE the
  // history is reported but ignored for the decision.
  if (hist.winRate != null) {
    const sampleFactor = Math.min(1, hist.settled / 10);
    const belowTrust = hist.settled < MIN_HISTORY_SAMPLE;
    const sampleNote = belowTrust ? ' LOW SAMPLE' : '';
    if (edge != null && edge > 0) {
      confidence = Math.min(1, confidence + (belowTrust ? 0 : Math.min(0.25, edge) * sampleFactor));
      reason += `, hist ${(hist.winRate * 100).toFixed(0)}% @~${c.odds.toFixed(2)} (${hist.settled} settled${sampleNote})`;
    } else if (edge != null && edge < 0) {
      confidence -= belowTrust ? 0 : Math.min(0.2, Math.abs(edge)) * sampleFactor;
      reason += `, hist below implied ${(hist.winRate * 100).toFixed(0)}% (${hist.settled} settled${sampleNote})`;
    } else {
      reason += `, hist ${(hist.winRate * 100).toFixed(0)}% (${hist.settled} settled${sampleNote})`;
    }
  }

  // Market movement from today's own snapshots: a price the market is backing
  // (steaming, drift < 0) nudges confidence up; a drifting price nudges it
  // down. Capped at ±0.05 and ignored below MIN_DRIFT_PLAYS distinct prices —
  // movement over 1-2 snapshots is noise, not signal.
  let oddsDriftValue: number | null = null;
  if (movement && movement.samples >= MIN_DRIFT_PLAYS && Math.abs(movement.drift) > 1e-9) {
    oddsDriftValue = movement.drift;
    const nudge = Math.min(0.05, Math.abs(movement.drift) * 0.5);
    if (movement.drift < 0) {
      confidence = Math.min(1, confidence + nudge);
      reason += `, steamed ${movement.first.toFixed(2)}→${movement.last.toFixed(2)} over ${movement.samples} prices`;
    } else {
      confidence -= nudge;
      reason += `, drifted ${movement.first.toFixed(2)}→${movement.last.toFixed(2)} over ${movement.samples} prices`;
    }
  }

  // Minimum odds the JS staker must respect: implied probability backed out of
  // the historical win rate, with a safety margin — but only when the sample is
  // big enough to trust. Otherwise fall back to the scraped odds floor.
  let recommendedMinOdds: number;
  if (hist.winRate != null && hist.winRate > 0.05 && hist.settled >= MIN_HISTORY_SAMPLE) {
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
    oddsDrift: oddsDriftValue,
    confidence: Math.max(0, Math.min(1, confidence)),
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
        const cand = analyzeCandidate(m, c, stats, oddsDrift(db.events?.[m.eventId], c.marketId, c.outcome));
        cand.market = marketNames(c.marketId);
        return cand;
      })
      .sort((a, b) => b.confidence - a.confidence);

    // Validated favorite-value rule: force-recommend the 1X2 favorite when its
    // current odds sit in [BAND_LO, BAND_HI). This is the one strategy the
    // backtest proves beats the house margin (+16.8% OOS, CI excludes zero).
    const oneXtwo = candidates.filter((c) => c.marketId === '1');
    if (oneXtwo.length === 3) {
      const fav = oneXtwo.reduce((a, b) => (a.odds <= b.odds ? a : b));
      if (fav.odds >= BAND_LO && fav.odds < BAND_HI) {
        fav.confidence = Math.max(fav.confidence, FAV_CONFIDENCE);
        fav.recommended = true;
        fav.recommendedMinOdds = fav.odds;
        fav.favBand = true;
        fav.reason += ` | FAVORITE VALUE band [${BAND_LO},${BAND_HI}) — validated +16.8% OOS`;
      }
    }

    recs.push({ match: m, candidates });
  }
  return recs;
}