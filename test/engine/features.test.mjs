import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterMeetingsByPair,
  extractH2HFeatures,
  extractCompetitionContext,
  competitionType,
} from '../../engine/features.mjs';

const MTG = (home, away, hs, as, date = '2026-05-01T00:00:00Z') => ({
  date,
  home,
  away,
  homeScore: hs,
  awayScore: as,
});

test('filterMeetingsByPair is order-independent', () => {
  const all = [MTG('Arsenal', 'Chelsea', 2, 1), MTG('Chelsea', 'Arsenal', 0, 3), MTG('Liverpool', 'Everton', 1, 1)];
  const pair = filterMeetingsByPair(all, 'Chelsea', 'Arsenal');
  assert.equal(pair.length, 2);
  assert.ok(pair.every((m) => (m.home === 'Arsenal' && m.away === 'Chelsea') || (m.home === 'Chelsea' && m.away === 'Arsenal')));
});

test('extractH2HFeatures summarises from teamA perspective', () => {
  const meetings = [
    MTG('Arsenal', 'Chelsea', 2, 1, '2026-05-01T00:00:00Z'),
    MTG('Chelsea', 'Arsenal', 1, 1, '2026-04-01T00:00:00Z'),
    MTG('Arsenal', 'Chelsea', 3, 0, '2026-03-01T00:00:00Z'),
  ];
  const f = extractH2HFeatures(meetings, 'Arsenal', 'Chelsea', { asOf: '2026-06-01T00:00:00Z' });
  assert.equal(f.totalMeetings, 3);
  assert.equal(f.homeWins, 2); // Arsenal won twice as "home" of the pair
  assert.equal(f.draws, 1);
  assert.equal(f.awayWins, 0);
  assert.equal(f.bttsRate, 2 / 3); // two of three had both teams score
  assert.equal(f.over25Rate, 2 / 3); // 3-0 and 2-1 are >2.5; 1-1 is not
  assert.equal(f.lastResult.homeScore, 2);
  assert.equal(f.recencyDays != null, true);
});

test('extractH2HFeatures returns empty struct when no meetings', () => {
  const f = extractH2HFeatures([], 'Arsenal', 'Chelsea');
  assert.equal(f.totalMeetings, 0);
  assert.equal(f.lastResult, null);
  assert.equal(f.recent.count, 0);
});

test('extractH2HFeatures sameYearOnly filters by asOf year', () => {
  const meetings = [
    MTG('Arsenal', 'Chelsea', 2, 1, '2026-05-01T00:00:00Z'),
    MTG('Arsenal', 'Chelsea', 1, 0, '2025-05-01T00:00:00Z'),
  ];
  const sameYear = extractH2HFeatures(meetings, 'Arsenal', 'Chelsea', { asOf: '2026-06-01T00:00:00Z', sameYearOnly: true });
  assert.equal(sameYear.totalMeetings, 1);
  const allYears = extractH2HFeatures(meetings, 'Arsenal', 'Chelsea', { asOf: '2026-06-01T00:00:00Z' });
  assert.equal(allYears.totalMeetings, 2);
});

test('competitionType / extractCompetitionContext', () => {
  assert.equal(competitionType('FA Cup'), 'cup');
  assert.equal(competitionType('Premier League'), 'league');
  const c = extractCompetitionContext({ tournament: 'Champions League', position: 2, tier: 1 });
  assert.equal(c.type, 'cup');
  assert.equal(c.position, 2);
  assert.equal(c.tier, 1);
});
