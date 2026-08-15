import test from 'node:test';
import assert from 'node:assert/strict';
import { scrapeSportyBet, oddsMarkdown } from '../scraper.js';

test('scrapeSportyBet builds the marketIds map from TARGET_MARKET_IDS_SET', async () => {
  const data = await scrapeSportyBet({
    fetchEvents: async () => [],
    fetchMarkets: async () => null,
  });
  assert.deepEqual(data.marketIds, { '1': true, '18': true, '41': true, '548': true, '551': true });
  assert.equal(data.matches.length, 0);
});

test('scrapeSportyBet drops events whose market fetch failed', async () => {
  const data = await scrapeSportyBet({
    fetchEvents: async () => [
      { eventId: 'ok', gameId: 1, homeTeam: 'Hearts', awayTeam: 'Benfica', startTime: null, matchStatus: null, tournamentName: 'T', categoryName: 'C' },
      { eventId: 'bad', gameId: 2, homeTeam: 'A', awayTeam: 'B', startTime: null, matchStatus: null, tournamentName: 'T', categoryName: 'C' },
    ],
    fetchMarkets: async (eventId) => {
      if (eventId === 'bad') throw new Error('market endpoint down');
      return { '1X2 / O/U': { marketId: '1+18', outcomes: [{ name: 'Home', odds: 1.42, active: true }] } };
    },
  });
  assert.equal(data.matches.length, 1);
  assert.equal(data.matches[0].eventId, 'ok');
});

test('oddsMarkdown renders active and suspended rows', () => {
  const md = oddsMarkdown([
    { name: 'Home', odds: 1.42, active: true },
    { name: 'Away', odds: 7.8, active: false },
  ]);
  assert.equal(md, '| Outcome | Odds |\n| --- | ---: |\n| Home | 1.42 |\n| Away | 7.8 (suspended) |');
});
