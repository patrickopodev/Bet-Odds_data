// Option 3 v5 - FAVORITE BIAS refinement (odds bands, leagues, bootstrap CI).
// v4: "bet 1X2 favorite" ~ -0.2% ROI (break-even). Refine to find a SIGNIFICANT edge.
import fs from 'node:fs';
import { DB_FILE, parseScore, evaluateOutcome } from './lib/common.mjs';

const MARGIN = 0.077;
const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
const events = [];
for (const ev of Object.values(db.events ?? {})) {
  if (!ev.finalScore) continue;
  const score = parseScore(ev.finalScore);
  if (!score) continue;
  const sides = ['Home', 'Draw', 'Away'].map((name) => {
    const p = ev.outcomes[`1|${name}`]?.plays ?? [];
    return p.length ? { name, last: p.at(-1).odds } : null;
  }).filter(Boolean);
  if (sides.length < 3) continue;
  sides.sort((a, b) => a.last - b.last);
  const fav = sides[0];
  const r = evaluateOutcome('1', fav.name, score);
  const pnl = r === 'VOID' ? 0 : r === 'WON' ? fav.last - 1 : -1;
  events.push({ favLast: fav.last, league: String(ev.tournament ?? '').trim(), pnl, won: pnl > 0 });
}
console.log(`resolved 1X2 events: ${events.length}`);

function ci(pnls, B = 2000) {
  const n = pnls.length;
  if (!n) return [0, 0];
  const rois = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += pnls[(Math.random() * n) | 0];
    rois.push(s / n);
  }
  rois.sort((a, b) => a - b);
  return [rois[Math.floor(B * 0.025)], rois[Math.floor(B * 0.975)]];
}

function report(label, rows) {
  const n = rows.length;
  const won = rows.filter((r) => r.won).length;
  const pnl = rows.map((r) => r.pnl);
  const roi = n ? pnl.reduce((a, b) => a + b, 0) / n : 0;
  const [lo, hi] = ci(pnl);
  const sig = lo > 0 ? '  *** SIGNIFICANTLY POSITIVE ***' : '';
  console.log(`${label.padEnd(28)} n=${String(n).padStart(4)} win=${(n ? (won / n) * 100 : 0).toFixed(0)}% ROI=${(roi * 100).toFixed(1).padStart(5)}% CI=[${(lo * 100).toFixed(1)}%,${(hi * 100).toFixed(1)}%]${sig}`);
}

console.log('\n=== BASELINE: all favorites ===');
report('ALL favorites', events);

console.log('\n=== ODDS BANDS (favorite last odds) ===');
const bands = [[1.0, 1.3], [1.3, 1.5], [1.5, 1.8], [1.8, 2.2], [2.2, 3.0], [1.2, 2.0]];
for (const [lo, hi] of bands) {
  report(`fav odds [${lo},${hi})`, events.filter((e) => e.favLast >= lo && e.favLast < hi));
}

console.log('\n=== TOP LEAGUES by sample (>=20) ===');
const byLeague = {};
for (const e of events) (byLeague[e.league] ||= []).push(e);
Object.entries(byLeague)
  .filter(([, v]) => v.length >= 20)
  .sort((a, b) => b[1].length - a[1].length)
  .forEach(([lg, v]) => report(lg.slice(0, 24), v));

console.log(`\nbookmaker margin: -${(MARGIN * 100).toFixed(1)}% (ROI>0 with CI low>0 = real edge)`);
