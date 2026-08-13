import test from 'node:test';
import assert from 'node:assert/strict';
import { recordPlay, compactOutcome } from '../build-db.mjs';

test('recordPlay keeps one play per odds value', () => {
  const plays = [];
  recordPlay(plays, 1.11, true, '2026-08-06T12:00:00Z');
  recordPlay(plays, 1.11, true, '2026-08-06T12:30:00Z');
  recordPlay(plays, 1.11, false, '2026-08-06T13:00:00Z');
  recordPlay(plays, 1.1, true, '2026-08-06T13:30:00Z');
  assert.equal(plays.length, 2);
  assert.equal(plays[0].odds, 1.11);
  assert.equal(plays[0].seenAt, '2026-08-06T12:00:00Z');
  assert.equal(plays[0].lastSeen, '2026-08-06T13:00:00Z');
  assert.equal(plays[0].active, false);
  assert.equal(plays[1].odds, 1.1);
});

test('compactOutcome merges duplicate-odds plays from legacy snapshots', () => {
  const plays = [
    { odds: 1.1, active: true, scrapedAt: '2026-08-06T12:00:00Z' },
    { odds: 1.1, active: true, scrapedAt: '2026-08-06T12:30:00Z' },
    { odds: 1.1, active: true, scrapedAt: '2026-08-06T13:00:00Z' },
    { odds: 1.2, active: true, scrapedAt: '2026-08-06T13:30:00Z' },
  ];
  const out = compactOutcome(plays);
  assert.equal(out.length, 2);
  const first = out.find((p) => p.odds === 1.1);
  assert.equal(first.lastSeen, '2026-08-06T13:00:00Z');
});