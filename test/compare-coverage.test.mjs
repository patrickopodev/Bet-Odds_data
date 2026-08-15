import test from 'node:test';
import assert from 'node:assert/strict';
import { covers } from '../compare-coverage.mjs';

test('covers matches same team pair within kickoff tolerance', () => {
  const sb = { homeTeam: 'FC Barcelona', awayTeam: 'Real Madrid CF', kickoff: '2026-08-14T19:00:00Z' };
  const fs = { homeTeam: 'Barcelona', awayTeam: 'Real Madrid', kickoff: '2026-08-14T19:15:00Z' };
  assert.equal(covers(sb, fs), true);
});

test('covers rejects swapped sides', () => {
  const sb = { homeTeam: 'Barcelona', awayTeam: 'Real Madrid', kickoff: '2026-08-14T19:00:00Z' };
  const fs = { homeTeam: 'Real Madrid', awayTeam: 'Barcelona', kickoff: '2026-08-14T19:00:00Z' };
  assert.equal(covers(sb, fs), false);
});

test('covers rejects kickoff outside tolerance', () => {
  const sb = { homeTeam: 'Barcelona', awayTeam: 'Real Madrid', kickoff: '2026-08-14T19:00:00Z' };
  const fs = { homeTeam: 'Barcelona', awayTeam: 'Real Madrid', kickoff: '2026-08-15T02:00:00Z' };
  assert.equal(covers(sb, fs, 6 * 60 * 60 * 1000), false);
});