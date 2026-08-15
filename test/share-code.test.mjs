import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection, createShareCode, loadShareCode, shareUrl, ticketSummary, findEventSelections } from '../share-code.mjs';

test('parseSelection parses eventId,marketId,outcomeId', () => {
  assert.deepEqual(parseSelection('sr:match:1,1,2'), { eventId: 'sr:match:1', marketId: '1', outcomeId: '2' });
});

test('parseSelection handles an optional specifier', () => {
  assert.deepEqual(parseSelection('sr:match:1,18,7,0.5'), {
    eventId: 'sr:match:1',
    marketId: '18',
    outcomeId: '7',
    specifier: '0.5',
  });
});

test('parseSelection rejects malformed specs', () => {
  assert.throws(() => parseSelection(''), /Invalid selection/);
  assert.throws(() => parseSelection('a,b'), /Invalid selection/);
  assert.throws(() => parseSelection(',,1'), /all of eventId, marketId, outcomeId/);
});

test('createShareCode posts selections and returns data.shareCode', async () => {
  const { code } = await createShareCode(
    [{ eventId: 'sr:match:1', marketId: '1', outcomeId: '2' }],
    { fetchImpl: async () => ({ bizCode: 10000, data: { shareCode: 'ABCDEF' } }) }
  );
  assert.equal(code, 'ABCDEF');
});

test('createShareCode throws on API errors and missing code', async () => {
  await assert.rejects(
    () => createShareCode([], { fetchImpl: async () => ({ bizCode: 10001, message: 'boom' }) }),
    /boom/
  );
  await assert.rejects(
    () => createShareCode([], { fetchImpl: async () => ({ bizCode: 10000, data: {} }) }),
    /data\.shareCode/
  );
});

test('loadShareCode returns the ticket data', async () => {
  const data = await loadShareCode('ABCDEF', {
    fetchImpl: async () => ({ bizCode: 10000, data: { ticket: {} } }),
  });
  assert.deepEqual(data, { ticket: {} });
});

test('shareUrl builds the share URL', () => {
  assert.equal(shareUrl('DZVRRR'), 'https://www.sportybet.com/gh/?shareCode=DZVRRR');
});

test('ticketSummary renders selections, odds and deadline', () => {
  const summary = ticketSummary({
    ticket: { orderType: 2, selections: [{ eventId: 'sr:match:1', marketId: '1', outcomeId: '1' }] },
    outcomes: [
      {
        eventId: 'sr:match:1',
        homeTeamName: 'Hearts',
        awayTeamName: 'Benfica',
        markets: [{ id: '1', desc: '1X2', outcomes: [{ id: '1', desc: 'Home', odds: '2.10' }] }],
      },
    ],
    deadline: 1787596200000,
  });
  assert.match(summary, /Hearts vs Benfica \| 1X2 \| Home @ 2.10/);
  assert.match(summary, /Code valid until:/);
});

test('findEventSelections matches by team name and lists 1X2 outcome ids', async () => {
  const matches = await findEventSelections('hearts', {
    fetchEvents: async () => [
      { eventId: 'sr:match:9', homeTeam: 'Hearts', awayTeam: 'Benfica', startTime: 1720000000000 },
      { eventId: 'sr:match:8', homeTeam: 'Celtic', awayTeam: 'Rangers', startTime: 1720000000000 },
    ],
    fetchMarkets: async () => ({
      markets: [{ id: '1', outcomes: [{ id: '1', desc: 'Home' }, { id: '2', desc: 'Draw' }] }],
    }),
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0].eventId, 'sr:match:9');
  assert.deepEqual(matches[0].outcomes, [{ outcomeId: '1', desc: 'Home' }, { outcomeId: '2', desc: 'Draw' }]);
});