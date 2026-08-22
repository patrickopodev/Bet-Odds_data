// Option 3 v2b — v2 + per-class Platt calibration.
//
// Same features as v2 (team strength + form + league + home adv), but replaces
// the single global temperature with per-outcome Platt scaling: each outcome's
// calibrated prob is sigmoid(a_o * rawLogit_o + b_o), fit on the training window.
// Per-class scaling captures the non-uniform overconfidence a single T cannot.
//
// Usage: node train-model-v2.mjs [--min-edge 0.02]

import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, parseScore, normTeam } from './lib/common.mjs';

const MIN_EDGE = Number(process.argv.includes('--min-edge')
  ? process.argv[process.argv.indexOf('--min-edge') + 1]
  : process.env.MIN_EDGE ?? 0.02);
const MARGIN = 0.077;

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const tkey = (name, useNorm) => (useNorm ? normTeam(name) : name);
const lkey = (name) => String(name ?? '').trim().toLowerCase();

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
    rows.push({
      home: tkey(ev.homeTeam, useNorm),
      away: tkey(ev.awayTeam, useNorm),
      league: lkey(ev.tournament),
      t: Date.parse(ev.startTime),
      odds: { H: h, D: d, A: a },
      y,
    });
  }
  rows.sort((x, y) => x.t - y.t);
  return rows;
}

function buildTeamHist(rows) {
  const hist = new Map();
  for (const r of rows) {
    if (!hist.has(r.home)) hist.set(r.home, []);
    if (!hist.has(r.away)) hist.set(r.away, []);
    hist.get(r.home).push({ t: r.t, res: r.y });
    hist.get(r.away).push({ t: r.t, res: r.y === 'H' ? 'A' : r.y === 'A' ? 'H' : 'D' });
  }
  for (const arr of hist.values()) arr.sort((a, b) => a.t - b.t);
  return hist;
}

function formScore(hist, team, t) {
  const arr = hist.get(team);
  if (!arr) return 0;
  let w = 0, d = 0, cnt = 0;
  for (let i = arr.length - 1; i >= 0 && cnt < 5; i--) {
    if (arr[i].t >= t) continue;
    if (arr[i].res === 'H') w++;
    else if (arr[i].res === 'D') d++;
    cnt++;
  }
  return w * 3 + d;
}

function computeS(model, r) {
  const sh = model.theta.has(r.home) ? model.theta.get(r.home) : 0;
  const sa = model.theta.has(r.away) ? model.theta.get(r.away) : 0;
  const sl = model.leag.has(r.league) ? model.leag.get(r.league) : 0;
  return sh - sa + model.wl * sl + model.wf * (r._hf - r._af);
}

function train(trainRows, epochs = 40, lr = 0.05, lambda = 0.01) {
  const theta = new Map();
  const leag = new Map();
  const get = (m, k) => (m.has(k) ? m.get(k) : 0);
  let h = 0, wf = 0, wl = 0;
  const hist = buildTeamHist(trainRows);
  for (const r of trainRows) {
    r._hf = formScore(hist, r.home, r.t);
    r._af = formScore(hist, r.away, r.t);
  }
  for (let e = 0; e < epochs; e++) {
    for (const r of trainRows) {
      const sh = get(theta, r.home), sa = get(theta, r.away);
      const sl = get(leag, r.league);
      const s = sh - sa + wl * sl + wf * (r._hf - r._af);
      const eH = Math.exp(s + h), eA = Math.exp(-s);
      const Z = 1 + eH + eA;
      const pH = eH / Z, pA = eA / Z;
      const iH = r.y === 'H' ? 1 : 0, iA = r.y === 'A' ? 1 : 0;
      const gs = (pH - iH) - (pA - iA);
      theta.set(r.home, sh - lr * (gs + lambda * sh));
      theta.set(r.away, sa - lr * (-gs + lambda * sa));
      h -= lr * (pH - iH);
      wf -= lr * (gs * (r._hf - r._af));
      leag.set(r.league, sl - lr * (gs * wl + lambda * sl));
      wl -= lr * (gs * sl + lambda * wl);
    }
  }
  const model = { theta, leag, h, wf, wl, hist };
  for (const r of trainRows) r._s = computeS(model, r);
  return model;
}

// Per-class Platt: calibrated P_o = sigmoid(a_o * rawLogit_o + b_o).
// rawLogit: H = s+h, A = -s, D = 0.
function fitPlatt(rows, model) {
  const params = {};
  for (const o of ['H', 'D', 'A']) {
    let a = 1, b = 0;
    const lr = 0.1;
    for (let e = 0; e < 300; e++) {
      let ga = 0, gb = 0;
      for (const r of rows) {
        const L = o === 'H' ? r._s + model.h : o === 'A' ? -r._s : 0;
        const z = a * L + b;
        const p = 1 / (1 + Math.exp(-z));
        const y = r.y === o ? 1 : 0;
        const err = p - y;
        ga += err * L;
        gb += err;
      }
      a -= (lr * ga) / rows.length;
      b -= (lr * gb) / rows.length;
    }
    params[o] = { a, b };
  }
  return params;
}

function predictCalib(model, r, platt) {
  const s = computeS(model, r);
  const L = { H: s + model.h, A: -s, D: 0 };
  const P = {};
  for (const o of ['H', 'D', 'A']) P[o] = 1 / (1 + Math.exp(-(platt[o].a * L[o] + platt[o].b)));
  return P;
}

function evaluate(useNorm) {
  const rows = collect(useNorm);
  if (rows.length < 200) return null;
  const initTrain = Math.min(200, Math.floor(rows.length * 0.3));
  const block = 20;
  const bets = [];
  const calibration = [];
  for (let i = 0; i < rows.length; i++) {
    if (i < initTrain) continue;
    const trainRows = rows.slice(0, i);
    const model = train(trainRows);
    const platt = fitPlatt(trainRows, model);
    const r = rows[i];
    r._hf = formScore(model.hist, r.home, r.t);
    r._af = formScore(model.hist, r.away, r.t);
    const p = predictCalib(model, r, platt);
    for (const k of ['H', 'D', 'A']) {
      const ev = p[k] * r.odds[k] - 1;
      if (ev > MIN_EDGE) {
        const won = r.y === k;
        bets.push({ p: p[k], odds: r.odds[k], won, pnl: won ? r.odds[k] - 1 : -1 });
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
  return bins.map(([lo, hi]) => {
    const rs = calibration.filter((c) => c.p >= lo && c.p < hi);
    const w = rs.filter((c) => c.won).length;
    return `    ${(lo * 100).toFixed(0)}-${(hi * 100).toFixed(0)}%  n=${String(rs.length).padStart(4)}  actual=${(rs.length ? (w / rs.length) * 100 : 0).toFixed(0)}%`;
  }).join('\n');
}

function report(label, res) {
  if (!res) { console.log(`${label}: insufficient data`); return; }
  console.log(`\n--- ${label} ---`);
  console.log(`value bets: ${res.n}  won: ${res.won}  win rate: ${res.n ? ((res.won / res.n) * 100).toFixed(1) : '0'}%`);
  console.log(`P&L: ${res.pnl >= 0 ? '+' : ''}${res.pnl.toFixed(3)}  ROI: ${(res.roi * 100).toFixed(1)}%`);
  console.log('calibration (predicted vs actual):');
  console.log(calibrationLine(res.calibration));
}

const raw = evaluate(false);
const norm = evaluate(true);
report('v2b RAW (Platt calibration)', raw);
report('v2b NORM (Platt calibration)', norm);
if (raw && norm) {
  console.log('\n=== v2b fragmentation gap ===');
  console.log(`ROI raw: ${(raw.roi * 100).toFixed(1)}%  vs norm: ${(norm.roi * 100).toFixed(1)}%  -> delta ${((norm.roi - raw.roi) * 100).toFixed(1)} pts`);
}
console.log(`\nbookmaker margin hurdle: -${(MARGIN * 100).toFixed(1)}%`);
console.log(`recap: v1 -20.9% | v2(temp) -13.1% | v2b(Platt) ${raw ? (raw.roi * 100).toFixed(1) : '?'}%`);
