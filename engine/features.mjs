// ---------------------------------------------------------------------------
// FEATURE EXTRACTION — pure, network-free transforms for the research layer.
//
// These turn RAW collected data (H2H meetings, standings/competition context)
// into STRUCTURED features a backtest can test. They contain NO selection logic
// and NO staking — they only summarise. Every function is deterministic and
// unit-tested, so a feature can be promoted to a strategy only after the
// backtest harness (engine/backtest-harness.mjs) proves it adds out-of-sample
// edge. See AGENTS.md "Engine cutover plan" — nothing here is auto-LIVE.
//
// IMPORTANT: the production repo does NOT yet collect structured H2H or
// standings beyond table position (the web research only stores free-text
// snippets; flashscore.ts resolves form + position). So these extractors take
// their inputs explicitly: callers supply the meetings/context arrays. A thin
// JSON loader (loadFeatureData) lets the harness and tests run without a live
// feed.
// ---------------------------------------------------------------------------
import fs from 'node:fs';

// One historical meeting between two clubs.
// date is an ISO string; scores are full-time goals.
// Shapes (documented as plain JS — this engine module is ESM JS, not TS):
//   Meeting = { date, home, away, homeScore, awayScore, competition? }
//   H2HFeatures = {
//     totalMeetings, sameYearMeetings, homeWins, awayWins, draws: number,
//     bttsRate, over25Rate, avgGoals, avgGoalsHome, avgGoalsAway: number,
//     recencyDays: number | null,
//     recent: { count, homeWins, awayWins, draws, bttsRate, over25Rate, avgGoals },
//     lastResult: Meeting | null,
//   }
//   CompetitionContext = { tournament, type: 'league'|'cup'|'unknown',
//                          position: number|null, tier: number|null, isCup: boolean }

function norm(s) {
  return String(s ?? '').trim().toLowerCase();
}

// Keep only meetings where the two named teams met (either order).
export function filterMeetingsByPair(meetings, teamA, teamB) {
  const a = norm(teamA);
  const b = norm(teamB);
  return (meetings ?? []).filter(
    (m) => (norm(m.home) === a && norm(m.away) === b) || (norm(m.home) === b && norm(m.away) === a)
  );
}

const CUP_RE = /cup|champions league|europa|conference|fa trophy|copa|coppa|coupe|pokal|knockout|playoff/i;

export function competitionType(tournament) {
  return CUP_RE.test(String(tournament ?? '')) ? 'cup' : 'league';
}

export function extractCompetitionContext(ctx = {}) {
  const isCup = ctx.isCup ?? CUP_RE.test(String(ctx.tournament ?? ''));
  return {
    tournament: ctx.tournament ?? '',
    type: isCup ? 'cup' : 'league',
    position: ctx.position ?? null,
    tier: ctx.tier ?? null,
    isCup,
  };
}

// Structured H2H features for a pair, summarised from teamA's perspective.
// `asOf` anchors same-year + recency. `recentN` sizes the recent window.
// Pure: identical inputs always yield identical output.
export function extractH2HFeatures(meetings, teamA, teamB, { asOf = new Date().toISOString(), sameYearOnly = false, recentN = 5 } = {}) {
  const a = norm(teamA);
  const b = norm(teamB);
  const asOfMs = Date.parse(asOf);
  const asOfYear = new Date(asOfMs).getUTCFullYear();

  const pair = filterMeetingsByPair(meetings, teamA, teamB);
  if (pair.length === 0) return emptyH2H();

  const sorted = [...pair].sort((x, y) => Date.parse(y.date) - Date.parse(x.date));
  const sameYear = sorted.filter((m) => new Date(Date.parse(m.date)).getUTCFullYear() === asOfYear);
  const pool = sameYearOnly ? sameYear : sorted;
  if (pool.length === 0) return emptyH2H();

  // Re-orient every meeting so teamA is always "home".
  const orient = (m) => {
    const teamAHome = norm(m.home) === a;
    return {
      aGoals: teamAHome ? m.homeScore : m.awayScore,
      bGoals: teamAHome ? m.awayScore : m.homeScore,
    };
  };

  const agg = (arr) => {
    let hw = 0, aw = 0, dr = 0, btts = 0, over = 0, g = 0, gh = 0, ga = 0;
    for (const m of arr) {
      const { aGoals, bGoals } = orient(m);
      if (aGoals > bGoals) hw++;
      else if (bGoals > aGoals) aw++;
      else dr++;
      if (aGoals > 0 && bGoals > 0) btts++;
      if (aGoals + bGoals > 2.5) over++;
      g += aGoals + bGoals;
      gh += aGoals;
      ga += bGoals;
    }
    const n = arr.length;
    return {
      homeWins: hw, awayWins: aw, draws: dr,
      bttsRate: btts / n, over25Rate: over / n,
      avgGoals: g / n, avgGoalsHome: gh / n, avgGoalsAway: ga / n,
    };
  };

  const base = agg(pool);
  const recent = agg(pool.slice(0, recentN));
  const last = pool[0];
  const recencyDays = last ? Math.max(0, (asOfMs - Date.parse(last.date)) / 86400000) : null;

  return {
    totalMeetings: pool.length,
    sameYearMeetings: sameYear.length,
    homeWins: base.homeWins,
    awayWins: base.awayWins,
    draws: base.draws,
    bttsRate: base.bttsRate,
    over25Rate: base.over25Rate,
    avgGoals: base.avgGoals,
    avgGoalsHome: base.avgGoalsHome,
    avgGoalsAway: base.avgGoalsAway,
    recencyDays,
    recent: {
      count: recentN < pool.length ? recentN : pool.length,
      homeWins: recent.homeWins,
      awayWins: recent.awayWins,
      draws: recent.draws,
      bttsRate: recent.bttsRate,
      over25Rate: recent.over25Rate,
      avgGoals: recent.avgGoals,
    },
    lastResult: last
      ? { date: last.date, home: last.home, away: last.away, homeScore: last.homeScore, awayScore: last.awayScore }
      : null,
  };
}

function emptyH2H() {
  return {
    totalMeetings: 0, sameYearMeetings: 0, homeWins: 0, awayWins: 0, draws: 0,
    bttsRate: 0, over25Rate: 0, avgGoals: 0, avgGoalsHome: 0, avgGoalsAway: 0,
    recencyDays: null,
    recent: { count: 0, homeWins: 0, awayWins: 0, draws: 0, bttsRate: 0, over25Rate: 0, avgGoals: 0 },
    lastResult: null,
  };
}

// Thin JSON loader so the harness/tests can run without a live H2H feed.
// File shape: { meetings: Meeting[], contexts: Record<eventId, partial CompetitionContext> }
export function loadFeatureData(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  return {
    meetings: Array.isArray(raw.meetings) ? raw.meetings : [],
    contexts: raw.contexts && typeof raw.contexts === 'object' ? raw.contexts : {},
  };
}
