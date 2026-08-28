import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './lib/common.mjs';
import { frozenFavBand } from './lib/favband.mjs';

// ---------------------------------------------------------------------------
// Paper-trade progress dashboard.
//
// Reads ONLY data/paper-picks.json — the 1X2 favorite-value (FAV_BAND) track
// logged by `train-model-v5b.mjs --paper`. It is deliberately kept separate
// from the correct-score analyzer (analyze-correctscore.mjs / market 41): that
// signal has no forward samples yet and must not contaminate this qualification
// track.
//
// This script is READ-ONLY: it never writes paper-picks.json, and it does not
// touch selection, settlement, or the 30-resolved + positive-ROI gate. It only
// measures. The band shown is read from FAV_BAND_LO/HI env (the deployed band).
// ---------------------------------------------------------------------------

const REQUIRED_RESOLVED = 30;
const RESOLVED = new Set(['won', 'lost', 'push', 'settled', 'void', 'WON', 'LOST', 'VOID']);
const DAY_MS = 24 * 60 * 60 * 1000;
const LABEL = 14;

function loadPicks() {
  try {
    const raw = readFileSync(path.join(DATA_DIR, 'paper-picks.json'), 'utf8');
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : p.picks ?? [];
  } catch {
    return [];
  }
}

function line(label, value) {
  return label.padEnd(LABEL) + value;
}

function main() {
  const picks = loadPicks();
  const resolved = picks.filter((p) => RESOLVED.has((p.status ?? '').toUpperCase()));
  const pending = picks.length - resolved.length;

  // Selection frequency: how many picks the (possibly widened) band produced
  // in the last 24h. Derived read-only from addedAt timestamps.
  const cutoff = Date.now() - DAY_MS;
  const added24h = picks.filter((p) => {
    const t = Date.parse(p.addedAt);
    return Number.isFinite(t) && t >= cutoff;
  }).length;

  let roi = null;
  if (resolved.length) {
    let profit = 0;
    for (const p of resolved) {
      const st = (p.status ?? '').toUpperCase();
      const o = Number(p.odds);
      if (st === 'WON') profit += o - 1;
      else if (st === 'LOST') profit -= 1;
      else if (st === 'PUSH' || st === 'VOID') profit += 0;
    }
    roi = (profit / resolved.length) * 100;
  }

  const { lo, hi } = frozenFavBand();
  const band = `[${lo}, ${hi})`;
  const auto = process.env.STAKE_AUTOPLACE_ENABLED === 'true' ? 'ENABLED' : 'OFF';

  const roiStr = roi == null ? 'N/A' : `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;

  const bar = '─'.repeat(34);
  console.log(bar);
  console.log('PAPER-TRADE PROGRESS');
  console.log(bar);
  console.log(line('Resolved', `${resolved.length} / ${REQUIRED_RESOLVED}`));
  console.log(line('Pending', `${pending}`));
  console.log(line('Picks added', `${added24h} / 24h`));
  console.log(line('ROI', roiStr));
  console.log(line('Band', band));
  console.log(line('Auto-staking', auto));
  console.log(bar);
}

main();
