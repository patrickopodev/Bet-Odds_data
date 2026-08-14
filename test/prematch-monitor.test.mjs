import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinWindow } from '../prematch-monitor.mjs';

const now = new Date('2026-08-14T12:00:00Z').getTime();

test('match with no startTime is never in the window', () => {
  assert.equal(isWithinWindow({ startTime: null }, now, 30), false);
});

test('match inside the final 30 min is in the window', () => {
  const ev = { startTime: new Date('2026-08-14T12:20:00Z').toISOString() };
  assert.equal(isWithinWindow(ev, now, 30), true);
});

test('match already kicked off is excluded', () => {
  const ev = { startTime: new Date('2026-08-14T11:59:00Z').toISOString() };
  assert.equal(isWithinWindow(ev, now, 30), false);
});

test('match exactly at the window edge is included', () => {
  const ev = { startTime: new Date('2026-08-14T12:30:00Z').toISOString() };
  assert.equal(isWithinWindow(ev, now, 30), true);
});

test('match beyond the window is excluded', () => {
  const ev = { startTime: new Date('2026-08-14T12:31:00Z').toISOString() };
  assert.equal(isWithinWindow(ev, now, 30), false);
});

test('custom window width is honored', () => {
  const ev = { startTime: new Date('2026-08-14T12:40:00Z').toISOString() };
  assert.equal(isWithinWindow(ev, now, 30), false);
  assert.equal(isWithinWindow(ev, now, 45), true);
});
