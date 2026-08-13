import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE, loadDb, MARKET_ORDER } from './lib/common.mjs';

// ---------------------------------------------------------------------------
// Repeated-odds analysis (current snapshot, data/latest.json)
// ---------------------------------------------------------------------------

export async function load() {
  const raw = await fs.readFile(path.join(DATA_DIR, 'latest.json'), 'utf8');
  return JSON.parse(raw);
}

// Group outcomes by name within a market; return counts of how many matches
// share the exact same odds for a given outcome name.
export function findRepeatedOdds(data, marketFilter) {
  const groups = new Map(); // `${marketKey}|${name}|${odds}` -> count
  const sample = new Map(); // key -> { homeTeam, awayTeam, tournament, odds }
  for (const m of data.matches ?? []) {
    for (const [key, market] of Object.entries(m.markets ?? {})) {
      if (!market || (marketFilter && key !== marketFilter)) continue;
      for (const o of market.outcomes ?? []) {
        const k = `${key}|${o.name}|${o.odds}`;
        groups.set(k, (groups.get(k) ?? 0) + 1);
        if (!sample.has(k)) {
          sample.set(k, { homeTeam: m.homeTeam, awayTeam: m.awayTeam, tournament: m.tournament, odds: o.odds });
        }
      }
    }
  }
  return [...groups.entries()]
    .map(([k, count]) => {
      const [market, name, odds] = k.split('|');
      return { market, name, odds: Number(odds), count, sample: sample.get(k) };
    })
    .filter((r) => r.count > 1)
    .sort((a, b) => b.count - a.count || a.market.localeCompare(b.market));
}

// Exact lookup: find every match offering a specific outcome at a specific odds.
export function findExactOdds(data, market, outcome, odds) {
  const hits = [];
  for (const m of data.matches ?? []) {
    const marketObj = m.markets?.[market];
    if (!marketObj) continue;
    for (const o of marketObj.outcomes ?? []) {
      if (o.name === outcome && Number(o.odds) === Number(odds)) {
        hits.push({
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          tournament: m.tournament,
          odds: o.odds,
          active: o.active,
        });
      }
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Outcome evaluators: given a final score (home:away), decide WON / LOST / VOID.
// ---------------------------------------------------------------------------

function totalGoals(score) {
  return score.home + score.away;
}

// O/U market (id 18): "Over 2.5" / "Under 2.5". Whole lines (e.g. "Over 2")
// push when the total equals the line -> VOID.
function evaluateOverUnder(name, score) {
  const m = name.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const [, dir, lineStr] = m;
  const line = parseFloat(lineStr);
  const total = totalGoals(score);
  if (Number.isInteger(line) && total === line) return 'VOID';
  if (dir === 'Over') return total > line ? 'WON' : 'LOST';
  return total < line ? 'WON' : 'LOST';
}

// Correct Score market (id 41): "2:1" matches the exact final score.
function evaluateCorrectScore(name, score) {
  const m = name.match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return score.home === Number(m[1]) && score.away === Number(m[2]) ? 'WON' : 'LOST';
}

// Extract concrete "H:A" score combos from a market/outcome name. Names are
// like "1:0, 2:0 or 3:0" or "2:1, 3:1 or 4:1" (separators: comma, pipe, "or").
function extractScores(name) {
  return name
    .split(/[,|]|\s+or\s+/i)
    .map((s) => s.trim())
    .filter((s) => /^\d+:\d+$/.test(s))
    .map((s) => `${s.split(':')[0]}:${s.split(':')[1]}`);
}

// Multiscores market (id 551):
//   - "1:0, 2:0 or 3:0"  -> the final score must be one of the listed scores
//   - "Other Homewin"     -> a home win NOT covered by any listed combo
//   - "Other Awaywin"     -> an away win NOT covered by any listed combo
//   - "Draw"              -> any draw
// siblingNames = all outcome names in the same market, so "Other Homewin" can
// tell whether the final score already falls under a listed home-win combo.
function evaluateMultiscores(name, score, siblingNames = []) {
  if (name === 'Draw') return score.home === score.away ? 'WON' : 'LOST';

  const finalScore = `${score.home}:${score.away}`;
  const isHomeWin = score.home > score.away;
  const isAwayWin = score.away > score.home;

  // All concrete score combos listed in this market (e.g. "1:0, 2:0 or 3:0").
  const listed = [];
  for (const sib of siblingNames) {
    if (sib === 'Draw' || sib === 'Other Homewin' || sib === 'Other Awaywin') continue;
    listed.push(...extractScores(sib));
  }

  if (name === 'Other Homewin') return isHomeWin && !listed.includes(finalScore) ? 'WON' : 'LOST';
  if (name === 'Other Awaywin') return isAwayWin && !listed.includes(finalScore) ? 'WON' : 'LOST';

  const scores = extractScores(name);
  return scores.includes(finalScore) ? 'WON' : 'LOST';
}

// Multigoals market (id 548): "1-2" (range of total goals), "7+" (seven or more),
// "No goal" (zero total goals).
function evaluateMultigoals(name, score) {
  const total = totalGoals(score);
  if (name === 'No goal') return total === 0 ? 'WON' : 'LOST';
  const range = name.match(/^(\d+)-(\d+)$/);
  if (range) {
    const [lo, hi] = [Number(range[1]), Number(range[2])];
    return total >= lo && total <= hi ? 'WON' : 'LOST';
  }
  const plus = name.match(/^(\d+)\+$/);
  if (plus) return total >= Number(plus[1]) ? 'WON' : 'LOST';
  return null;
}

export const MARKET_EVALUATORS = {
  '18': evaluateOverUnder,
  '41': evaluateCorrectScore,
  '551': evaluateMultiscores,
  '548': evaluateMultigoals,
};

export function evaluateOutcome(marketId, name, score, siblingNames) {
  const fn = MARKET_EVALUATORS[String(marketId)];
  if (!fn) return null;
  return fn(name, score, siblingNames);
}

// ---------------------------------------------------------------------------
// Performance database (data/odds-db.json) helpers
// ---------------------------------------------------------------------------

function parseFinalScore(s) {
  const [h, a] = s.split(':').map(Number);
  return { home: h, away: a };
}

// Aggregate historical plays for one (market, outcome) into per-odds stats.
// Every unique odds value recorded for an outcome counts as one "play" of
// that outcome at that price; settled results attach a WON/LOST/VOID to it.
export function aggregateDb(db) {
  const stats = new Map(); // `${marketId}|${outcomeName}|${odds}` -> aggregate
  for (const ev of Object.values(db.events ?? {})) {
    const score = ev.finalScore ? parseFinalScore(ev.finalScore) : null;
    const evaluated = new Map(); // `${marketId}|${name}` -> WON/LOST/VOID per match
    // Group sibling outcome names per market so combo-aware evaluators (e.g.
    // Multiscores "Other Homewin") can see whether a final score is covered.
    const byMarket = new Map();
    for (const out of Object.values(ev.outcomes ?? {})) {
      if (!byMarket.has(out.marketId)) byMarket.set(out.marketId, []);
      byMarket.get(out.marketId).push(out.name);
    }
    for (const out of Object.values(ev.outcomes ?? {})) {
      const id = out.marketId;
      if (score) {
        const e = evaluateOutcome(id, out.name, score, byMarket.get(id));
        if (e) evaluated.set(`${id}|${out.name}`, e);
      }
    }
    // Count each distinct odds value offered for an outcome once per match,
    // no matter how many snapshots saw that price. This keeps a match that was
    // scraped 20 times from being counted 20 times.
    const seenPrices = new Set(); // `${marketId}|${name}|${odds}`
    for (const out of Object.values(ev.outcomes ?? {})) {
      const id = out.marketId;
      const result = evaluated.get(`${id}|${out.name}`);
      for (const play of out.plays ?? []) {
        const skey = `${id}|${out.name}|${play.odds}`;
        if (seenPrices.has(skey)) continue;
        seenPrices.add(skey);
        const s = stats.get(skey) ?? {
          marketId: id,
          name: out.name,
          odds: play.odds,
          plays: 0,
          won: 0,
          lost: 0,
          void: 0,
          settled: 0,
          matches: new Set(),
        };
        s.plays++;
        if (result === 'WON') { s.won++; s.settled++; s.matches.add(ev.eventId); }
        else if (result === 'LOST') { s.lost++; s.settled++; s.matches.add(ev.eventId); }
        else if (result === 'VOID') { s.void++; s.settled++; s.matches.add(ev.eventId); }
        stats.set(skey, s);
      }
    }
  }
  return [...stats.values()].map((s) => ({
    marketId: s.marketId,
    name: s.name,
    odds: s.odds,
    plays: s.plays,
    won: s.won,
    lost: s.lost,
    void: s.void,
    settled: s.settled,
    winRate: s.settled ? (s.won / s.settled).toFixed(3) : null,
    matchedEvents: s.matches.size,
  }));
}

function oddsReport(list) {
  const lines = ['# SportyBet Odds Performance', '', `_Generated ${new Date().toISOString()} UTC_`, ''];
  const settled = list.filter((s) => s.settled > 0);
  const pending = list.filter((s) => s.settled === 0);

  if (!settled.length) {
    lines.push('No settled outcomes yet. The resolver settles matches once they finish (FT), so check back after matches complete.', '');
    lines.push(`Unsettled outcome/odds combinations tracked: ${pending.length}`, '');
    return lines.join('\n');
  }

  const good = settled.filter((s) => s.settled >= 3 && s.won / s.settled === 1);
  const bad = settled.filter((s) => s.settled >= 3 && s.lost / s.settled === 1);
  const mixed = settled.filter((s) => s.settled >= 3 && s.won / s.settled < 1 && s.lost / s.settled < 1);

  lines.push(`Total outcome/odds combinations: ${list.length}`, '');
  lines.push(`**Good odds** (settled >=3, always won): ${good.length}`, '');
  lines.push(`**Bad odds** (settled >=3, always lost): ${bad.length}`, '');
  lines.push(`**Mixed** (settled >=3, some won some lost): ${mixed.length}`, '');
  lines.push('');

  const marketNames = { '18': '1X2 / O/U', '41': 'Correct Score [0:0]', '551': 'Multiscores', '548': 'Multigoals' };

  if (good.length) {
    lines.push('## Good Odds (historically play)', '');
    for (const s of good.sort((a, b) => b.settled - a.settled).slice(0, 50)) {
      lines.push(
        `- **${marketNames[s.marketId] ?? s.marketId} | ${s.name} @ ${s.odds}**: won ${s.won}/${s.settled} times (100%) across ${s.matchedEvents} match(es)`
      );
    }
    lines.push('');
  }

  if (bad.length) {
    lines.push('## Bad Odds (historically lose)', '');
    for (const s of bad.sort((a, b) => b.settled - a.settled).slice(0, 50)) {
      lines.push(
        `- **${marketNames[s.marketId] ?? s.marketId} | ${s.name} @ ${s.odds}**: lost ${s.lost}/${s.settled} times (0% win) across ${s.matchedEvents} match(es)`
      );
    }
    lines.push('');
  }

  if (mixed.length) {
    lines.push('## Mixed Odds (some won, some lost)', '');
    for (const s of mixed.sort((a, b) => b.settled - a.settled).slice(0, 50)) {
      const pct = ((s.won / s.settled) * 100).toFixed(0);
      lines.push(
        `- **${marketNames[s.marketId] ?? s.marketId} | ${s.name} @ ${s.odds}**: ${s.won}/${s.settled} won (${pct}%) across ${s.matchedEvents} match(es)`
      );
    }
    lines.push('');
  }

  if (pending.length) {
    lines.push(`## Unsettled (${pending.length})`, '');
    lines.push('These were recorded but their matches have not finished yet:', '');
    for (const s of pending.slice(0, 30)) {
      lines.push(`- ${marketNames[s.marketId] ?? s.marketId} | ${s.name} @ ${s.odds}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printRepeated(repeated, marketFilter) {
  console.log(`Repeated odds across matches${marketFilter ? ` in [${marketFilter}]` : ''}:`);
  const groups = {};
  for (const r of repeated) {
    (groups[r.market] ??= []).push(r);
  }
  for (const key of MARKET_ORDER) {
    const items = groups[key];
    if (!items) continue;
    console.log(`\n== ${key} (${items.length} repeated) ==`);
    for (const r of items.slice(0, 10)) {
      console.log(`  ${r.name} @ ${r.odds} x${r.count}  (e.g. ${r.sample.homeTeam} vs ${r.sample.awayTeam})`);
    }
    if (items.length > 10) console.log(`  ... and ${items.length - 10} more`);
  }
}

async function runCli() {
  const [arg1, arg2, arg3] = process.argv.slice(2);

  if (arg1 === '--db') {
    const db = await loadDb();
    const list = aggregateDb(db);
    await fs.writeFile(path.join(DATA_DIR, 'performance.md'), oddsReport(list), 'utf8');
    console.log(`Analyzed ${list.length} outcome/odds combinations. Wrote data/performance.md`);
    return;
  }

  // Exact lookup: node analyze-odds.mjs Multigoals "1-4" 1.12
  if (arg1 && arg2 && arg3 !== undefined) {
    const data = await load();
    const hits = findExactOdds(data, arg1, arg2, Number(arg3));
    console.log(`"${arg2}" @ ${arg3} in ${arg1}: ${hits.length} match(es)`);
    for (const h of hits) {
      console.log(`  ${h.homeTeam} vs ${h.awayTeam} (${h.tournament})`);
    }
    return;
  }

  // Per-market or full repeated: node analyze-odds.mjs ["Correct Score [0:0]"]
  const data = await load();
  const repeated = findRepeatedOdds(data, arg1);
  printRepeated(repeated, arg1);

  console.log(`\nUse "node analyze-odds.mjs --db" for the persistent good/bad odds report (data/odds-db.json).`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((e) => {
    console.error(`analyze-odds failed: ${e.message}`);
    process.exit(1);
  });
}
