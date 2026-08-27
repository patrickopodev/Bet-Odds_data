// ---------------------------------------------------------------------------
// STAGE 1.5 — O/U candidate miner + OUT-OF-SAMPLE backtest (read-only).
//
// Why this exists: the 67 "always-won" O/U buckets from Stage 1 are IN-SAMPLE
// by construction (they are defined and scored on the same history). Scoring a
// bucket on the data that discovered it is the "find what won, prove it won"
// trap. So we SPLIT CHRONOLOGICALLY:
//
//   older events  -> discover candidate (name, odds) buckets
//   newer events  -> score those EXACT buckets out-of-sample
//
// A bucket only earns attention if it survives on data it never saw during
// discovery. We also run 4 rolling chronological folds to measure consistency:
// a real edge should hold across several time periods, not just one split.
//
// Ranking deliberately does NOT favor 3/3 lucky buckets: candidates are ranked
// by OUT-OF-SAMPLE sample size + ROI + observed-vs-implied edge, so a 47/70 @1.80
// bucket outranks a 3/3 @8.0 one.
//
// This selects NOTHING for staking. It only tells us whether O/U is worth a
// Stage 2 forward paper track (paper-B). Read-only: reads odds-db.json, writes
// a markdown report, never places or selects a bet.
// ---------------------------------------------------------------------------

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadDb, parseScore, evaluateOutcome } from './lib/common.mjs';

const TRAIN_FRAC = 0.6; // oldest 60% used for discovery
const MIN_TRAIN_SAMPLE = 10; // min settled in train to even be a candidate
const MIN_TEST_SAMPLE = 5; // min settled in test for a real out-of-sample read
const FOLDS = 4; // rolling chronological folds for consistency

const OU = '18';

function roi(b) {
  const staked = b.won + b.lost;
  if (!staked) return null;
  return (b.won * (b.odds - 1) - b.lost) / staked;
}
function implied(b) {
  return 1 / b.odds;
}
function observed(b) {
  return b.settled ? b.won / b.settled : null;
}
function edge(b) {
  const o = observed(b);
  return o == null ? null : o - implied(b);
}

// Per-(name,odds) O/U stats over a subset of events, using the SAME
// once-per-match-per-distinct-odds rule as analyze-odds.mjs.
function ouBucketsForEvents(events) {
  const map = new Map();
  for (const ev of events) {
    const score = ev.finalScore ? parseScore(ev.finalScore) : null;
    if (!score) continue;
    const ou = Object.values(ev.outcomes ?? {}).filter((o) => o.marketId === OU);
    if (!ou.length) continue;
    const siblingNames = ou.map((o) => o.name);
    const evaluated = new Map();
    for (const o of ou) {
      const r = evaluateOutcome(OU, o.name, score, siblingNames);
      if (r) evaluated.set(o.name, r);
    }
    const seen = new Set();
    for (const o of ou) {
      const res = evaluated.get(o.name);
      for (const play of o.plays ?? []) {
        const skey = `${o.name}|${play.odds}`;
        if (seen.has(skey)) continue;
        seen.add(skey);
        let s = map.get(skey);
        if (!s) {
          s = { name: o.name, odds: play.odds, won: 0, lost: 0, void: 0, settled: 0, matches: new Set() };
          map.set(skey, s);
        }
        if (res === 'WON') s.won++;
        else if (res === 'LOST') s.lost++;
        else if (res === 'VOID') s.void++;
        if (res) s.settled++;
        s.matches.add(ev.eventId);
      }
    }
  }
  return [...map.values()].map((s) => ({
    name: s.name,
    odds: s.odds,
    won: s.won,
    lost: s.lost,
    void: s.void,
    settled: s.settled,
    matches: s.matches.size,
  }));
}

function resolvedOuEvents(db) {
  return Object.values(db.events ?? {})
    .filter((e) => e.finalScore && Object.values(e.outcomes ?? {}).some((o) => o.marketId === OU))
    .sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
}

function aggregate(records) {
  let won = 0,
    lost = 0,
    settled = 0,
    profit = 0;
  for (const r of records) {
    won += r.won;
    lost += r.lost;
    settled += r.settled;
    if (r.odds != null) profit += r.won * (r.odds - 1) - r.lost;
  }
  const staked = won + lost;
  return { won, lost, settled, staked, profit, roi: staked ? profit / staked : null };
}

function pct(x) {
  return x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}
function r2(x) {
  return x == null ? 'n/a' : Number(x).toFixed(2);
}
function money(x) {
  return `${(x >= 0 ? '+' : '')}${x.toFixed(2)}`;
}

async function run() {
  const db = await loadDb();
  const all = resolvedOuEvents(db);
  const cut = Math.floor(all.length * TRAIN_FRAC);
  const train = all.slice(0, cut);
  const test = all.slice(cut);

  const trainBuckets = ouBucketsForEvents(train);
  const testBuckets = ouBucketsForEvents(test);
  const testMap = new Map(testBuckets.map((b) => [`${b.name}|${b.odds}`, b]));

  // Discover candidates on OLD data only.
  const candidates = trainBuckets.filter((b) => b.settled >= MIN_TRAIN_SAMPLE && roi(b) > 0);

  // Score those EXACT buckets on NEW (held-out) data.
  const tested = [];
  let aggWon = 0,
    aggLost = 0,
    aggProfit = 0,
    aggSettled = 0;
  for (const c of candidates) {
    const t = testMap.get(`${c.name}|${c.odds}`);
    if (!t || t.settled < MIN_TEST_SAMPLE) continue;
    const tr = roi(t);
    tested.push({
      name: c.name,
      odds: c.odds,
      trainSample: c.settled,
      trainRoi: roi(c),
      trainEdge: edge(c),
      testSample: t.settled,
      testRoi: tr,
      testEdge: edge(t),
      implied: implied(c),
    });
    aggWon += t.won;
    aggLost += t.lost;
    aggSettled += t.settled;
    aggProfit += t.won * (t.odds - 1) - t.lost;
  }
  const oos = { won: aggWon, lost: aggLost, settled: aggSettled, staked: aggWon + aggLost, profit: aggProfit, roi: aggSettled ? aggProfit / (aggWon + aggLost) : null };

  // Baseline: naive all-O/U on the SAME test window (what blind betting yields).
  const baseline = aggregate(testBuckets);

  // Rolling folds for consistency.
  const n = all.length;
  const foldSize = Math.floor(n / FOLDS);
  const survival = new Map();
  for (let i = 0; i < FOLDS - 1; i++) {
    const trainEnd = (i + 1) * foldSize;
    const trF = ouBucketsForEvents(all.slice(0, trainEnd));
    const teF = ouBucketsForEvents(all.slice(trainEnd, (i + 2) * foldSize));
    const teMap = new Map(teF.map((b) => [`${b.name}|${b.odds}`, b]));
    const cands = trF.filter((b) => b.settled >= MIN_TRAIN_SAMPLE && roi(b) > 0);
    for (const c of cands) {
      const key = `${c.name}|${c.odds}`;
      const s = survival.get(key) || { appear: 0, survive: 0, trainSample: 0, trainRoi: 0 };
      s.appear++;
      s.trainSample = c.settled;
      s.trainRoi = roi(c);
      const t = teMap.get(key);
      if (t && t.settled >= MIN_TEST_SAMPLE && roi(t) > 0) s.survive++;
      survival.set(key, s);
    }
  }
  const consistent = [...survival.values()].filter((s) => s.appear >= 2 && s.survive >= Math.ceil(s.appear / 2));
  const consistentRate = survival.size ? consistent.length / survival.size : 0;

  // Rank candidates by OUT-OF-SAMPLE robustness: sample first, then ROI.
  tested.sort((a, b) => b.testSample - a.testSample || (b.testRoi ?? -1) - (a.testRoi ?? -1));

  const lines = [];
  lines.push('# Stage 1.5 — O/U Candidate Miner + Out-of-Sample Backtest', '');
  lines.push(`_Generated ${new Date().toISOString()} UTC_`, '');
  lines.push(
    `Method: O/U buckets (market 18) discovered on the OLDEST ${Math.round(TRAIN_FRAC * 100)}% of ` +
      `resolved matches, then scored on the NEWEST ${100 - Math.round(TRAIN_FRAC * 100)}% (held-out). ` +
      `Discovery min sample = ${MIN_TRAIN_SAMPLE} settled, positive train ROI. No bucket is scored on ` +
      `data used to find it. ${FOLDS} rolling chronological folds measure consistency.`,
    ''
  );

  lines.push('## Headline', '');
  lines.push(`Resolved O/U matches: ${all.length} (${train.length} train / ${test.length} test), ` +
    `spanning ${all[0].startTime} → ${all[all.length - 1].startTime}.`);
  lines.push(`Candidate buckets discovered in train: ${candidates.length}`);
  lines.push(`Candidates with enough held-out data to score: ${tested.length}`);
  lines.push('');
  lines.push(
    `**Out-of-sample ROI of discovered candidates:** ${pct(oos.roi)} ` +
      `(${money(oos.profit)} over ${oos.settled} settled on new data).`
  );
  lines.push(
    `**Naive all-O/U baseline on the same new data:** ${pct(baseline.roi)} ` +
      `(blind betting — the house-margin reference).`
  );
  lines.push(
    `**Consistency:** ${consistent.length}/${survival.size} candidate buckets survived out-of-sample ` +
      `in >=half of the ${FOLDS} rolling folds (${pct(consistentRate)}).`
  );
  lines.push('');
  if (oos.roi != null && oos.roi > 0 && oos.settled >= 30 && consistentRate >= 0.25) {
    lines.push('✅ O/U candidates show a POSITIVE, non-trivial out-of-sample edge with some consistency → ' +
      'worth a Stage 2 forward paper track (paper-B) with its own 30-pick gate.', '');
  } else {
    lines.push('⚠️ O/U candidates do NOT clearly survive out-of-sample (edge near/below the margin, or ' +
      'inconsistent across folds). This is the expected "in-sample trap" result — do NOT promote to ' +
      'paper-B yet. Either mine a tighter selection rule or discard O/U as a forward candidate.', '');
  }

  lines.push('', '## Top candidates by OUT-OF-SAMPLE robustness', '');
  lines.push('(ranked by held-out sample size, then held-out ROI — a 3/3 @8.0 bucket cannot outrank a ' +
    '47/70 @1.80 one here)', '');
  lines.push('| O/U | Odds | Train n | Train ROI | Train edge | Test n | Test ROI | Test edge | Implied |', '');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const t of tested.slice(0, 30)) {
    lines.push(
      `| ${t.name} | ${r2(t.odds)} | ${t.trainSample} | ${pct(t.trainRoi)} | ${r2(t.trainEdge)} | ` +
        `${t.testSample} | ${pct(t.testRoi)} | ${r2(t.testEdge)} | ${r2(t.implied)} |`
    );
  }
  lines.push('');
  lines.push('> **edge** = observed win rate − implied probability (1/odds). Positive edge with a large ' +
    'sample is the signal; a positive ROI on 3 settled is noise.', '');

  const out = path.join(DATA_DIR, 'mine-ou-backtest.md');
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(out, lines.join('\n'), 'utf8');
  console.log(lines.join('\n'));
  console.log(`\nWrote ${out}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error(`mine-ou-backtest failed: ${e.message}`);
    process.exit(1);
  });
}

export { ouBucketsForEvents, resolvedOuEvents, roi, implied, observed, edge, aggregate };
