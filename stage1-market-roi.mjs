// ---------------------------------------------------------------------------
// STAGE 1 — read-only per-market historical ROI report.
//
// Answers (before writing any new selector):
//   "Among the four currently-unvalidated markets, does the existing
//    historical data show enough evidence to justify a 30-pick forward
//    paper track?"
//
// Methodology is the SAME one analyze-odds.mjs uses: aggregateHistoricalStats
// in lib/common.mjs counts each distinct (market, outcome, odds) once per
// match against the match's resolved finalScore. We roll those up per raw
// SportyBet market id (1, 18, 41, 548, 551) so the five feeds are compared
// on identical footing.
//
// A 1X2 FAV_BAND [1.8,2.2) sanity check is included: it must reproduce the
// known ~+16.8% OOS edge (train-model-v5b.mjs). If it does, the rest of the
// report is trustworthy; if it doesn't, the methodology is broken — fix first.
//
// classify() returns one of INSUFFICIENT EVIDENCE / NEGATIVE HISTORICAL EDGE /
// CANDIDATE FOR STAGE 2 — a Stage 1 *screen*, never a validation. A market only
// graduates after its own forward paper track (Stage 2) shows 30+ resolved
// picks with positive ROI.
//
// This script writes NOTHING to the DB and never selects a bet. It only reads.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadDb, aggregateHistoricalStats } from './lib/common.mjs';
import { buildFavRows } from './lib/favband.mjs';

const MARKETS = {
  '1': '1X2',
  '18': 'O/U',
  '41': 'Correct Score',
  '548': 'Multigoals',
  '551': 'Multiscores',
};

// Minimum resolved samples before a market is worth defining a forward
// 30-pick paper track for. Below this it is INSUFFICIENT EVIDENCE.
const MIN_SAMPLE = 30;

// FAV_BAND control bounds (the validated backtest band, NOT the widened live
// [1.5,2.2) — we want to reproduce the published edge here).
const FAV_BAND_LO = 1.8;
const FAV_BAND_HI = 2.2;

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
function money(x) {
  return `${(x >= 0 ? '+' : '')}${x.toFixed(2)}`;
}
function r2(x) {
  return Number(x).toFixed(2);
}

function naiveMarketRollup(all) {
  const rows = [];
  for (const [id, label] of Object.entries(MARKETS)) {
    const recs = all.filter((r) => String(r.marketId) === id && r.settled > 0);
    const settled = recs.reduce((a, r) => a + r.settled, 0);
    const won = recs.reduce((a, r) => a + r.won, 0);
    const lost = recs.reduce((a, r) => a + r.lost, 0);
    const voids = recs.reduce((a, r) => a + r.void, 0);
    const staked = won + lost; // voids return stake, no P&L
    const profit = recs.reduce((a, r) => a + r.won * (r.odds - 1) - r.lost, 0);
    const avgOdds = settled ? recs.reduce((a, r) => a + r.odds * r.settled, 0) / settled : null;
    rows.push({
      id,
      label,
      resolved: settled,
      won,
      lost,
      voids,
      winRate: staked ? won / staked : null,
      roi: staked ? profit / staked : null,
      avgOdds,
      profit,
      // Good-odds buckets (settled>=3, always won) in this market — a hint of
      // where structural edges might hide. NOT a strategy; informational only.
      goodBuckets: recs.filter((r) => r.settled >= 3 && r.lost === 0 && r.won === r.settled).length,
    });
  }
  return rows;
}

function favBandSanityCheck(db) {
  const rows = buildFavRows(db).filter((r) => r.resolved);
  const band = rows.filter((r) => r.favLast >= FAV_BAND_LO && r.favLast < FAV_BAND_HI);
  const pnl = band.reduce((a, r) => a + r.pnl, 0);
  return {
    totalResolved: rows.length,
    bandCount: band.length,
    bandRoi: band.length ? pnl / band.length : null,
    bandPnl: pnl,
  };
}

// Stage 1 SCREENING verdict — explicitly NOT a validation. (Validation is
// Stage 2: a forward paper track of >=30 resolved picks with positive ROI.)
//   resolved < MIN_SAMPLE          -> INSUFFICIENT EVIDENCE (too few resolved
//                                     observations to even start a test)
//   resolved >= MIN_SAMPLE, ROI<=0 -> NEGATIVE HISTORICAL EDGE (enough history,
//                                     but naive all-selection ROI is not
//                                     positive — any edge must be isolated by a
//                                     defined strategy before a forward test)
//   resolved >= MIN_SAMPLE, ROI>0  -> CANDIDATE FOR STAGE 2 (enough history AND
//                                     a positive naive screen; still NOT
//                                     validated — requires its own forward
//                                     30-pick paper track with positive ROI)
function classify(row) {
  if (row.resolved < MIN_SAMPLE) return 'INSUFFICIENT EVIDENCE';
  if (row.roi == null || row.roi <= 0) return 'NEGATIVE HISTORICAL EDGE';
  return 'CANDIDATE FOR STAGE 2';
}

async function run() {
  const db = await loadDb();
  const all = aggregateHistoricalStats(db);
  const rollup = naiveMarketRollup(all);
  const sanity = favBandSanityCheck(db);

  const lines = [];
  lines.push('# Stage 1 — Per-Market Historical ROI (read-only)', '');
  lines.push(`_Generated ${new Date().toISOString()} UTC_`, '');
  lines.push(
    'Methodology: identical to analyze-odds.mjs (aggregateHistoricalStats). Each distinct ' +
      '(market, outcome, odds) is counted once per resolved match. Naive ROI = bet every settled ' +
      'selection at its recorded odds, 1 unit each; voids return stake.',
    ''
  );

  // --- Sanity check ---
  lines.push('## Control check: 1X2 FAV_BAND [' + FAV_BAND_LO + ',' + FAV_BAND_HI + ')', '');
  lines.push(
    `Resolved 1X2 favorites: ${sanity.totalResolved} | in-band: ${sanity.bandCount} | ` +
      `band ROI: ${pct(sanity.bandRoi)} (pnl ${money(sanity.bandPnl)})`
  );
  if (sanity.bandRoi != null && sanity.bandRoi > 0.1) {
    lines.push('✅ Reproduces the known ~+16.8% OOS edge → report methodology is sound.', '');
  } else {
    lines.push('⚠️ Did NOT reproduce the expected edge — verify methodology before trusting the rest.', '');
  }
  lines.push('');

  // --- The five-market table ---
  lines.push('## Per-market historical rollup', '');
  lines.push('| Market | Resolved samples | Wins | Losses | Voids | Win rate | Avg odds | Profit | ROI | Good-odds buckets |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const row of rollup) {
    lines.push(
      `| ${row.label} | ${row.resolved} | ${row.won} | ${row.lost} | ${row.voids} | ` +
        `${pct(row.winRate)} | ${row.avgOdds == null ? 'n/a' : r2(row.avgOdds)} | ` +
        `${money(row.profit)} | ${pct(row.roi)} | ${row.goodBuckets} |`
    );
  }
  lines.push('');
  lines.push(
    '> **Reading the ROI column:** a negative naive ROI for every market is EXPECTED — the house ' +
      'margin (~7.7%) guarantees it when you bet blindly. This column is a baseline, not a verdict. ' +
      'The decisive columns are **Resolved samples** (can we even run a 30-pick forward test?) and ' +
      '**Good-odds buckets** (where might a real, isolated edge hide?).',
    ''
  );

  // --- Classification ---
  lines.push('## Classification', '');
  lines.push('| Market | Resolved samples | Classification |', '');
  lines.push('|---|---|---|');
  for (const row of rollup) {
    const cls = row.id === '1' ? 'VALIDATED CONTROL (Strategy A)' : classify(row);
    lines.push(`| ${row.label} | ${row.resolved} | ${cls} |`);
  }
  lines.push('');
  lines.push(
    'Stage 1 is **historical screening only** — it never validates a market. Verdicts: ' +
      '`INSUFFICIENT EVIDENCE` (< ' + MIN_SAMPLE + ' resolved samples); ' +
      '`NEGATIVE HISTORICAL EDGE` (enough samples but naive all-selection ROI is not positive — ' +
      'any edge must be isolated by a defined strategy before a forward test); ' +
      '`CANDIDATE FOR STAGE 2` (enough samples AND a positive naive screen). ' +
      '1X2 is the `VALIDATED CONTROL` from train-model-v5b.mjs. Nothing here is auto-promoted.',
    ''
  );
  lines.push('## Suggested next step', '');
  const candidates = rollup.filter((r) => r.id !== '1' && classify(r) === 'CANDIDATE FOR STAGE 2');
  const negative = rollup.filter((r) => r.id !== '1' && classify(r) === 'NEGATIVE HISTORICAL EDGE');
  const thin = rollup.filter((r) => r.id !== '1' && classify(r) === 'INSUFFICIENT EVIDENCE');
  if (candidates.length) {
    lines.push(
      'Markets clearing the Stage 1 screen (candidates for a forward paper track): ' +
        candidates.map((c) => c.label).join(', ') + '.',
      ''
    );
    lines.push(
      'For each, define a selection rule (NOT "bet the best-looking"), seed a paper-B..E ledger, ' +
        'and run it quarantined from Strategy A. Promotion into the multi-market selector requires ' +
        'its own 30+ resolved forward picks showing positive ROI — a Stage 1 positive screen is NOT ' +
        'validation.',
      ''
    );
  } else {
    lines.push('No non-1X2 market cleared the Stage 1 naive screen.', '');
  }
  if (negative.length) {
    lines.push(
      'Negative naive edge (would need an isolating strategy before a forward track): ' +
        negative.map((c) => `${c.label} (${c.resolved} samples, ROI ${pct(c.roi)})`).join(', ') + '.',
      ''
    );
  }
  if (thin.length) {
    lines.push(
      'Insufficient evidence (keep collecting): ' +
        thin.map((c) => `${c.label} (${c.resolved} samples)`).join(', ') + '.',
      ''
    );
  }

  const out = path.join(DATA_DIR, 'stage1-market-roi.md');
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(out, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log(`\nWrote ${out}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error(`stage1 failed: ${e.message}`);
    process.exit(1);
  });
}

export { naiveMarketRollup, favBandSanityCheck, classify };
