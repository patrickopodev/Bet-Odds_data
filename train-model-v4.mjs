// Option 3 v4 - MARKET MOVEMENT (steam/drift) as the edge signal.
//
// Instead of a static team-strength model, this bets the INFORMATION in the
// odds movement itself: when an outcome's price SHORTENS (steams) before
// kickoff, it usually means sharp money arrived and the true probability rose.
// Following steam is a well-known (if contested) edge. Crucially this needs no
// walk-forward - each match's own plays[] timeline predates its result, so it
// is out-of-sample with no leakage.
//
// Also tests the classic FAVORITE-LONGSHOT bias (favorites win more often than
// their implied prob suggests) as a market-efficiency baseline.
//
// Usage: node train-model-v4.mjs

import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, parseScore, evaluateOutcome } from './lib/common.mjs';

const MARGIN = 0.077;

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

// outcome helper: first/last odds + drift (last - first; negative = steamed)
function od(outcome) {
  const plays = outcome?.plays ?? [];
  if (!plays.length) return null;
  const first = plays[0].odds;
  const last = plays.at(-1).odds;
  return { first, last, drift: last - first, n: plays.length };
}

const events = [];
for (const ev of Object.values(db.events ?? {})) {
  if (!ev.finalScore) continue;
  const score = parseScore(ev.finalScore);
  if (!score) continue;
  const get = (marketId, name) => ev.outcomes[`${marketId}|${name}`];
  const h = od(get('1', 'Home'));
  const d = od(get('1', 'Draw'));
  const a = od(get('1', 'Away'));
  const ou = [];
  for (const [key, o] of Object.entries(ev.outcomes ?? {})) {
    if (key.split('|')[0] !== '18') continue;
    const x = od(o);
    if (x) ou.push({ name: o.name, ...x });
  }
  if (!h || !d || !a) continue;
  events.push({ score, h, d, a, ou });
}
console.log(`resolved events with 1X2 odds timelines: ${events.length}`);

// settle a 1X2 / OU bet at given odds
function settle1x2(name, score, odds) {
  const r = evaluateOutcome('1', name, score);
  return r === 'VOID' ? 0 : r === 'WON' ? odds - 1 : -1;
}
function settleOU(name, score, odds) {
  const r = evaluateOutcome('18', name, score);
  return r === 'VOID' ? 0 : r === 'WON' ? odds - 1 : -1;
}

function report(label, bets) {
  const n = bets.length;
  const won = bets.filter((b) => b.pnl > 0).length;
  const pnl = bets.reduce((s, b) => s + b.pnl, 0);
  const roi = n ? pnl / n : 0;
  console.log(`${label}: bets=${n} winrate=${n ? ((won / n) * 100).toFixed(1) : '0'}% P&L=${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)} ROI=${(roi * 100).toFixed(1)}%`);
  return roi;
}

// ---- FAVORITE-LONGSHOT bias (1X2): bet the lowest-odds outcome ----
{
  const bets = [];
  for (const e of events) {
    const sides = [['Home', e.h], ['Draw', e.d], ['Away', e.a]];
    sides.sort((x, y) => x[1].last - y[1].last); // lowest odds = favorite
    const [name, o] = sides[0];
    bets.push({ pnl: settle1x2(name, e.score, o.last) });
  }
  report('FAVORITE (1X2 lowest odds)', bets);
}

// ---- STEAM-FOLLOW 1X2: bet the most-shortened outcome (drift most negative) ----
console.log('\nSTEAM-FOLLOW 1X2 (bet most-steamed side, require drift < -thr):');
for (const thr of [0.05, 0.1, 0.15, 0.2, 0.3]) {
  const bets = [];
  for (const e of events) {
    const sides = [['Home', e.h], ['Draw', e.d], ['Away', e.a]];
    sides.sort((x, y) => x[1].drift - y[1].drift); // most negative drift first
    const [name, o] = sides[0];
    if (o.drift < -thr) bets.push({ pnl: settle1x2(name, e.score, o.last) });
  }
  report(`  drift<-${thr}`, bets);
}

// ---- STEAM-FOLLOW O/U: bet any O/U side that shortened beyond threshold ----
console.log('\nSTEAM-FOLLOW O/U (bet shortened sides, require drift < -thr):');
for (const thr of [0.05, 0.1, 0.15, 0.2, 0.3]) {
  const bets = [];
  for (const e of events) {
    for (const o of e.ou) {
      if (o.drift < -thr) bets.push({ pnl: settleOU(o.name, e.score, o.last) });
    }
  }
  report(`  drift<-${thr}`, bets);
}

console.log(`\nbookmaker margin hurdle: -${(MARGIN * 100).toFixed(1)}% (need ROI > 0 to truly earn)`);
