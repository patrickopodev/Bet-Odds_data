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
  outcomes: Record<string, { marketId: string; name: string; plays: { odds: number; seenAt?: string }[] }>;
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

// Movement of one outcome's price across today's own snapshots. The scraper
// records every distinct price with seenAt every 30 minutes, so the DB holds a
// per-outcome odds timeline for each event. drift = last - first: negative
// means the price shortened (steamer — money arriving on this selection),
// positive means it drifted (money against it). Returns null below
// MIN_DRIFT_PLAYS distinct prices — movement over 1-2 snapshots is noise.
export const MIN_DRIFT_PLAYS = 3;

export function oddsDrift(
  ev: DbEvent | undefined,
  marketId: string,
  outcome: string
): { drift: number; first: number; last: number; samples: number } | null {
  const plays = ev?.outcomes?.[`${marketId}|${outcome}`]?.plays ?? [];
  if (plays.length < MIN_DRIFT_PLAYS) return null;
  const sorted = [...plays].sort((a, b) => {
    const ta = a.seenAt ? Date.parse(a.seenAt) : 0;
    const tb = b.seenAt ? Date.parse(b.seenAt) : 0;
    return ta - tb;
  });
  const first = sorted[0].odds;
  const last = sorted[sorted.length - 1].odds;
  return { drift: Number((last - first).toFixed(3)), first, last, samples: sorted.length };
}