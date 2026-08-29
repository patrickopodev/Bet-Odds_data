// ---------------------------------------------------------------------------
// TEAM-FORM STORE (research collection layer, Suggestion 4 of RESEARCH-PLAN.md).
//
// Persists, per settled match, a lightweight form/position snapshot for each
// team so the ablation harness (engine/backtest-harness.mjs) can TEST whether
// the agent's trusted form/position signals actually beat the house
// out-of-sample. It is collect-only + pure transforms — it never selects or
// stakes anything. The frozen 1X2_BAND strategy is untouched.
//
// The agent already trusts form/position in agent/analysis.ts:analyzeCandidate
// (formScore drives 1X2 confidence, lastResults goal totals drive O/U). Those
// signals are NOT in the odds-db, so the harness has never been able to test
// them. This module is the bridge: flashscore.ts calls appendTeamForm() per
// settled match and the resulting data/team-form.json is keyed by team.
//
// Store shape (data/team-form.json):
//   { [team]: TeamFormRecord[] }   // chronological snapshots, oldest first
//   TeamFormRecord = { asOf, position, formScore, lastResults, avgGoalsFor,
//                       avgGoalsAgainst }
// ---------------------------------------------------------------------------
import fs from 'node:fs';

// Append a snapshot for one team, de-duplicating on (team, asOf) so a re-run of
// the same match does not double-count. Returns the (mutated) store.
export function appendTeamForm(store, record) {
  const team = String(record.team ?? '').trim();
  if (!team) return store;
  if (!store[team]) store[team] = [];
  const asOf = record.asOf;
  const dup = store[team].find((r) => r.asOf === asOf);
  const cleaned = {
    asOf,
    position: record.position ?? null,
    formScore: record.formScore ?? null,
    lastResults: Array.isArray(record.lastResults) ? record.lastResults.slice() : [],
    avgGoalsFor: typeof record.avgGoalsFor === 'number' ? record.avgGoalsFor : null,
    avgGoalsAgainst: typeof record.avgGoalsAgainst === 'number' ? record.avgGoalsAgainst : null,
  };
  if (dup) {
    Object.assign(dup, cleaned);
  } else {
    store[team].push(cleaned);
  }
  store[team].sort((a, b) => Date.parse(a.asOf) - Date.parse(b.asOf));
  return store;
}

export function loadTeamForm(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) ?? {};
  } catch {
    return {};
  }
}

export function saveTeamForm(store, file) {
  fs.mkdirSync(file.replace(/[^/]*$/, ''), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(store, null, 2));
  return store;
}

// Derive a minimal team-form store from the odds-db alone (no Flashscore feed).
// Used as a fallback so the harness can still exercise the `form` gate on the
// real DB, and by tests. Per team per settled match it records the goals it
// scored/conceded and a 3/1/0 formScore for the result. Position is left null
// (the DB has no standings) — teamStrengthEdge degrades gracefully to form-only.
export function buildTeamFormStoreFromDb(db) {
  const store = {};
  const events = Object.values(db.events ?? {})
    .filter((e) => e.finalScore && e.homeTeam && e.awayTeam)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  for (const ev of events) {
    const [hg, ag] = String(ev.finalScore).split(':').map(Number);
    if (Number.isNaN(hg) || Number.isNaN(ag)) continue;
    const homeRes = hg > ag ? 'W' : hg === ag ? 'D' : 'L';
    const awayRes = hg < ag ? 'W' : hg === ag ? 'D' : 'L';
    appendTeamForm(store, {
      team: ev.homeTeam,
      asOf: ev.startTime,
      position: null,
      formScore: homeRes === 'W' ? 3 : homeRes === 'D' ? 1 : 0,
      lastResults: [{ opp: ev.awayTeam, score: `${hg}-${ag}`, result: homeRes }],
      avgGoalsFor: hg,
      avgGoalsAgainst: ag,
    });
    appendTeamForm(store, {
      team: ev.awayTeam,
      asOf: ev.startTime,
      position: null,
      formScore: awayRes === 'W' ? 3 : awayRes === 'D' ? 1 : 0,
      lastResults: [{ opp: ev.homeTeam, score: `${ag}-${hg}`, result: awayRes }],
      avgGoalsFor: ag,
      avgGoalsAgainst: hg,
    });
  }
  return store;
}
