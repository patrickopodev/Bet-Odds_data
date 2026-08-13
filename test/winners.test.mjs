import test from 'node:test';
import assert from 'node:assert/strict';
import { winningOutcomes, groupBySection } from '../winners.mjs';

function settledEvent(finalScore, outcomes) {
  return {
    eventId: 'm1',
    homeTeam: 'Home FC',
    awayTeam: 'Away FC',
    finalScore,
    outcomes: Object.fromEntries(
      outcomes.map(([marketId, name, odds]) => [
        `${marketId}|${name}`,
        { marketId, name, plays: [{ odds }] },
      ])
    ),
  };
}

test('winningOutcomes returns only WON outcomes grouped with sections', () => {
  const ev = settledEvent('2:1', [
    ['1', 'Home', 1.5],
    ['1', 'Draw', 4.0],
    ['18', 'Over 2.5', 1.9],
    ['41', '2:1', 7.2],
    ['548', '2-3', 1.6],
    ['551', '2:1, 3:1 or 4:1', 3.5],
  ]);
  const won = winningOutcomes(ev);
  const names = won.map((w) => w.name).sort();
  assert.deepEqual(names, ['2-3', '2:1', '2:1, 3:1 or 4:1', 'Home', 'Over 2.5']);
  for (const w of won) {
    assert.equal(typeof w.section, 'string');
    assert.equal(typeof w.best, 'number');
  }
});

test('winningOutcomes returns [] for unsettled matches', () => {
  const ev = settledEvent(null, [['1', 'Home', 1.5]]);
  assert.deepEqual(winningOutcomes(ev), []);
});

test('winningOutcomes picks best (lowest) odds seen', () => {
  const ev = settledEvent('1:0', [['1', 'Home', 1.2]]);
  ev.outcomes['1|Home'].plays = [
    { odds: 1.4 },
    { odds: 1.2 },
    { odds: 1.3 },
  ];
  const won = winningOutcomes(ev);
  assert.equal(won[0].best, 1.2);
  assert.deepEqual(won[0].odds, [1.4, 1.2, 1.3]);
});

test('groupBySection orders sections canonically', () => {
  const won = winningOutcomes(
    settledEvent('2:1', [
      ['548', '2-3', 1.6],
      ['41', '2:1', 7.2],
      ['1', 'Home', 1.5],
      ['551', '2:1, 3:1 or 4:1', 3.5],
    ])
  );
  const groups = groupBySection(won).map(([s]) => s);
  assert.deepEqual(groups, ['1X2 / O/U', 'Correct Score [0:0]', 'Multiscores', 'Multigoals']);
});