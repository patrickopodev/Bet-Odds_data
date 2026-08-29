// Option 3 v5b - OUT-OF-SAMPLE validation of the favorite-value edge + PAPER TRADE mode.
// The live paper band is the FROZEN validated band [1.8, 2.2) from the strategy
// registry (lib/1x2.mjs). No env override — a validated band must not be
// silently widened, even in this research/validation tool (review action #1).
// To experiment, edit the BANDS array or the FIXED literal intentionally.
// Validates the v5 discovery WITHOUT leakage: band is chosen on train, bet on held-out test.
// Modes: (default) validation; --paper = log future picks (no stake); --score-paper = settle them.
import fs from 'node:fs';
import { DB_FILE, parseScore, evaluateOutcome } from './lib/common.mjs';
import { roi, ci } from './lib/settlement.mjs';
import { buildFavRows, select1X2Picks, frozen1X2 } from './lib/1x2.mjs';

const MARGIN = 0.077;
const BANDS = [[1.0, 1.3], [1.3, 1.5], [1.5, 1.8], [1.8, 2.2], [2.2, 3.0]];
const PAPER_FILE = 'data/paper-picks.json';
// Live paper band: the frozen validated band (no env widening).
const { lo: BAND_LO, hi: BAND_HI } = frozen1X2();
const FIXED = [BAND_LO, BAND_HI]; // live paper band

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rng() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function bestBand(train) {
  let best = null, bestR = -Infinity;
  for (const [lo, hi] of BANDS) {
    const p = train.filter((e) => e.favLast >= lo && e.favLast < hi).map((e) => e.pnl);
    if (p.length >= 30 && roi(p) > bestR) { bestR = roi(p); best = [lo, hi]; }
  }
  return best;
}
function inBand(e, b) { return e.favLast >= b[0] && e.favLast < b[1]; }

// ---- load events ----
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const rows = buildFavRows(db);
const resolved = rows.filter((r) => r.resolved);
console.log(`events with 1X2 odds: ${rows.length}, resolved: ${resolved.length}, unresolved (paper-tradeable): ${rows.length - resolved.length}`);

if (!process.argv.includes('--paper') && !process.argv.includes('--score-paper')) {
  // ===== VALIDATION =====
  const rng = mulberry32(12345);
  // 50/50 holdout, both directions
  const sh = shuffle(resolved, rng);
  const mid = Math.floor(sh.length / 2);
  const A = sh.slice(0, mid), B = sh.slice(mid);
  for (const [tr, te, lbl] of [[A, B, 'train=A test=B'], [B, A, 'train=B test=A']]) {
    const band = bestBand(tr) || FIXED;
    const p = te.filter((e) => inBand(e, band)).map((e) => e.pnl);
    const [lo, hi] = ci(p);
    console.log(`[${lbl}] chosen band ${band}: n=${p.length} ROI=${(roi(p) * 100).toFixed(1)}% CI=[${(lo * 100).toFixed(1)}%,${(hi * 100).toFixed(1)}%]`);
  }
  // k-fold (k=5): band re-selected on train each fold
  const k = 5, sh2 = shuffle(resolved, mulberry32(999));
  const foldPnl = [];
  const foldRois = [];
  for (let f = 0; f < k; f++) {
    const te = sh2.filter((_, i) => i % k === f);
    const tr = sh2.filter((_, i) => i % k !== f);
    const band = bestBand(tr) || FIXED;
    const p = te.filter((e) => inBand(e, band)).map((e) => e.pnl);
    foldPnl.push(...p);
    foldRois.push(roi(p));
    console.log(`  fold ${f}: band ${band} n=${p.length} ROI=${(roi(p) * 100).toFixed(1)}%`);
  }
  const [lo, hi] = ci(foldPnl);
  console.log(`K-FOLD OUT-OF-SAMPLE: n=${foldPnl.length} ROI=${(roi(foldPnl) * 100).toFixed(1)}% CI=[${(lo * 100).toFixed(1)}%,${(hi * 100).toFixed(1)}%]`);
  // fixed candidate band on full resolved (reference)
  const fp = resolved.filter((e) => inBand(e, FIXED)).map((e) => e.pnl);
  const [flo, fhi] = ci(fp);
  console.log(`FIXED [${FIXED[0]},${FIXED[1]}) on ALL resolved (in-sample ref): n=${fp.length} ROI=${(roi(fp) * 100).toFixed(1)}% CI=[${(flo * 100).toFixed(1)}%,${(fhi * 100).toFixed(1)}%]`);
}

// ===== PAPER TRADE =====
function loadPaper() {
  try { return JSON.parse(fs.readFileSync(PAPER_FILE, 'utf8')); } catch { return []; }
}
if (process.argv.includes('--paper') || process.argv.includes('--score-paper')) {
  const paper = loadPaper();
  const seen = new Set(paper.map((p) => p.id));
  if (process.argv.includes('--paper')) {
    for (const e of select1X2Picks(rows, FIXED[0], FIXED[1])) {
      if (seen.has(e.id)) continue;
      paper.push({ id: e.id, league: e.league, pick: e.favName, odds: e.favLast, addedAt: new Date().toISOString(), status: 'OPEN' });
      seen.add(e.id);
    }
    fs.writeFileSync(PAPER_FILE, JSON.stringify(paper, null, 2));
  }
  // score any paper picks whose events are now resolved
  const byId = new Map(rows.map((r) => [r.id, r]));
  let scored = 0, pnls = [];
  for (const p of paper) {
    if (p.status === 'OPEN' && byId.has(p.id)) {
      const r = byId.get(p.id);
      if (r.resolved) {
        p.status = r.pnl > 0 ? 'WON' : (r.pnl < 0 ? 'LOST' : 'VOID');
        p.pnl = r.pnl;
        scored++;
      }
    }
    if (p.status === 'WON' || p.status === 'LOST' || p.status === 'VOID') pnls.push(p.pnl);
  }
  fs.writeFileSync(PAPER_FILE, JSON.stringify(paper, null, 2));
  const [lo, hi] = ci(pnls);
  console.log(`PAPER picks total=${paper.length} resolved-so-far=${pnls.length} ROI=${pnls.length ? (roi(pnls) * 100).toFixed(1) : '0'}% CI=[${(lo * 100).toFixed(1)}%,${(hi * 100).toFixed(1)}%]`);
  console.log(`  -> ${paper.filter((p) => p.status === 'OPEN').length} still open (awaiting results). File: ${PAPER_FILE}`);
}
