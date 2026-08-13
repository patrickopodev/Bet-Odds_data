import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateOutcome } from '../analyze-odds.mjs';

const homeWin = { home: 2, away: 1 };
const awayWin = { home: 1, away: 3 };
const draw = { home: 1, away: 1 };

test('1X2 (market 1) evaluates Home/Draw/Away', () => {
  assert.equal(evaluateOutcome('1', 'Home', homeWin), 'WON');
  assert.equal(evaluateOutcome('1', 'Home', awayWin), 'LOST');
  assert.equal(evaluateOutcome('1', 'Draw', draw), 'WON');
  assert.equal(evaluateOutcome('1', 'Draw', homeWin), 'LOST');
  assert.equal(evaluateOutcome('1', 'Away', awayWin), 'WON');
  assert.equal(evaluateOutcome('1', 'Away', homeWin), 'LOST');
});

test('1X2 rejects unknown outcome names', () => {
  assert.equal(evaluateOutcome('1', 'Over 2.5', homeWin), null);
});

test('Over/Under (market 18)', () => {
  assert.equal(evaluateOutcome('18', 'Over 2.5', { home: 2, away: 1 }), 'WON');
  assert.equal(evaluateOutcome('18', 'Under 2.5', { home: 2, away: 1 }), 'LOST');
  assert.equal(evaluateOutcome('18', 'Over 2', { home: 1, away: 1 }), 'VOID');
  assert.equal(evaluateOutcome('18', 'Under 2', { home: 1, away: 1 }), 'VOID');
});

test('Correct Score (market 41)', () => {
  assert.equal(evaluateOutcome('41', '2:1', homeWin), 'WON');
  assert.equal(evaluateOutcome('41', '1:2', homeWin), 'LOST');
  assert.equal(evaluateOutcome('41', '1:1', draw), 'WON');
});

test('Multiscores (market 551) exact combo', () => {
  assert.equal(evaluateOutcome('551', '1:0, 2:0 or 3:0', { home: 2, away: 0 }), 'WON');
  assert.equal(evaluateOutcome('551', '1:0, 2:0 or 3:0', { home: 2, away: 1 }), 'LOST');
});

test('Multiscores Draw', () => {
  assert.equal(evaluateOutcome('551', 'Draw', draw), 'WON');
  assert.equal(evaluateOutcome('551', 'Draw', homeWin), 'LOST');
});

test('Multiscores Other Homewin excludes listed combos', () => {
  const siblings = ['1:0, 2:0 or 3:0', '4:0, 5:0 or 6:0', 'Other Homewin', 'Other Awaywin', 'Draw'];
  assert.equal(evaluateOutcome('551', 'Other Homewin', { home: 7, away: 0 }, siblings), 'WON');
  assert.equal(evaluateOutcome('551', 'Other Homewin', { home: 2, away: 0 }, siblings), 'LOST');
  assert.equal(evaluateOutcome('551', 'Other Awaywin', { home: 0, away: 7 }, siblings), 'WON');
});

test('Multigoals (market 548) ranges and No goal', () => {
  assert.equal(evaluateOutcome('548', 'No goal', { home: 0, away: 0 }), 'WON');
  assert.equal(evaluateOutcome('548', 'No goal', { home: 1, away: 0 }), 'LOST');
  assert.equal(evaluateOutcome('548', '1-2', { home: 1, away: 1 }), 'WON');
  assert.equal(evaluateOutcome('548', '1-2', { home: 3, away: 1 }), 'LOST');
  assert.equal(evaluateOutcome('548', '7+', { home: 4, away: 3 }), 'WON');
  assert.equal(evaluateOutcome('548', '7+', { home: 2, away: 1 }), 'LOST');
});

test('Unknown market id returns null', () => {
  assert.equal(evaluateOutcome('999', 'Anything', homeWin), null);
});