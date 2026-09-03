// Shared synthetic fixtures for engine tests. Not committed data — in-memory.
import { randomUUID } from 'node:crypto';

function plays(odds, { active = true } = {}) {
  return [{ odds, lastSeen: '2026-08-27T00:00:00Z', scrapedAt: '2026-08-27T00:00:00Z', active }];
}

function csPlays(scorelineOdds) {
  return scorelineOdds.map((o, i) => ({ odds: o, lastSeen: '2026-08-27T00:00:00Z', scrapedAt: '2026-08-27T00:00:00Z', active: i === 0 }));
}

// Build one event with optional 1X2 sides + optional O/U outcomes + optional Correct Score outcomes.
export function makeEvent(eventId, { sides = {}, ou = null, cs = null, mg = null, mscore = null, startTime, isSimulated = false, finalScore = null, tournament = 'Test League' } = {}) {
  const outcomes = {};
  for (const [name, odds] of Object.entries(sides)) {
    outcomes[`1|${name}`] = { marketId: '1', name, plays: plays(odds) };
  }
  if (ou) {
    for (const [name, odds] of Object.entries(ou)) {
      outcomes[`18|${name}`] = { marketId: '18', name, plays: plays(odds) };
    }
  }
  if (cs) {
    for (const [name, odds] of Object.entries(cs)) {
      outcomes[`41|${name}`] = { marketId: '41', name, plays: csPlays(odds) };
    }
  }
  if (mg) {
    for (const [name, odds] of Object.entries(mg)) {
      outcomes[`548|${name}`] = { marketId: '548', name, plays: plays(odds) };
    }
  }
  if (mscore) {
    for (const [name, odds] of Object.entries(mscore)) {
      outcomes[`551|${name}`] = { marketId: '551', name, plays: plays(odds) };
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
    E1: makeEvent('E1', { sides: { Home: 1.95, Draw: 3.4, Away: 4.0 }, ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 }, cs: { '0:0': [15,16], '1:0': [10,11] }, startTime: future }),
    E2: makeEvent('E2', { sides: { Home: 3.0, Draw: 3.2, Away: 2.1 }, ou: { 'Over 2.5': 2.0, 'Under 2.5': 1.85 }, cs: { '0:0': [5,6], '2:1': [12,13] }, startTime: future }),
    E3: makeEvent('E3', { sides: { Home: 4.0, Draw: 1.5, Away: 5.0 }, ou: { 'Over 2.5': 1.85, 'Under 2.5': 2.0 }, cs: { '1:1': [7,8] }, startTime: future }),
    E4: makeEvent('E4', { sides: { Home: 1.85, Draw: 3.3, Away: 4.2 }, ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 }, startTime: future, isSimulated: true }),
    E5: makeEvent('E5', { sides: { Home: 1.9, Draw: 3.1, Away: 4.0 }, ou: { 'Over 2.5': 1.9, 'Under 2.5': 1.9 }, startTime: past, finalScore: '2-1' }),
  };
  return { events };
}

export function newId() {
  return randomUUID().slice(0, 8);
}
