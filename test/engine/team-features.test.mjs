import test from 'node:test';
import assert from 'node:assert/strict';
import { extractTeamForm, teamStrengthEdge, teamAvgGoals } from '../../engine/team-features.mjs';
import { appendTeamForm, buildTeamFormStoreFromDb } from '../../lib/team-form.mjs';

const FORM_DB = {
  Arsenal: [
    { asOf: '2026-01-01T00:00:00Z', position: 2, formScore: 12, lastResults: [], avgGoalsFor: 2, avgGoalsAgainst: 1 },
    { asOf: '2026-03-01T00:00:00Z', position: 1, formScore: 15, lastResults: [], avgGoalsFor: 3, avgGoalsAgainst: 0 },
  ],
  Chelsea: [
    { asOf: '2026-02-01T00:00:00Z', position: 9, formScore: 6, lastResults: [], avgGoalsFor: 1, avgGoalsAgainst: 2 },
  ],
};

test('extractTeamForm returns the most recent snapshot at or before asOf', () => {
  const f = extractTeamForm(FORM_DB, 'Arsenal', '2026-04-01T00:00:00Z');
  assert.equal(f.position, 1, 'picks the latest asOf record');
  const early = extractTeamForm(FORM_DB, 'Arsenal', '2026-02-01T00:00:00Z');
  assert.equal(early.position, 2, 'never looks into the future');
  assert.equal(extractTeamForm(FORM_DB, 'Unknown'), null, 'missing team -> null');
});

test('teamStrengthEdge sign follows form + position (home stronger => positive)', () => {
  const home = extractTeamForm(FORM_DB, 'Arsenal', '2026-04-01T00:00:00Z');
  const away = extractTeamForm(FORM_DB, 'Chelsea', '2026-04-01T00:00:00Z');
  assert.ok(teamStrengthEdge(home, away) > 0, 'Arsenal (1st, form15) stronger than Chelsea (9th, form6)');
  assert.ok(teamStrengthEdge(away, home) < 0, 'reversed teams reverse the sign');
});

test('teamStrengthEdge degrades gracefully when position is null', () => {
  const a = { formScore: 9, position: null };
  const b = { formScore: 3, position: null };
  assert.ok(teamStrengthEdge(a, b) > 0);
  assert.equal(teamStrengthEdge({ formScore: null, position: null }, { formScore: null, position: null }), 0);
});

test('teamAvgGoals combines for+against', () => {
  const f = extractTeamForm(FORM_DB, 'Arsenal', '2026-04-01T00:00:00Z');
  assert.equal(teamAvgGoals(f), 1.5);
  assert.equal(teamAvgGoals(null), null);
});

test('appendTeamForm de-duplicates on (team, asOf) and stays chronological', () => {
  const store = {};
  appendTeamForm(store, { team: 'Liverpool', asOf: '2026-02-01T00:00:00Z', formScore: 3 });
  appendTeamForm(store, { team: 'Liverpool', asOf: '2026-01-01T00:00:00Z', formScore: 6 });
  appendTeamForm(store, { team: 'Liverpool', asOf: '2026-02-01T00:00:00Z', formScore: 9 }); // dup asOf -> overwrites
  assert.equal(store.Liverpool.length, 2, 'de-duplicated by asOf');
  assert.ok(Date.parse(store.Liverpool[0].asOf) < Date.parse(store.Liverpool[1].asOf), 'sorted ascending');
  assert.equal(store.Liverpool[1].formScore, 9, 'dup overwrote');
});

test('buildTeamFormStoreFromDb derives records from settled scores', () => {
  const db = {
    version: 1,
    events: {
      E1: { eventId: 'E1', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-01T00:00:00Z', finalScore: '2:1', outcomes: {} },
    },
  };
  const store = buildTeamFormStoreFromDb(db);
  assert.ok(store.A && store.B, 'both teams recorded');
  assert.equal(store.A[0].avgGoalsFor, 2);
  assert.equal(store.A[0].avgGoalsAgainst, 1);
  assert.equal(store.A[0].formScore, 3, 'home win => 3');
  assert.equal(store.B[0].formScore, 0, 'away loss => 0');
});
