import fs from 'node:fs';
import path from 'node:path';

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

export function parseScore(s: string): { home: number; away: number } | null {
  const m = s.split(':').map(Number);
  if (m.length !== 2 || Number.isNaN(m[0]) || Number.isNaN(m[1])) return null;
  return { home: m[0], away: m[1] };
}

export function totalGoals(h: number, a: number): number {
  return h + a;
}

// Reimplemented outcome evaluators so the TS agent can score historical bets
// against the same rules the JS analyzer uses (analyze-odds.mjs).
export type Result = 'WON' | 'LOST' | 'VOID' | null;

export function evaluateOutcome(marketId: string, name: string, score: { home: number; away: number }, siblingNames: string[] = []): Result {
  const h = score.home;
  const a = score.away;
  const total = h + a;

  if (marketId === '1') {
    if (name === 'Home') return h > a ? 'WON' : 'LOST';
    if (name === 'Draw') return h === a ? 'WON' : 'LOST';
    if (name === 'Away') return a > h ? 'WON' : 'LOST';
    return null;
  }
  if (marketId === '18') {
    const m = name.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
    if (!m) return null;
    const line = parseFloat(m[2]);
    if (Number.isInteger(line) && total === line) return 'VOID';
    return m[1] === 'Over' ? (total > line ? 'WON' : 'LOST') : total < line ? 'WON' : 'LOST';
  }
  if (marketId === '41') {
    const m = name.match(/^(\d+):(\d+)$/);
    if (!m) return null;
    return h === Number(m[1]) && a === Number(m[2]) ? 'WON' : 'LOST';
  }
  if (marketId === '548') {
    if (name === 'No goal') return total === 0 ? 'WON' : 'LOST';
    const range = name.match(/^(\d+)-(\d+)$/);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      return total >= lo && total <= hi ? 'WON' : 'LOST';
    }
    const plus = name.match(/^(\d+)\+$/);
    if (plus) return total >= Number(plus[1]) ? 'WON' : 'LOST';
    return null;
  }
  if (marketId === '551') {
    if (name === 'Draw') return h === a ? 'WON' : 'LOST';
    const extractScores = (s: string): string[] =>
      s
        .split(/[,|]|\s+or\s+/i)
        .map((x) => x.trim())
        .filter((x) => /^\d+:\d+$/.test(x));
    const final = `${h}:${a}`;
    const isHome = h > a;
    const isAway = a > h;
    const listed = new Set<string>();
    for (const sib of siblingNames) {
      if (sib === 'Draw' || sib === 'Other Homewin' || sib === 'Other Awaywin') continue;
      for (const sc of extractScores(sib)) listed.add(sc);
    }
    if (name === 'Other Homewin') return isHome && !listed.has(final) ? 'WON' : 'LOST';
    if (name === 'Other Awaywin') return isAway && !listed.has(final) ? 'WON' : 'LOST';
    return extractScores(name).includes(final) ? 'WON' : 'LOST';
  }
  return null;
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
    const evaluated = new Map<string, Result>();
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