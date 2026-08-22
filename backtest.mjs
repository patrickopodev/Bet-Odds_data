// Out-of-sample backtest for the agent's "historical edge" decision rule.
//
// For every settled match in data/odds-db.json we ask: "if the agent had run
// on this match using only the OTHER settled matches as its history, would it
// have recommended a bet, and would that bet have won?" This is a strict
// leave-one-out test — no match is ever scored using its own outcome, so the
// result is not contaminated by in-sample optimism.
//
// The decision rule is a faithful JS port of agent/analysis.ts analyzeCandidate
// (the historical-signal path + odds-drift path + recommendedMinOdds floor).
// Team-form and web-research contributions are NOT in the odds-db, so they are
// omitted here: confidence starts at the 0.35 baseline the agent uses. That
// makes this a conservative test of the 1X2/Draw markets and a full test of the
// history-only markets (Correct Score 41, Multiscores 551, Multigoals 548).
//
// Usage: node backtest.mjs [--by-section] [--calibration]

import fs from 'node:fs';
import path from 'node:path';
import {
  DB_FILE,
  parseScore,
  evaluateOutcome,
} from './lib/common.mjs';

// --- --score-history: score the agent's ACTUAL past recommendations -------
// agent-history.json records what the agent recommended each run, BEFORE any
// match resolves. Scoring those picks against the later finalScore is therefore
// a fair (out-of-sample) read on whether the agent's selections win. Recs are
// de-duplicated by event|market|outcome (the staker never re-picks a match), so
// each recommended bet is counted once regardless of how many runs flagged it.
const MARKET_DISPLAY_TO_ID = {
  '1X2': '1',
  'Over/Under': '18',
  'Total Goals': '548',
  'Correct Score': '41',
  'Multiscores': '551',
};

function scoreHistory() {
  const histFile = path.join('data', 'agent-history.json');
  let runs;
  try {
    runs = JSON.parse(fs.readFileSync(histFile, 'utf8'));
  } catch {
    console.log(`No ${histFile} found — run the agent (agent.yml) first.`);
    process.exit(0);
  }
  if (!Array.isArray(runs)) {
    console.log(`${histFile} is not an array`);
    process.exit(0);
  }
  // Optional --since-days N: only score runs newer than N days, so the gate can
  // ignore the legacy pre-favorite-rule picks and track just the validated era.
  const sinceIdx = process.argv.indexOf('--since-days');
  if (sinceIdx >= 0) {
    const cutoff = Date.now() - Number(process.argv[sinceIdx + 1]) * 86400_000;
    runs = runs.filter((r) => Date.parse(r.generatedAt) >= cutoff);
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  const events = db.events ?? {};
  const seen = new Set();
  const bets = [];
  let scannedRuns = 0;
  for (const run of runs) {
    scannedRuns++;
    for (const m of run.matches ?? []) {
      const ev = events[m.eventId];
      if (!ev || !ev.finalScore) continue; // unresolved yet
      const score = parseScore(ev.finalScore);
      const byMarket = new Map();
      for (const out of Object.values(ev.outcomes ?? {})) {
        if (!byMarket.has(out.marketId)) byMarket.set(out.marketId, []);
        byMarket.get(out.marketId).push(out.name);
      }
      for (const rec of m.recommended) {
        const marketId = MARKET_DISPLAY_TO_ID[rec.market];
        if (!marketId) continue;
        const key = `${m.eventId}|${marketId}|${rec.outcome}`;
        if (seen.has(key)) continue; // staker never re-picks
        seen.add(key);
        const result = evaluateOutcome(marketId, rec.outcome, score, byMarket.get(marketId));
        const pnl = result === 'WON' ? rec.odds - 1 : result === 'LOST' ? -1 : 0;
        bets.push({ ...rec, marketId, result, pnl });
      }
    }
  }

  console.log('=== Agent recommendation history (out-of-sample) ===');
  console.log(`runs scanned:        ${scannedRuns}`);
  console.log(`resolved bets:       ${bets.length}`);
  const won = bets.filter((b) => b.result === 'WON').length;
  const lost = bets.filter((b) => b.result === 'LOST').length;
  const voided = bets.filter((b) => b.result === 'VOID').length;
  const pnl = bets.reduce((s, b) => s + b.pnl, 0);
  const roi = bets.length ? pnl / bets.length : 0;
  console.log(`won / lost / void:   ${won} / ${lost} / ${voided}`);
  console.log(`win rate (decided):  ${won + lost ? ((won / (won + lost)) * 100).toFixed(1) : '0'}%`);
  console.log(`P&L (unit stakes):   ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}`);
  console.log(`ROI:                 ${(roi * 100).toFixed(1)}%`);
  console.log(`(bookmaker margin hurdle ≈ -7.7%)`);

  // CI gate: fail if a sufficient sample exists and ROI is below the threshold
  // (default: the 7.7% bookmaker margin, i.e. the strategy must beat the house).
  const failIdx = process.argv.indexOf('--fail-below');
  const threshold = failIdx >= 0 ? Number(process.argv[failIdx + 1]) : null;
  if (threshold != null && bets.length >= 30 && roi < threshold) {
    console.error(`\n[backtest] FAIL: agent ROI ${(roi * 100).toFixed(1)}% < threshold ${(threshold * 100).toFixed(1)}% over ${bets.length} bets`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv.includes('--score-history')) scoreHistory();

// --- --score-paper: score the paper-trade track -------------------------
// data/paper-picks.json is written by train-model-v5b.mjs --paper. Each pick is
// a 1X2-favorite value bet (odds in [1.8,2.2)) logged with ZERO stake; when the
// match resolves the same script settles it (pnl field). Scoring here gives the
// CI gate a clean, bias-free read on the validated strategy's LIVE performance.
function scorePaper() {
  const file = path.join('data', 'paper-picks.json');
  let picks;
  try {
    picks = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    console.log(`No ${file} found — run train-model-v5b.mjs --paper --score-paper first.`);
    process.exit(0);
  }
  if (!Array.isArray(picks)) {
    console.log(`${file} is not an array`);
    process.exit(0);
  }
  const resolved = picks.filter((p) => p.status === 'WON' || p.status === 'LOST' || p.status === 'VOID');
  const bets = resolved.map((p) => ({ ...p, result: p.status }));
  console.log('=== Paper-trade track (favorite value, out-of-sample) ===');
  console.log(`total picks:        ${picks.length}`);
  console.log(`resolved bets:      ${bets.length}`);
  const won = bets.filter((b) => b.result === 'WON').length;
  const lost = bets.filter((b) => b.result === 'LOST').length;
  const voided = bets.filter((b) => b.result === 'VOID').length;
  const pnl = bets.reduce((s, b) => s + (b.pnl ?? 0), 0);
  const roi = bets.length ? pnl / bets.length : 0;
  console.log(`won / lost / void:   ${won} / ${lost} / ${voided}`);
  console.log(`win rate (decided):  ${won + lost ? ((won / (won + lost)) * 100).toFixed(1) : '0'}%`);
  console.log(`P&L (unit stakes):   ${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}`);
  console.log(`ROI:                 ${(roi * 100).toFixed(1)}%`);
  console.log(`(bookmaker margin hurdle ≈ -7.7%)`);

  const failIdx = process.argv.indexOf('--fail-below');
  const threshold = failIdx >= 0 ? Number(process.argv[failIdx + 1]) : null;
  if (threshold != null && bets.length >= 30 && roi < threshold) {
    console.error(`\n[backtest] FAIL: paper ROI ${(roi * 100).toFixed(1)}% < threshold ${(threshold * 100).toFixed(1)}% over ${bets.length} bets`);
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv.includes('--score-paper')) scorePaper();


const DB = process.env.DB_FILE ?? path.join('data', 'odds-db.json');
const RELEVANT_MARKETS = new Set(['1', '18', '548', '41', '551']);
const MIN_HISTORY_SAMPLE = 5;
const MIN_DRIFT_PLAYS = 3;
const SECTION_OF = {
  '1': '1X2 / O/U',
  '18': '1X2 / O/U',
  '41': 'Correct Score [0:0]',
  '551': 'Multiscores',
  '548': 'Multigoals',
};

// ---- load + index ---------------------------------------------------------
const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const events = Object.values(db.events ?? {});
const settled = events.filter((e) => e.finalScore && e.outcomes && Object.keys(e.outcomes).length);

// key = `${marketId}|${name}|${odds}`  -> contribution of one event to that bucket.
// Per-event dedup (a match counts once per distinct price) matches
// aggregateHistoricalStats in lib/common.mjs.
const perEvent = new Map();
// grouped: `${marketId}|${name}` -> [{ odds, won, settled, plays, key }]
// Only this outcome's own history is scanned per candidate (fast).
const grouped = new Map();

for (const ev of settled) {
  const score = parseScore(ev.finalScore);
  const byMarket = new Map();
  for (const out of Object.values(ev.outcomes ?? {})) {
    if (!byMarket.has(out.marketId)) byMarket.set(out.marketId, []);
    byMarket.get(out.marketId).push(out.name);
  }
  const resultOf = new Map();
  for (const out of Object.values(ev.outcomes ?? {})) {
    const r = evaluateOutcome(out.marketId, out.name, score, byMarket.get(out.marketId));
    if (r) resultOf.set(`${out.marketId}|${out.name}`, r);
  }
  const seen = new Set();
  const contrib = new Map();
  for (const out of Object.values(ev.outcomes ?? {})) {
    const res = resultOf.get(`${out.marketId}|${out.name}`);
    for (const play of out.plays ?? []) {
      const k = `${out.marketId}|${out.name}|${play.odds}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const c = contrib.get(k) ?? { won: 0, settled: 0, plays: 0 };
      c.plays++;
      if (res === 'WON') { c.won++; c.settled++; }
      else if (res === 'LOST' || res === 'VOID') { c.settled++; }
      contrib.set(k, c);
      const gkey = `${out.marketId}|${out.name}`;
      let list = grouped.get(gkey);
      if (!list) { list = []; grouped.set(gkey, list); }
      list.push({ odds: play.odds, won: c.won, settled: c.settled, plays: c.plays, key: k });
    }
  }
  perEvent.set(ev.eventId, contrib);
}

// Leave-one-out history for one candidate, mirroring agent/db.ts outcomeHistory.
function looHistory(eventId, marketId, name, currentOdds) {
  const lo = currentOdds * 0.75;
  const hi = currentOdds * 1.3;
  const contrib = perEvent.get(eventId);
  const list = grouped.get(`${marketId}|${name}`) ?? [];
  let won = 0, settled = 0, plays = 0;
  for (const g of list) {
    if (g.odds < lo || g.odds > hi) continue;
    const mine = contrib.get(g.key) ?? { won: 0, settled: 0, plays: 0 };
    won += g.won - mine.won;
    settled += g.settled - mine.settled;
    plays += g.plays - mine.plays;
  }
  return {
    winRate: settled >= 3 ? won / settled : null,
    settled,
  };
}

// Per-event odds drift from its own plays (timestamp = seenAt ?? scrapedAt).
function oddsDrift(ev, marketId, name) {
  const plays = ev?.outcomes?.[`${marketId}|${name}`]?.plays ?? [];
  if (plays.length < MIN_DRIFT_PLAYS) return null;
  const ts = (p) => Date.parse(p.seenAt ?? p.scrapedAt ?? 0);
  const sorted = [...plays].sort((a, b) => ts(a) - ts(b));
  const first = sorted[0].odds, last = sorted[sorted.length - 1].odds;
  return { drift: Number((last - first).toFixed(3)), first, last, samples: sorted.length };
}

// Faithful port of agent/analysis.ts analyzeCandidate (history + drift only).
function analyze(ev, marketId, name, odds) {
  const implied = 1 / odds;
  const hist = looHistory(ev.eventId, marketId, name, odds);
  let edge = hist.winRate != null ? hist.winRate - implied : null;

  let confidence = 0.35; // baseline; team-form path omitted (not in DB)
  if (hist.winRate != null) {
    const sampleFactor = Math.min(1, hist.settled / 10);
    const belowTrust = hist.settled < MIN_HISTORY_SAMPLE;
    if (edge != null && edge > 0) {
      confidence = Math.min(1, confidence + (belowTrust ? 0 : Math.min(0.25, edge) * sampleFactor));
    } else if (edge != null && edge < 0) {
      confidence = Math.max(0, confidence - (belowTrust ? 0 : Math.min(0.2, Math.abs(edge)) * sampleFactor));
    }
  }
  const movement = oddsDrift(ev, marketId, name);
  if (movement && movement.samples >= MIN_DRIFT_PLAYS && Math.abs(movement.drift) > 1e-9) {
    const nudge = Math.min(0.05, Math.abs(movement.drift) * 0.5);
    confidence = movement.drift < 0
      ? Math.min(1, confidence + nudge)
      : Math.max(0, confidence - nudge);
  }
  let recommendedMinOdds;
  if (hist.winRate != null && hist.winRate > 0.05 && hist.settled >= MIN_HISTORY_SAMPLE) {
    recommendedMinOdds = Number((1 / hist.winRate * 0.92).toFixed(2));
  } else {
    recommendedMinOdds = 1.4;
  }
  const relevant = RELEVANT_MARKETS.has(marketId);
  const recommended = relevant && confidence >= 0.5 && odds >= recommendedMinOdds && odds >= 1.3;
  return { recommended, confidence, edge, hist, recommendedMinOdds, implied };
}

// ---- run the backtest -----------------------------------------------------
const bets = [];
let skippedForHistory = 0;
for (const ev of settled) {
  const score = parseScore(ev.finalScore);
  const byMarket = new Map();
  for (const out of Object.values(ev.outcomes ?? {})) {
    if (!byMarket.has(out.marketId)) byMarket.set(out.marketId, []);
    byMarket.get(out.marketId).push(out.name);
  }
  for (const out of Object.values(ev.outcomes ?? {})) {
    if (!RELEVANT_MARKETS.has(out.marketId)) continue;
    const plays = out.plays ?? [];
    if (!plays.length) continue;
    // The agent bets the current (latest) price, so use the last play's odds.
    const odds = plays[plays.length - 1].odds;
    const a = analyze(ev, out.marketId, out.name, odds);
    if (!a.recommended) continue;
    const result = evaluateOutcome(out.marketId, out.name, score, byMarket.get(out.marketId));
    let pnl; // unit stake = 1
    if (result === 'WON') pnl = odds - 1;
    else if (result === 'LOST') pnl = -1;
    else pnl = 0; // VOID: stake returned
    bets.push({
      section: SECTION_OF[out.marketId],
      marketId: out.marketId,
      name: out.name,
      odds,
      confidence: a.confidence,
      edge: a.edge,
      histWinRate: a.hist?.winRate,
      histSettled: a.hist?.settled,
      minOdds: a.recommendedMinOdds,
      result,
      pnl,
    });
  }
}

// ---- reporting ------------------------------------------------------------
const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(3);
function summarize(rows, label) {
  const n = rows.length;
  const staked = n;
  const pnl = rows.reduce((s, r) => s + r.pnl, 0);
  const won = rows.filter((r) => r.result === 'WON').length;
  const lost = rows.filter((r) => r.result === 'LOST').length;
  const voided = rows.filter((r) => r.result === 'VOID').length;
  const roi = staked ? pnl / staked : 0;
  const winRate = won + lost ? won / (won + lost) : 0;
  console.log(`\n${label}`);
  console.log(`  bets           ${n}`);
  console.log(`  won/lost/void  ${won}/${lost}/${voided}`);
  console.log(`  win rate       ${(winRate * 100).toFixed(1)}%  (of decided bets)`);
  console.log(`  P&L (unit)     ${fmt(pnl)}`);
  console.log(`  ROI            ${(roi * 100).toFixed(1)}%  (P&L / stakes)`);
  return { n, pnl, roi, winRate, won, lost, voided };
}

console.log('=== Agent edge backtest (leave-one-out, out-of-sample) ===');
console.log(`settled events used as "live": ${settled.length}`);
const overall = summarize(bets, 'ALL RECOMMENDED BETS');

if (process.argv.includes('--by-section')) {
  for (const sec of ['1X2 / O/U', 'Correct Score [0:0]', 'Multiscores', 'Multigoals']) {
    summarize(bets.filter((b) => b.section === sec), `SECTION: ${sec}`);
  }
}

if (process.argv.includes('--calibration')) {
  console.log('\n=== CALIBRATION: predicted win rate vs actual ===');
  const bins = [
    [0.0, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 1.01],
  ];
  for (const [lo, hi] of bins) {
    const rows = bets.filter((b) => b.histWinRate != null && b.histWinRate >= lo && b.histWinRate < hi);
    const dec = rows.filter((b) => b.result === 'WON' || b.result === 'LOST').length;
    const actual = dec ? rows.filter((b) => b.result === 'WON').length / dec : null;
    console.log(
      `  hist ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%  n=${String(rows.length).padStart(4)}  ` +
      `actual win ${(actual == null ? '  -  ' : (actual * 100).toFixed(0) + '%')}`
    );
  }
}

// Baseline: what if we bet EVERY relevant outcome at its last odds?
let baseStaked = 0, basePnl = 0, baseWon = 0, baseLost = 0;
for (const ev of settled) {
  const score = parseScore(ev.finalScore);
  const byMarket = new Map();
  for (const out of Object.values(ev.outcomes ?? {})) {
    if (!byMarket.has(out.marketId)) byMarket.set(out.marketId, []);
    byMarket.get(out.marketId).push(out.name);
  }
  for (const out of Object.values(ev.outcomes ?? {})) {
    if (!RELEVANT_MARKETS.has(out.marketId)) continue;
    const plays = out.plays ?? [];
    if (!plays.length) continue;
    const odds = plays[plays.length - 1].odds;
    const r = evaluateOutcome(out.marketId, out.name, score, byMarket.get(out.marketId));
    if (r === 'WON') { basePnl += odds - 1; baseWon++; }
    else if (r === 'LOST') { basePnl -= 1; baseLost++; }
    baseStaked++;
  }
}
console.log('\n=== BASELINE: bet EVERY outcome (house edge reference) ===');
console.log(`  bets           ${baseStaked}`);
console.log(`  won/lost       ${baseWon}/${baseLost}`);
console.log(`  P&L (unit)     ${fmt(basePnl)}`);
console.log(`  ROI            ${((basePnl / baseStaked) * 100).toFixed(1)}%`);
console.log(`\nHouse edge over baseline ≈ ${(((basePnl / baseStaked)) * 100).toFixed(1)}% ROI (negative = bookmaker margin).`);
console.log(`Agent ROI vs baseline delta: ${(((overall.roi) - (basePnl / baseStaked)) * 100).toFixed(1)} pts`);

fs.writeFileSync(
  path.join('data', 'backtest.json'),
  JSON.stringify({ generatedAt: new Date().toISOString(), settledEvents: settled.length, bets, overall }, null, 2)
);
console.log('\nWrote data/backtest.json');
