// Option 3 v3b - O/U ONLY, per-line calibration + margin-aware threshold sweep.
//
// v3 showed O/U sits at -3.4% ROI (near the -7.7% margin) while Multigoals
// bleeds. This focuses on O/U: each (Over/Under, line) gets its OWN Platt
// calibration (with fallback to the Over/Under-pooled calibrator when a line
// has too few samples), then we sweep the EV threshold to find where O/U
// actually clears the margin.
//
// Usage: node train-model-v3b.mjs [--raw]

import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, parseScore, normTeam, evaluateOutcome } from './lib/common.mjs';

const MARGIN = 0.077;
const USE_NORM = !process.argv.includes('--raw');
const MIN_CAL_SAMPLES = 15;

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const tkey = (name) => (USE_NORM ? normTeam(name) : name);
const lkey = (name) => String(name ?? '').trim().toLowerCase();

function poissonPmf(lam, k) {
  let p = Math.exp(-lam);
  for (let i = 1; i <= k; i++) p *= lam / i;
  return p;
}
function poissonCdf(lam, k) {
  let s = 0;
  const max = Math.max(20, Math.ceil(lam) + 10);
  for (let i = 0; i <= max; i++) {
    s += poissonPmf(lam, i);
    if (s >= 0.999999 && i >= k) break;
  }
  return Math.min(1, s);
}

const events = [];
for (const ev of Object.values(db.events ?? {})) {
  if (!ev.finalScore) continue;
  const score = parseScore(ev.finalScore);
  if (!score) continue;
  const ou = [];
  for (const [key, o] of Object.entries(ev.outcomes ?? {})) {
    if (key.split('|')[0] !== '18') continue;
    const odds = o.plays?.at(-1)?.odds;
    if (!odds || odds <= 1) continue;
    ou.push({ name: o.name, odds });
  }
  if (!ou.length) continue;
  events.push({
    home: tkey(ev.homeTeam),
    away: tkey(ev.awayTeam),
    league: lkey(ev.tournament),
    t: Date.parse(ev.startTime),
    hg: score.home,
    ag: score.away,
    score: ev.finalScore,
    ou,
  });
}
events.sort((a, b) => a.t - b.t);
console.log(`resolved events with O/U: ${events.length}`);

function trainPoisson(trainEvents, epochs = 30, lr = 0.05, lambda = 0.01) {
  const att = new Map();
  const def = new Map();
  const get = (m, k) => (m.has(k) ? m.get(k) : 0);
  let h = 0;
  for (let e = 0; e < epochs; e++) {
    for (const r of trainEvents) {
      const ah = get(att, r.home), bh = get(def, r.home);
      const aa = get(att, r.away), ba = get(def, r.away);
      const lH = Math.exp(ah - ba + h);
      const lA = Math.exp(aa - bh);
      att.set(r.home, ah - lr * ((lH - r.hg) + lambda * ah));
      def.set(r.home, bh - lr * ((r.ag - lA) + lambda * bh));
      att.set(r.away, aa - lr * ((lA - r.ag) + lambda * aa));
      def.set(r.away, ba - lr * ((r.hg - lH) + lambda * ba));
      h -= lr * (lH - r.hg);
    }
  }
  return { att, def, h };
}
function expectedTotal(model, r) {
  const ah = model.att.has(r.home) ? model.att.get(r.home) : 0;
  const ba = model.def.has(r.away) ? model.def.get(r.away) : 0;
  const aa = model.att.has(r.away) ? model.att.get(r.away) : 0;
  const bh = model.def.has(r.home) ? model.def.get(r.home) : 0;
  return Math.exp(ah - ba + model.h) + Math.exp(aa - bh);
}

function ouProbs(total, name) {
  const m = /^Over\s+(\d+(?:\.\d+)?)$/.exec(name) || /^Under\s+(\d+(?:\.\d+)?)$/.exec(name);
  if (!m) return null;
  const isOver = /^Over/.test(name);
  const line = parseFloat(m[1]);
  const cdf = poissonCdf(total, Math.floor(line - 1e-9));
  return isOver ? 1 - cdf : cdf;
}
function lineOf(name) {
  const m = /^Over\s+(\d+(?:\.\d+)?)$/.exec(name) || /^Under\s+(\d+(?:\.\d+)?)$/.exec(name);
  return m ? parseFloat(m[1]) : null;
}

function fitPlatt(pairs) {
  let a = 1, b = 0;
  const lr = 0.1;
  for (let e = 0; e < 300; e++) {
    let ga = 0, gb = 0;
    for (const { p, y } of pairs) {
      const pc = Math.min(1 - 1e-6, Math.max(1e-6, p));
      const logit = Math.log(pc / (1 - pc));
      const sig = 1 / (1 + Math.exp(-(a * logit + b)));
      const err = sig - y;
      ga += err * logit;
      gb += err;
    }
    a -= (lr * ga) / pairs.length;
    b -= (lr * gb) / pairs.length;
  }
  return { a, b };
}
function applyPlatt(platt, p) {
  const pc = Math.min(1 - 1e-6, Math.max(1e-6, p));
  const logit = Math.log(pc / (1 - pc));
  return 1 / (1 + Math.exp(-(platt.a * logit + platt.b)));
}

// ---- walk-forward: collect all O/U candidates with calibrated prob + outcome ----
const initTrain = Math.min(200, Math.floor(events.length * 0.3));
const block = 20;
const candidates = [];

for (let i = 0; i < events.length; i++) {
  if (i < initTrain) continue;
  const trainEvents = events.slice(0, i);
  const model = trainPoisson(trainEvents);

  // calibration pairs (per-line template + Over/Under-pooled fallback)
  const perLine = {};
  const pooled = { O: [], U: [] };
  for (const e of trainEvents) {
    const lam = expectedTotal(model, e);
    for (const o of e.ou) {
      const p = ouProbs(lam, o.name);
      if (p == null) continue;
      const isOver = /^Over/.test(o.name);
      const line = lineOf(o.name);
      const y = evaluateOutcome('18', o.name, parseScore(e.score)) === 'WON' ? 1 : 0;
      const tpl = `OU_${isOver ? 'O' : 'U'}_${line}`;
      (perLine[tpl] ||= []).push({ p, y });
      pooled[isOver ? 'O' : 'U'].push({ p, y });
    }
  }
  const platt = {};
  for (const tpl of Object.keys(perLine)) platt[tpl] = fitPlatt(perLine[tpl]);
  for (const k of ['O', 'U']) if (pooled[k].length) platt[`OU_${k}`] = fitPlatt(pooled[k]);

  const r = events[i];
  const lam = expectedTotal(model, r);
  for (const o of r.ou) {
    const raw = ouProbs(lam, o.name);
    if (raw == null) continue;
    const isOver = /^Over/.test(o.name);
    const line = lineOf(o.name);
    const tplLine = `OU_${isOver ? 'O' : 'U'}_${line}`;
    const tplPool = `OU_${isOver ? 'O' : 'U'}`;
    const useTpl = perLine[tplLine] && perLine[tplLine].length >= MIN_CAL_SAMPLES ? tplLine : tplPool;
    const p = platt[useTpl] ? applyPlatt(platt[useTpl], raw) : raw;
    const res = evaluateOutcome('18', o.name, parseScore(r.score));
    const won = res === 'WON';
    const pnl = res === 'VOID' ? 0 : won ? o.odds - 1 : -1;
    candidates.push({ p, odds: o.odds, ev: p * o.odds - 1, won, pnl, line, isOver });
  }
}

// ---- threshold sweep ----
console.log('\n=== v3b O/U — EV threshold sweep (per-line calibrated) ===');
const thresholds = [0, 0.02, 0.05, 0.077, 0.10, 0.15];
for (const thr of thresholds) {
  const sel = candidates.filter((c) => c.ev > thr);
  const n = sel.length;
  const won = sel.filter((c) => c.won).length;
  const pnl = sel.reduce((s, c) => s + c.pnl, 0);
  const roi = n ? pnl / n : 0;
  console.log(
    `  EV>${thr.toFixed(3)}  bets=${String(n).padStart(5)}  win=${(n ? (won / n) * 100 : 0).toFixed(1)}%  P&L=${pnl >= 0 ? '+' : ''}${pnl.toFixed(1)}  ROI=${(roi * 100).toFixed(1)}%  ${roi > -MARGIN ? 'BEATS MARGIN' : ''}`
  );
}
console.log(`\nbookmaker margin hurdle: -${(MARGIN * 100).toFixed(1)}%`);
console.log(`(v3 combined reported O/U at -3.4% with pooled calibration + EV>0.02)`);
