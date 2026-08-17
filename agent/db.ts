import fs from 'node:fs';
import path from 'node:path';
import { evaluateOutcome, parseScore } from '../lib/common.mjs';

export { evaluateOutcome, parseScore };

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

type Settlement = 'WON' | 'LOST' | 'VOID' | null;

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

// Aggregate historical performance of every (market, outcome) at every odds
// value seen in the DB, mirroring analyze-odds.mjs aggregateDb().
export function historicalStats(db: Db): HistoricalStats[] {
  const stats = new Map<string, HistoricalStats>();
  for (const ev of Object.values(db.events ?? {})) {
    const score = ev.finalScore ? parseScore(ev.finalScore) : null;
    const byMarket = new Map<string, string[]>();
    for (const out of Object.values(ev.outcomes ?? {})) {
      if (!byMarket.has(out.marketId)) byMarket.set(out.marketId, []);
      byMarket.get(out.marketId)!.push(out.name);
    }
    const evaluated = new Map<string, Settlement>();
    if (score) {
      for (const out of Object.values(ev.outcomes ?? {})) {
        const r = evaluateOutcome(out.marketId, out.name, score, byMarket.get(out.marketId));
        if (r) evaluated.set(`${out.marketId}|${out.name}`, r);
      }
    }
    const seenPrices = new Set<string>();
    for (const out of Object.values(ev.outcomes ?? {})) {
      const result = evaluated.get(`${out.marketId}|${out.name}`);
      for (const play of out.plays ?? []) {
        const skey = `${out.marketId}|${out.name}|${play.odds}`;
        if (seenPrices.has(skey)) continue;
        seenPrices.add(skey);
        let s = stats.get(skey);
        if (!s) {
          s = { marketId: out.marketId, name: out.name, odds: play.odds, plays: 0, won: 0, lost: 0, void: 0, settled: 0, winRate: null, matchedEvents: 0 };
          stats.set(skey, s);
        }
        s.plays++;
        if (result === 'WON') { s.won++; s.settled++; s.matchedEvents++; }
        else if (result === 'LOST') { s.lost++; s.settled++; s.matchedEvents++; }
        else if (result === 'VOID') { s.void++; s.settled++; s.matchedEvents++; }
      }
    }
  }
  return [...stats.values()].map((s) => ({ ...s, winRate: s.settled ? s.won / s.settled : null }));
}

// For a given (marketId, outcome) at a given current odds, return the
// historical record aggregated over plays seen at a similar odds band
// (current * [0.75, 1.30]). This matches "how often did this outcome win at
// ~this price" instead of the outcome's base rate.
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