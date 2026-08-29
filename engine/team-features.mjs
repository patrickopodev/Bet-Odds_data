// ---------------------------------------------------------------------------
// TEAM-FORM FEATURES (research layer, Suggestion 4 of RESEARCH-PLAN.md).
//
// Pure transforms over the team-form store (lib/team-form.mjs). They contain NO
// selection logic and NO staking. The harness's `formPasses` gate decides
// whether a feature IMPROVES the favourite (AND semantics like dbHistory/drift);
// promotion to a live strategy still requires the §6 governance gates.
//
// All functions are deterministic and unit-tested (test/engine/team-features.test.mjs).
// ---------------------------------------------------------------------------

// Most-recent snapshot for `team` as of `asOf`. Returns null when the team has
// no record at or before that time (never an "average over everything" leakage).
export function extractTeamForm(formDb, team, asOf = new Date().toISOString()) {
  const recs = formDb?.[String(team ?? '').trim()];
  if (!recs || !recs.length) return null;
  const asOfMs = Date.parse(asOf);
  let best = null;
  for (const r of recs) {
    const t = Date.parse(r.asOf);
    if (t <= asOfMs && (!best || t > Date.parse(best.asOf))) best = r;
  }
  if (!best) return null;
  return {
    asOf: best.asOf,
    position: best.position ?? null,
    formScore: best.formScore ?? null,
    lastResults: Array.isArray(best.lastResults) ? best.lastResults.slice() : [],
    avgGoalsFor: best.avgGoalsFor ?? null,
    avgGoalsAgainst: best.avgGoalsAgainst ?? null,
  };
}

// Normalized strength edge of HOME relative to AWAY, in [-1, 1]. Positive means
// home is stronger. Position (lower = better) and recent formScore are combined;
// either being null degrades gracefully to the other. Recency-anchored on asOf.
export function teamStrengthEdge(homeForm, awayForm, { posCap = 20 } = {}) {
  let edge = 0;
  let parts = 0;
  if (homeForm?.formScore != null && awayForm?.formScore != null) {
    const diff = (homeForm.formScore - awayForm.formScore) / 15; // formScore max 15
    edge += 0.5 * Math.max(-1, Math.min(1, diff));
    parts += 0.5;
  }
  if (homeForm?.position != null && awayForm?.position != null) {
    // lower position is better, so awayPos - homePos is positive when home leads.
    const diff = (awayForm.position - homeForm.position) / posCap;
    edge += 0.5 * Math.max(-1, Math.min(1, diff));
    parts += 0.5;
  }
  if (parts === 0) return 0;
  return edge / parts;
}

// Combined recent goals-per-match for a team (for the O/U goal-total
// hypothesis). Null when no form record exists.
export function teamAvgGoals(form) {
  if (!form) return null;
  if (form.avgGoalsFor == null || form.avgGoalsAgainst == null) return null;
  return (form.avgGoalsFor + form.avgGoalsAgainst) / 2;
}
