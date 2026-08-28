// Shared synthetic fixtures for engine tests. Not committed data — in-memory.
import { randomUUID } from 'node:crypto';

function plays(odds) {
  return [{ odds, lastSeen: '2026-08-27T00:00:00Z', scrapedAt: '2026-08-27T00:00:00Z' }];
}

// Build one event with 1X2 sides + optional O/U outcomes.
export function makeEvent(eventId, { sides, ou = null, startTime, isSimulated = false, finalScore = null, tournament = 'Test League' } = {}) {
  const outcomes = {};
  for (const [name, odds] of Object.entries(sides)) {
    outcomes[`1|${name}`] = { marketId: '1', name, plays: plays(odds) };
  }
  if (ou) {
    for (const [name, odds] of Object.entries(ou)) {
      outcomes[`18|${name}`] = { marketId: '18', name, plays: plays(odds) };
    }
  }
  return {
    eventId,
    homeTeam: `Home-${eventId}`,
    awayTeam: `Away-${eventId}`,
    tournament,
    startTime,
    isSimulated,
    finalScore,
    outcomes,
  };
}

// A DB with a mix of in-band / out-of-band / simulated / resolved events.
export function sampleDb() {
  const future = '2030-01-01T12:00:00Z';
  const past = '2000-01-01T12:00:00Z';
  const events = {
    E1: makeEvent('E1', { sides: { Home: 1.95, Draw: 3.4, Away: 4.0 }, ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 }, startTime: future }),
    E2: makeEvent('E2', { sides: { Home: 3.0, Draw: 3.2, Away: 2.1 }, ou: { 'Over 2.5': 2.0, 'Under 2.5': 1.85 }, startTime: future }),
    E3: makeEvent('E3', { sides: { Home: 4.0, Draw: 1.5, Away: 5.0 }, ou: { 'Over 2.5': 1.85, 'Under 2.5': 2.0 }, startTime: future }),
    E4: makeEvent('E4', { sides: { Home: 1.85, Draw: 3.3, Away: 4.2 }, ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 }, startTime: future, isSimulated: true }),
    E5: makeEvent('E5', { sides: { Home: 1.9, Draw: 3.1, Away: 4.0 }, ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 }, startTime: past, finalScore: '2-1' }),
  };
  return { events };
}

export function newId() {
  return randomUUID().slice(0, 8);
}
