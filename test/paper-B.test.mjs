import test from 'node:test';
import assert from 'node:assert/strict';
import { inSpec, summarize } from '../paper-B.mjs';

const ou = (name, odds) => ({ name, marketId: '18', plays: [{ odds, lastSeen: '2026-01-01T00:00:00Z' }] });
const ouNoPlays = (name) => ({ name, marketId: '18', plays: [] });

test('inSpec matches Over 2.5 inside [1.80, 2.20)', () => {
  assert.deepEqual(inSpec(ou('Over 2.5', 1.9)), { side: 'Over', odds: 1.9 });
});

test('inSpec matches Under 2.5 (side = either)', () => {
  assert.deepEqual(inSpec(ou('Under 2.5', 2.0)), { side: 'Under', odds: 2.0 });
});

test('inSpec rejects odds below lower bound', () => {
  assert.equal(inSpec(ou('Over 2.5', 1.79)), null);
});

test('inSpec rejects odds at upper bound (exclusive)', () => {
  assert.equal(inSpec(ou('Over 2.5', 2.2)), null);
});

test('inSpec rejects wrong line (3.5)', () => {
  assert.equal(inSpec(ou('Over 3.5', 1.9)), null);
});

test('inSpec rejects outcome with no plays', () => {
  assert.equal(inSpec(ouNoPlays('Over 2.5')), null);
});

test('summarize computes ROI / hit / edge correctly', () => {
  const picks = [
    { status: 'WON', odds: 2.0, pnl: 1.0 },
    { status: 'LOST', odds: 2.0, pnl: -1.0 },
  ];
  const s = summarize(picks);
  assert.equal(s.settled, 2);
  assert.equal(s.won, 1);
  assert.equal(s.lost, 1);
  assert.equal(s.resolved, 2);
  assert.ok(Math.abs(s.roiVal - 0) < 1e-9);
  assert.ok(Math.abs(s.hit - 0.5) < 1e-9);
  assert.ok(Math.abs(s.avgOdds - 2.0) < 1e-9);
  assert.ok(Math.abs(s.edge - 0.0) < 1e-9); // 0.5 observed - 1/2.0 implied
});

test('summarize ignores OPEN picks in rates', () => {
  const s = summarize([{ status: 'OPEN', odds: 1.9, pnl: null }]);
  assert.equal(s.resolved, 0);
  assert.equal(s.roiVal, null);
});
