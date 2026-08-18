import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { recordPlay, compactOutcome, ingestSnapshot, ingestPrematchLog } from '../build-db.mjs';

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

test('recordPlay keeps earliest seenAt and latest lastSeen regardless of ingest order', () => {
  const plays = [];
  recordPlay(plays, 2.2, true, '2026-08-06T12:30:00Z');
  recordPlay(plays, 2.2, true, '2026-08-06T12:00:00Z');
  recordPlay(plays, 2.2, true, '2026-08-06T13:00:00Z');
  assert.equal(plays.length, 1);
  assert.equal(plays[0].seenAt, '2026-08-06T12:00:00Z');
  assert.equal(plays[0].lastSeen, '2026-08-06T13:00:00Z');
});

test('ingestSnapshot stops recording plays once the match kicks off', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-db-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'snap.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      scrapedAt: '2026-08-06T12:30:00Z',
      matches: [
        {
          eventId: 'sr:match:1',
          homeTeam: 'A',
          awayTeam: 'B',
          startTime: '2026-08-06T12:00:00Z',
          markets: {
            '1X2 / O/U': {
              outcomes: [
                { name: 'Home', odds: 1.5, active: true, marketId: '1' },
                { name: 'Draw', odds: 4.0, active: true, marketId: '1' },
                { name: 'Away', odds: 6.0, active: true, marketId: '1' },
              ],
            },
          },
        },
      ],
    }),
  );
  const db = { events: {} };
  await ingestSnapshot(db, file);
  const ev = db.events['sr:match:1'];
  assert.ok(ev, 'event record is kept so the match can settle');
  assert.equal(Object.keys(ev.outcomes).length, 0, 'no plays recorded after kickoff');
});

test('ingestPrematchLog merges 5-min pre-match odds into the DB', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-db-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prematch-sr-match-1.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      eventId: 'sr:match:1',
      homeTeam: 'A',
      awayTeam: 'B',
      kickoff: new Date('2026-08-06T13:00:00Z').getTime(),
      changes: [
        {
          at: '2026-08-06T12:30:00Z',
          sections: {
            '1X2 / O/U': {
              marketId: '1+18',
              outcomes: [
                { name: 'Home', odds: 1.5, active: true, marketId: '1' },
                { name: 'Draw', odds: 4.0, active: true, marketId: '1' },
              ],
            },
          },
        },
        {
          at: '2026-08-06T12:35:00Z',
          sections: {
            '1X2 / O/U': {
              marketId: '1+18',
              outcomes: [
                { name: 'Home', odds: 1.4, active: true, marketId: '1' },
                { name: 'Draw', odds: 4.0, active: true, marketId: '1' },
              ],
            },
          },
        },
      ],
    }),
  );
  const db = { events: {} };
  await ingestPrematchLog(db, file);
  const ev = db.events['sr:match:1'];
  assert.equal(ev.homeTeam, 'A');
  assert.equal(ev.startTime, '2026-08-06T13:00:00.000Z');
  const home = ev.outcomes['1|Home'];
  assert.equal(home.plays.length, 2);
  assert.equal(home.plays[0].odds, 1.5);
  assert.equal(home.plays[0].seenAt, '2026-08-06T12:30:00Z');
  assert.equal(home.plays[1].odds, 1.4);
  assert.equal(home.plays[1].seenAt, '2026-08-06T12:35:00Z');
  assert.equal(home.plays[1].lastSeen, '2026-08-06T12:35:00Z');
});

test('ingestPrematchLog drops entries at/after kickoff', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'build-db-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'prematch-sr-match-2.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      eventId: 'sr:match:2',
      homeTeam: 'C',
      awayTeam: 'D',
      kickoff: new Date('2026-08-06T13:00:00Z').getTime(),
      changes: [
        {
          at: '2026-08-06T12:55:00Z',
          sections: {
            '1X2 / O/U': {
              marketId: '1+18',
              outcomes: [{ name: 'Home', odds: 1.5, active: true, marketId: '1' }],
            },
          },
        },
        {
          at: '2026-08-06T13:00:00Z',
          sections: {
            '1X2 / O/U': {
              marketId: '1+18',
              outcomes: [{ name: 'Home', odds: 1.1, active: true, marketId: '1' }],
            },
          },
        },
      ],
    }),
  );
  const db = { events: {} };
  await ingestPrematchLog(db, file);
  const ev = db.events['sr:match:2'];
  const home = ev.outcomes['1|Home'];
  assert.equal(home.plays.length, 1);
  assert.equal(home.plays[0].odds, 1.5);
});