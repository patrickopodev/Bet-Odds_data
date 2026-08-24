import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './lib/common.mjs';

// ---------------------------------------------------------------------------
// Paper-trade progress dashboard.
//
// Reads ONLY data/paper-picks.json — the 1X2 favorite-value (FAV_BAND) track
// logged by `train-model-v5b.mjs --paper`. It is deliberately kept separate
// from the correct-score analyzer (analyze-correctscore.mjs / market 41): that
// signal has no forward samples yet and must not contaminate this
// qualification track. Reports the 30-resolved + positive-ROI gate but NEVER
// enables staking — reaching the gate only marks the track ELIGIBLE FOR HUMAN
// REVIEW. Enabling auto-staking (STAKE_AUTOPLACE_ENABLED) is a deliberate
// human action.
// ---------------------------------------------------------------------------

const REQUIRED_RESOLVED = 30;
const RESOLVED = new Set(['won', 'lost', 'push', 'settled', 'void']);
const BOX = '━'.repeat(36);

function loadPicks() {
  try {
    const raw = readFileSync(path.join(DATA_DIR, 'paper-picks.json'), 'utf8');
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p : p.picks ?? [];
  } catch {
    return [];
  }
}

function main() {
  const picks = loadPicks();
  const resolved = picks.filter((p) => RESOLVED.has((p.status ?? '').toLowerCase()));
  const pending = picks.length - resolved.length;

  let roi = null;
  if (resolved.length) {
    let profit = 0;
    for (const p of resolved) {
      const st = (p.status ?? '').toLowerCase();
      const o = Number(p.odds);
      if (st === 'won') profit += o - 1;
      else if (st === 'lost') profit -= 1;
      else if (st === 'push' || st === 'void') profit += 0;
    }
    roi = (profit / resolved.length) * 100;
  }

  const positiveRoi = roi != null && roi > 0;
  const eligible = resolved.length >= REQUIRED_RESOLVED && positiveRoi;
  const auto = process.env.STAKE_AUTOPLACE_ENABLED === 'true' ? 'ENABLED' : 'DISABLED';

  let requirement;
  if (eligible) requirement = 'MET — ELIGIBLE FOR HUMAN REVIEW';
  else if (resolved.length < REQUIRED_RESOLVED) requirement = `NOT MET — need ${REQUIRED_RESOLVED - resolved.length} more resolved`;
  else requirement = 'NOT MET — need positive ROI';

  const roiStr = roi == null ? 'N/A' : `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;

  console.log(BOX + ' PAPER-TRADE PROGRESS ' + BOX);
  console.log(`Resolved picks : ${resolved.length} / ${REQUIRED_RESOLVED}`);
  console.log(`Pending picks  : ${pending}`);
  console.log(`ROI (1u/pick)  : ${roiStr}`);
  console.log(`Requirement    : ${requirement}`);
  console.log(`Auto-staking   : ${auto}`);
  console.log(BOX.repeat(1) + '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
}

main();
