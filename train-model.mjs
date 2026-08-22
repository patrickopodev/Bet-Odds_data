// Option 3 v1 — Bradley-Terry baseline, A/B on team-name normalization.
//
// Runs the same model twice: once with raw SportyBet team strings (the current
// v1 behavior) and once with names collapsed through normTeam(). The delta shows
// how much of the ROI gap is pure data fragmentation (same team under multiple
// spellings) versus model weakness.
//
// Usage: node train-model.mjs [--min-edge 0.02]

import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, parseScore, normTeam } from './lib/common.mjs';

const MIN_EDGE = Number(process.argv.includes('--min-edge')
  ? process.argv[process.argv.indexOf('--min-edge') + 1]
  : process.env.MIN_EDGE ?? 0.02);
const MARGIN = 0.077;

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

function key(name, useNorm) {
  return useNorm ? normTeam(name) : name;
}

function collect(useNorm) {
  const rows = [];
  for (const ev of Object.values(db.events ?? {})) {
    if (!ev.finalScore) continue;
    const oH = ev.outcomes['1|Home'], oD = ev.outcomes['1|Draw'], oA = ev.outcomes['1|Away'];
    if (!oH || !oD || !oA) continue;
    const h = oH.plays.at(-1)?.odds, d = oD.plays.at(-1)?.odds, a = oA.plays.at(-1)?.odds;
    if (!h || !d || !a || h <= 1 || d <= 1 || a <= 1) continue;
    const s = parseScore(ev.finalScore);
    if (!s) continue;
    const y = s.home > s.away ? 'H' : s.home < s.away ? 'A' : 'D';
    rows.push({ home: key(ev.homeTeam, useNorm), away: key(ev.awayTeam, useNorm), t: Date.parse(ev.startTime), odds: { H: h, D: d, A: a }, y });
  }
  rows.sort((x, y) => x.t - y.t);
  return rows;
}

function train(trainRows, epochs = 40, lr = 0.05, lambda = 0.01) {
  const theta = new Map();
  const get = (m, k) => (m.has(k) ? m.get(k) : 0);
  let h = 0;
  for (let e = 0; e < epochs; e++) {
    for (const r of trainRows) {
      const sh = get(theta, r.home), sa = get(theta, r.away);
      const s = sh - sa;
      const eH = Math.exp(s + h), eA = Math.exp(-s);
      const Z = 1 + eH + eA;
      const pH = eH / Z, pA = eA / Z;
      const iH = r.y === 'H' ? 1 : 0, iA = r.y === 'A' ? 1 : 0;
      theta.set(r.home, sh - lr * ((pH - iH) - (pA - iA) + lambda * sh));
      theta.set(r.away, sa - lr * (-(pH - iH) + (pA - iA) + lambda * sa));
      h -= lr * (pH - iH);
    }
  }
  return { theta, h };
}

function predict(model, r) {
  const sh = model.theta.has(r.home) ? model.theta.get(r.home) : 0;
  const sa = model.theta.has(r.away) ? model.theta.get(r.away) : 0;
  const s = sh - sa;
  const eH = Math.exp(s + model.h), eA = Math.exp(-s);
  const Z = 1 + eH + eA;
  return { H: eH / Z, D: 1 / Z, A: eA / Z };
}

function evaluate(useNorm) {
  const rows = collect(useNorm);
  if (rows.length < 200) return null;
  const initTrain = Math.min(200, Math.floor(rows.length * 0.3));
  const block = 20;
  let model = null;
  const bets = [];
  const calibration = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < initTrain) continue;
    if (!model || (i - initTrain) % block === 0) model = train(rows.slice(0, i));
    const r = rows[i];
    const p = predict(model, r);
    for (const k of ['H', 'D', 'A']) {
      const ev = p[k] * r.odds[k] - 1;
      if (ev > MIN_EDGE) {
        const won = r.y === k;
        bets.push({ p: p[k], odds: r.odds[k], ev, won, pnl: won ? r.odds[k] - 1 : -1 });
        calibration.push({ p: p[k], won });
      }
    }
  }
  const n = bets.length;
  const won = bets.filter((b) => b.won).length;
  const pnl = bets.reduce((s, b) => s + b.pnl, 0);
  const roi = n ? pnl / n : 0;
  return { n, won, pnl, roi, calibration };
}

function calibrationLine(calibration) {
  const bins = [[0, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 1.01]];
  const lines = [];
  for (const [lo, hi] of bins) {
    const rs = calibration.filter((c) => c.p >= lo && c.p < hi);
    const w = rs.filter((c) => c.won).length;
    lines.push(`    ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%  n=${String(rs.length).padStart(4)}  actual=${(rs.length ? (w / rs.length) * 100 : 0).toFixed(0)}%`);
  }
  return lines.join('\n');
}

function report(label, res) {
  if (!res) { console.log(`${label}: insufficient data`); return; }
  console.log(`\n--- ${label} ---`);
  console.log(`value bets: ${res.n}  won: ${res.won}  win rate: ${res.n ? ((res.won / res.n) * 100).toFixed(1) : '0'}%`);
  console.log(`P&L: ${res.pnl >= 0 ? '+' : ''}${res.pnl.toFixed(3)}  ROI: ${(res.roi * 100).toFixed(1)}%`);
  console.log('calibration:');
  console.log(calibrationLine(res.calibration));
}

const raw = evaluate(false);
const norm = evaluate(true);
report('v1 RAW names', raw);
report('v1 NORM names (normTeam collapse)', norm);
if (raw && norm) {
  console.log('\n=== fragmentation gap ===');
  console.log(`ROI raw:  ${(raw.roi * 100).toFixed(1)}%  vs  norm: ${(norm.roi * 100).toFixed(1)}%  ->  delta ${( (norm.roi - raw.roi) * 100).toFixed(1)} pts`);
  console.log(`(positive delta = name collapse recovers this much ROI)`);
}
console.log(`\nbookmaker margin hurdle: -${(MARGIN * 100).toFixed(1)}%`);
