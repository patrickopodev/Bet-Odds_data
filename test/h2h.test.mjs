import test from 'node:test';
import assert from 'node:assert/strict';
import { meetingFromEvent, loadH2H, saveH2H, buildH2HFromDb } from '../lib/h2h.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TMP_H2H = path.join(__dirname, '.tmp-h2h-test.json');

test('meetingFromEvent returns a structured meeting for a settled event', () => {
  const ev = {
    eventId: 'E1', homeTeam: 'A', awayTeam: 'B',
    startTime: '2026-01-01T00:00:00Z', finalScore: '2:1', tournament: 'League',
  };
  const m = meetingFromEvent(ev);
  assert.equal(m.date, ev.startTime);
  assert.equal(m.home, 'A');
  assert.equal(m.away, 'B');
  assert.equal(m.homeScore, 2);
  assert.equal(m.awayScore, 1);
  assert.equal(m.competition, 'League');
});

test('meetingFromEvent returns null for events without a final score', () => {
  const ev = { eventId: 'E1', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-01T00:00:00Z' };
  assert.equal(meetingFromEvent(ev), null);
});

test('meetingFromEvent returns null for invalid scores', () => {
  const ev = { eventId: 'E1', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-01T00:00:00Z', finalScore: 'x:y' };
  assert.equal(meetingFromEvent(ev), null);
});

test('loadH2H returns { meetings: [] } for a missing file', () => {
  const result = loadH2H('/nonexistent/path.json');
  assert.deepEqual(result, { meetings: [] });
});

test('loadH2H parses meetings from a valid file', () => {
  const data = { meetings: [{ date: '2026-01-01', home: 'A', away: 'B', homeScore: 1, awayScore: 0 }] };
  fs.writeFileSync(TMP_H2H, JSON.stringify(data));
  const result = loadH2H(TMP_H2H);
  assert.equal(result.meetings.length, 1);
  assert.equal(result.meetings[0].home, 'A');
  fs.rmSync(TMP_H2H);
});

test('saveH2H writes a valid JSON file', () => {
  const data = { meetings: [{ date: '2026-01-01', home: 'A', away: 'B', homeScore: 1, awayScore: 0 }] };
  saveH2H(data, TMP_H2H);
  const raw = JSON.parse(fs.readFileSync(TMP_H2H, 'utf8'));
  assert.equal(raw.meetings.length, 1);
  assert.equal(raw.meetings[0].home, 'A');
  fs.rmSync(TMP_H2H);
});

test('buildH2HFromDb derives meetings from settled events', () => {
  const db = {
    version: 1,
    events: {
      E1: { eventId: 'E1', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-01T00:00:00Z', finalScore: '2:1', tournament: 'League' },
      E2: { eventId: 'E2', homeTeam: 'C', awayTeam: 'D', startTime: '2026-01-02T00:00:00Z', finalScore: '0:0', tournament: 'Cup' },
      E3: { eventId: 'E3', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-03T00:00:00Z', finalScore: null, tournament: 'League' },
    },
  };
  const result = buildH2HFromDb(db);
  assert.equal(result.meetings.length, 2);
  assert.equal(result.meetings[0].home, 'A');
  assert.equal(result.meetings[1].home, 'C');
});

test('buildH2HFromDb de-duplicates on (date, home, away)', () => {
  const db = {
    version: 1,
    events: {
      E1: { eventId: 'E1', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-01T00:00:00Z', finalScore: '2:1', tournament: 'League' },
      E2: { eventId: 'E2', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-01T00:00:00Z', finalScore: '3:0', tournament: 'League' },
    },
  };
  const result = buildH2HFromDb(db);
  assert.equal(result.meetings.length, 1, 'duplicate deduplicated');
});

test('buildH2HFromDb is chronological (oldest first)', () => {
  const db = {
    version: 1,
    events: {
      E1: { eventId: 'E1', homeTeam: 'A', awayTeam: 'B', startTime: '2026-01-02T00:00:00Z', finalScore: '1:0', tournament: 'L' },
      E2: { eventId: 'E2', homeTeam: 'C', awayTeam: 'D', startTime: '2026-01-01T00:00:00Z', finalScore: '2:1', tournament: 'L' },
    },
  };
  const result = buildH2HFromDb(db);
  assert.equal(result.meetings[0].date, '2026-01-01T00:00:00Z');
  assert.equal(result.meetings[1].date, '2026-01-02T00:00:00Z');
});
