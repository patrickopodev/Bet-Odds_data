// Option 3 v3 - O/U + Multigoals via a Poisson expected-goals model.
//
// 1X2 is efficiently priced (v1..v2b stuck at ~ -11% ROI). The likely edge lives
// in the less-efficient totals markets. This learns per-team attack/defense
// ratings from resolved scores (Poisson: home ~ exp(att_home - def_away + h),
// away ~ exp(att_away - def_home)), derives an expected TOTAL, then prices:
//   - O/U (market 18): P(Over/Under line) from the total's Poisson CDF
//   - Multigoals (548): P(range), P(No goal), P(7+)
// Per-template Platt scaling calibrates the probabilities. Walk-forward: train
// on earlier resolved matches, bet later ones where calibrated P*odds-1 > MIN_EDGE.
//
// Usage: node train-model-v3.mjs [--min-edge 0.02] [--raw]

import fs from 'node:fs';
import path from 'node:path';
import { DB_FILE, parseScore, normTeam, evaluateOutcome } from './lib/common.mjs';

const MIN_EDGE = Number(process.argv.includes('--min-edge')
  ? process.argv[process.argv.indexOf('--min-edge') + 1]
  : process.env.MIN_EDGE ?? 0.02);
const MARGIN = 0.077;
const USE_NORM = !process.argv.includes('--raw');

const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const tkey = (name) => (USE_NORM ? normTeam(name) : name);
const lkey = (name) => String(name ?? '').trim().toLowerCase();

// ---- Poisson CDF / PMF helpers ----
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

// ---- collect resolved events ----
// odds-db outcomes are a flat map keyed by "marketId|name".
const events = [];
for (const ev of Object.values(db.events ?? {})) {
  if (!ev.finalScore) continue;
  const score = parseScore(ev.finalScore);
  if (!score) continue;
  const ou = [];
  const mg = [];
  for (const [key, o] of Object.entries(ev.outcomes ?? {})) {
    const marketId = key.split('|')[0];
    const odds = o.plays?.at(-1)?.odds;
    if (!odds || odds <= 1) continue;
    if (marketId === '18') ou.push({ name: o.name, odds });
    else if (marketId === '548') mg.push({ name: o.name, odds });
  }
  if (!ou.length && !mg.length) continue;
  events.push({
    home: tkey(ev.homeTeam),
    away: tkey(ev.awayTeam),
    league: lkey(ev.tournament),
    t: Date.parse(ev.startTime),
    hg: score.home,
    ag: score.away,
    total: score.home + score.away,
    score: ev.finalScore,
    ou,
    mg,
  });
}
events.sort((a, b) => a.t - b.t);
console.log(`resolved events with O/U or Multigoals: ${events.length}`);

// ---- Poisson attack/defense model ----
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
      // gradients (NLL w.r.t params)
      const gAh = lH - r.hg, gBa = r.hg - lH;
      const gAa = lA - r.ag, gBh = r.ag - lA;
      att.set(r.home, ah - lr * (gAh + lambda * ah));
      def.set(r.home, bh - lr * (gBh + lambda * bh));
      att.set(r.away, aa - lr * (gAa + lambda * aa));
      def.set(r.away, ba - lr * (gBa + lambda * ba));
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
  const lH = Math.exp(ah - ba + model.h);
  const lA = Math.exp(aa - bh);
  return lH + lA;
}

// ---- per-template Platt calibration ----
function fitPlatt(pairs) {
  let a = 1, b = 0;
  const lr = 0.1;
  for (let e = 0; e < 300; e++) {
    let ga = 0, gb = 0;
    for (const { p, y } of pairs) {
      const pc = Math.min(1 - 1e-6, Math.max(1e-6, p));
      const logit = Math.log(pc / (1 - pc));
      const z = a * logit + b;
      const sig = 1 / (1 + Math.exp(-z));
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

// ---- probability of each O/U / Multigoals outcome from expected total ----
function ouProbs(total, name) {
  const m = /^Over\s+(\d+(?:\.\d+)?)$/.exec(name) || /^Under\s+(\d+(?:\.\d+)?)$/.exec(name);
  if (!m) return null;
  const isOver = /^Over/.test(name);
  const line = parseFloat(m[1]);
  const cdf = poissonCdf(total, Math.floor(line - 1e-9));
  if (isOver) return 1 - cdf; // P(total > line)
  return cdf; // P(total < line)
}
function mgProbs(total, name) {
  if (/^No goal$/i.test(name)) return poissonPmf(total, 0);
  const plus = /^(\d+)\+$/.exec(name);
  if (plus) {
    const x = parseInt(plus[1], 10);
    return 1 - poissonCdf(total, x - 1);
  }
  const rng = /^(\d+)-(\d+)$/.exec(name);
  if (rng) {
    const lo = parseInt(rng[1], 10), hi = parseInt(rng[2], 10);
    return poissonCdf(total, hi) - poissonCdf(total, lo - 1);
  }
  return null;
}
function templateOf(market, name) {
  if (market === 'ou') return /^Over/.test(name) ? 'OU_Over' : 'OU_Under';
  if (/^No goal$/i.test(name)) return 'MG_nogoal';
  if (/\+$/.test(name)) return 'MG_plus';
  return 'MG_range';
}

// ---- walk-forward evaluation ----
const initTrain = Math.min(200, Math.floor(events.length * 0.3));
const block = 20;
const bets = [];
const byMarket = { ou: [], mg: [] };

for (let i = 0; i < events.length; i++) {
  if (i < initTrain) continue;
  const trainEvents = events.slice(0, i);
  const model = trainPoisson(trainEvents);

  // build calibration pairs from the training slice (using this model)
  const pairsByTpl = {};
  for (const e of trainEvents) {
    const lam = expectedTotal(model, e);
    for (const o of e.ou) {
      const p = ouProbs(lam, o.name);
      if (p == null) continue;
      const tpl = templateOf('ou', o.name);
      (pairsByTpl[tpl] ||= []).push({ p, y: evaluateOutcome('18', o.name, parseScore(e.score)) === 'WON' ? 1 : 0 });
    }
    for (const o of e.mg) {
      const p = mgProbs(lam, o.name);
      if (p == null) continue;
      const tpl = templateOf('mg', o.name);
      (pairsByTpl[tpl] ||= []).push({ p, y: evaluateOutcome('548', o.name, parseScore(e.score)) === 'WON' ? 1 : 0 });
    }
  }
  const platt = {};
  for (const tpl of Object.keys(pairsByTpl)) platt[tpl] = fitPlatt(pairsByTpl[tpl]);

  // bet on event i
  const r = events[i];
  const lam = expectedTotal(model, r);
  const consider = (market, name, odds) => {
    const raw = market === 'ou' ? ouProbs(lam, name) : mgProbs(lam, name);
    if (raw == null) return;
    const tpl = templateOf(market, name);
    const p = platt[tpl] ? applyPlatt(platt[tpl], raw) : raw;
    const ev = p * odds - 1;
    if (ev > MIN_EDGE) {
      const res = evaluateOutcome(market === 'ou' ? '18' : '548', name, parseScore(r.score));
      const won = res === 'WON';
      const pnl = res === 'VOID' ? 0 : won ? odds - 1 : -1;
      bets.push({ market, p, odds, won, pnl });
      byMarket[market].push({ p, odds, won, pnl });
    }
  };
  for (const o of r.ou) consider('ou', o.name, o.odds);
  for (const o of r.mg) consider('mg', o.name, o.odds);
}

function summarize(rows, label) {
  const n = rows.length;
  const won = rows.filter((b) => b.won).length;
  const pnl = rows.reduce((s, b) => s + b.pnl, 0);
  const roi = n ? pnl / n : 0;
  console.log(`${label}: bets=${n} won=${won} winrate=${n ? ((won / n) * 100).toFixed(1) : '0'}% P&L=${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)} ROI=${(roi * 100).toFixed(1)}%`);
  return roi;
}

console.log('\n=== v3 (O/U + Multigoals, Poisson + Platt) ===');
const roiOU = summarize(byMarket.ou, 'O/U');
const roiMG = summarize(byMarket.mg, 'Multigoals');
const roiAll = summarize(bets, 'COMBINED');
console.log(`\nbookmaker margin hurdle: -${(MARGIN * 100).toFixed(1)}%`);
console.log(`verdict: ${roiAll > -MARGIN ? 'BEATS MARGIN' : 'below margin'} (combined ROI ${(roiAll * 100).toFixed(1)}%)`);
console.log(`(recap 1X2: v1 -20.9% | v2b -10.8%)`);
