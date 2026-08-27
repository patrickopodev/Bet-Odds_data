// ---------------------------------------------------------------------------
// STAGE 1.5b — PRE-SPECIFIED O/U band holdout (read-only).
//
// Discipline (per the user's rule): the hypotheses below are defined BEFORE any
// evaluation and FROZEN. They are NOT chosen because they maximize historical
// ROI, and the TEST leg is never examined while defining them. This is the
// opposite of mine-ou-backtest.mjs (which mined buckets from data and then
// found they were in-sample noise).
//
// Each hypothesis pins a SPECIFIC O/U line + side + odds band, because O/U has
// many lines (1.5/2.5/3.5/...) unlike 1X2 — copying [1.5,2.2) blindly would be
// wrong. The band is chosen from domain reasoning about O/U structure.
//
// Pipeline:
//   chronological split of resolved O/U bets
//     train (old)  -> estimate performance   (seen during research)
//     test  (new)  -> untouched evaluation    (the verdict)
//   survival = test settled >= MIN_TEST AND test ROI > 0
//
// Strategy A (1X2 FAV_BAND) is NEVER touched by this file. O/U is an
// independent hypothesis. If no hypothesis survives, O/U stays research-only.
//
// DO NOT EDIT HYPOTHESES after seeing results. That would recreate the
// overfitting this experiment is designed to avoid.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadDb, parseScore, evaluateOutcome } from './lib/common.mjs';

const TRAIN_FRAC = 0.6;
const MIN_TEST = 20; // min settled in holdout to treat a verdict as real
const OU = '18';

// --- FROZEN, PRE-SPECIFIED HYPOTHESES (do not tune to results) ---------------
const HYPOTHESES = [
  {
    id: 'H1',
    label: '2.5-line favorite side',
    line: 2.5,
    side: 'either',
    lo: 1.8,
    hi: 2.2,
    rationale: 'Direct analog of the validated 1X2 favorite band on football’s standard 2.5 liquidity line.',
  },
  {
    id: 'H2',
    label: '3.5-line Overs',
    line: 3.5,
    side: 'Over',
    lo: 1.7,
    hi: 2.1,
    rationale: 'A different, higher-scoring line’s Over favorite — a separate structural hypothesis.',
  },
  {
    id: 'H3',
    label: '1.5-line Unders',
    line: 1.5,
    side: 'Under',
    lo: 1.6,
    hi: 2.0,
    rationale: 'The low-scoring tail, probing a different corner of the O/U space.',
  },
];
// ---------------------------------------------------------------------------

function roi(b) {
  const staked = b.won + b.lost;
  return staked ? (b.won * (b.odds - 1) - b.lost) / staked : null;
}
function implied(b) {
  return 1 / b.odds;
}
function edge(b) {
  const o = b.settled ? b.won / b.settled : null;
  return o == null ? null : o - implied(b);
}

// Flat list of every resolved O/U "bet" (one per distinct odds per match), with
// its line/side parsed and its result, tagged by match startTime.
function ouBets(db) {
  const bets = [];
  for (const ev of Object.values(db.events ?? {})) {
    const score = ev.finalScore ? parseScore(ev.finalScore) : null;
    if (!score) continue;
    const ou = Object.values(ev.outcomes ?? {}).filter((o) => o.marketId === OU);
    if (!ou.length) continue;
    const sib = ou.map((o) => o.name);
    const evaluated = new Map();
    for (const o of ou) {
      const r = evaluateOutcome(OU, o.name, score, sib);
      if (r) evaluated.set(o.name, r);
    }
    const seen = new Set();
    for (const o of ou) {
      const res = evaluated.get(o.name);
      if (!res) continue;
      for (const p of o.plays ?? []) {
        const key = `${o.name}|${p.odds}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const m = o.name.match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
        if (!m) continue;
        bets.push({
          line: parseFloat(m[2]),
          side: m[1],
          odds: p.odds,
          result: res,
          startTime: ev.startTime,
        });
      }
    }
  }
  return bets;
}

function matches(h, bet) {
  if (h.side !== 'either' && bet.side !== h.side) return false;
  if (h.line != null && bet.line !== h.line) return false;
  return bet.odds >= h.lo && bet.odds < h.hi;
}

function aggregate(bets) {
  let won = 0,
    lost = 0,
    settled = 0,
    profit = 0,
    oddsSum = 0;
  for (const b of bets) {
    if (b.result === 'WON') won++;
    else if (b.result === 'LOST') lost++;
    if (b.result === 'WON' || b.result === 'LOST') {
      settled++;
      profit += b.result === 'WON' ? b.odds - 1 : -1;
      oddsSum += b.odds;
    }
  }
  const staked = won + lost;
  return {
    n: settled,
    won,
    lost,
    roi: staked ? profit / staked : null,
    edge: settled ? won / settled - 1 / (oddsSum / settled) : null,
    avgOdds: settled ? oddsSum / settled : null,
  };
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
function r2(x) {
  return x == null ? 'n/a' : Number(x).toFixed(2);
}

async function run() {
  const db = await loadDb();
  const bets = ouBets(db).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
  const cut = Math.floor(bets.length * TRAIN_FRAC);
  const train = bets.slice(0, cut);
  const test = bets.slice(cut);

  const lines = [];
  lines.push('# Stage 1.5b — Pre-specified O/U Band Holdout', '');
  lines.push(`_Generated ${new Date().toISOString()} UTC_`, '');
  lines.push(
    'Hypotheses were defined BEFORE evaluation and frozen (see HYPOTHESES in the script). They are ' +
      'NOT optimized on any ROI. The TEST leg below is untouched by hypothesis design. Strategy A ' +
      '(1X2 FAV_BAND) is independent and not modified.',
    ''
  );
  lines.push(`Resolved O/U bets: ${bets.length} (${train.length} train / ${test.length} test).`, '');

  lines.push('## Hypotheses (frozen)', '');
  for (const h of HYPOTHESES) {
    lines.push(`- **${h.id} — ${h.label}**: line ${h.line}, side ${h.side}, odds [${h.lo}, ${h.hi}) — ${h.rationale}`);
  }
  lines.push('');

  lines.push('## Train (estimation) vs Test (holdout)', '');
  lines.push('| Hyp | Train n | Train ROI | Train edge | Test n | Test ROI | Test edge | Survives? |');
  lines.push('|---|---|---|---|---|---|---|---|');

  let survivors = 0;
  for (const h of HYPOTHESES) {
    const tr = aggregate(train.filter((b) => matches(h, b)));
    const te = aggregate(test.filter((b) => matches(h, b)));
    const survives = te.n >= MIN_TEST && (te.roi ?? -1) > 0;
    if (survives) survivors++;
    lines.push(
      `| ${h.id} | ${tr.n} | ${pct(tr.roi)} | ${r2(tr.edge)} | ${te.n} | ${pct(te.roi)} | ${r2(te.edge)} | ` +
        `${survives ? '✅ YES' : 'no'} |`
    );
  }
  lines.push('');
  lines.push(
    `Survival rule: test settled >= ${MIN_TEST} AND test ROI > 0. ` +
      `(edge = observed win rate − implied probability 1/avgOdds.)`,
    ''
  );

  lines.push('## Verdict', '');
  if (survivors > 0) {
    lines.push(
      `✅ ${survivors} O/U hypothesis/hypotheses survived the untouched holdout → candidate(s) for a ` +
        'Stage 2 forward paper track (paper-B) with its own 30-resolved-pick gate. Strategy A is ' +
        'unchanged.',
      ''
    );
  } else {
    lines.push(
      '⚠️ No pre-specified O/U hypothesis survived the untouched holdout. O/U stays RESEARCH-ONLY. ' +
        'Do not create paper-B. The 1X2 FAV_BAND remains the only validated edge — and this negative ' +
        'result reinforces that it is a genuine, pre-specified signal, not a mined artifact.',
      ''
    );
  }

  const out = path.join(DATA_DIR, 'ou-band-backtest.md');
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(out, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log(`\nWrote ${out}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error(`ou-band-backtest failed: ${e.message}`);
    process.exit(1);
  });
}

export { ouBets, matches, aggregate, HYPOTHESES };
