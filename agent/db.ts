import fs from 'node:fs';
import path from 'node:path';
import { aggregateHistoricalStats, evaluateOutcome, parseScore } from '../lib/common.mjs';

export { evaluateOutcome, parseScore, aggregateHistoricalStats as historicalStats };

export interface DbEvent {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  finalScore: string | null;
  outcomes: Record<string, { marketId: string; name: string; plays: { odds: number }[] }>;
}

export interface Db {
  version: number;
  updatedAt: string;
  events: Record<string, DbEvent>;
}

export interface LatestMatch {
  eventId: string;
  gameId?: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  matchStatus: string;
  tournament: string;
  category?: string;
  markets?: Record<string, { marketId: string; name: string; outcomes: { name: string; odds: number; active: boolean; marketId?: string }[] }>;
}

export interface Latest {
  scrapedAt: string;
  source: string;
  matches: LatestMatch[];
}

export function loadDb(file = process.env.DB_FILE ?? path.join('data', 'odds-db.json')): Db {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function loadLatest(file = path.join('data', 'latest.json')): Latest {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export interface HistoricalStats {
  marketId: string;
  name: string;
  odds: number;
  plays: number;
  won: number;
  lost: number;
  void: number;
  settled: number;
  winRate: number | null;
  matchedEvents: number;
}

// For a given (marketId, outcome) at a given current odds, return the
// historical record aggregated over plays seen at a similar odds band
// (current * [0.75, 1.30]). This matches "how often did this outcome win at
// ~this price" instead of the outcome's base rate. `stats` comes from the
// shared historicalStats() (lib/common.mjs) so the JS analyzer and the agent
// see the same history.
export function outcomeHistory(
  stats: HistoricalStats[],
  marketId: string,
  outcome: string,
  currentOdds: number
) {
  const lo = currentOdds * 0.75;
  const hi = currentOdds * 1.3;
  const rows = stats.filter(
    (s) =>
      s.marketId === marketId &&
      s.name === outcome &&
      s.odds >= lo &&
      s.odds <= hi &&
      s.settled > 0
  );
  if (rows.length === 0) return { winRate: null, settled: 0, plays: 0, best: null, rows: [] };
  const won = rows.reduce((n, r) => n + r.won, 0);
  const settled = rows.reduce((n, r) => n + r.settled, 0);
  const plays = rows.reduce((n, r) => n + r.plays, 0);
  const best = rows.reduce((a, b) => (a.settled > b.settled ? a : b));
  return {
    winRate: settled >= 3 ? won / settled : null,
    settled,
    plays,
    best,
    rows,
  };
}