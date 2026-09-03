import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE, loadDb, aggregateHistoricalStats } from './lib/common.mjs';

const MARKET_MG = '548';
const MARKET_MS = '551';

// Compute per-odd stats and find the value band from an array of stat records.
function computeBand(stats) {
  const oddsMap = new Map();
  for (const s of stats) {
    const o = Number(s.odds);
    if (!oddsMap.has(o)) oddsMap.set(o, { won: 0, lost: 0, settled: 0 });
    oddsMap.get(o).won += s.won;
    oddsMap.get(o).lost += s.lost;
    oddsMap.get(o).settled += s.settled;
  }
  const odds = [...oddsMap.keys()].sort((a, b) => a - b);
  if (odds.length === 0) return null;

  const totalWon = [...oddsMap.values()].reduce((s, x) => s + x.won, 0);
  const totalSettled = [...oddsMap.values()].reduce((s, x) => s + x.settled, 0);
  const overallWinRate = totalSettled ? totalWon / totalSettled : null;

  const valueOdds = [];
  for (const o of odds) {
    const s = oddsMap.get(o);
    if (s.settled < 3) continue;
    const wr = s.won / s.settled;
    const implied = 1 / o;
    if (wr > implied) valueOdds.push(o);
  }

  let lo, hi;
  if (valueOdds.length >= 2) {
    lo = Math.min(...valueOdds);
    hi = Math.max(...valueOdds);
  } else if (valueOdds.length === 1) {
    const idx = odds.indexOf(valueOdds[0]);
    lo = idx > 0 ? odds[idx - 1] : valueOdds[0];
    hi = idx < odds.length - 1 ? odds[idx + 1] : valueOdds[0];
    if (lo === hi) {
      if (idx > 0) lo = odds[idx - 1];
      else hi = odds[idx + 1] || valueOdds[0] + 0.5;
    }
  } else {
    lo = odds[0];
    hi = odds[odds.length - 1];
  }

  if (lo === hi) {
    const idx = odds.indexOf(lo);
    if (idx > 0) lo = odds[idx - 1];
    else if (idx < odds.length - 1) hi = odds[idx + 1];
    else hi = lo + 0.5;
  }

  lo = Math.round(lo * 100) / 100;
  hi = Math.round(hi * 100) / 100;
  if (hi <= lo) hi = Math.round((lo + 0.5) * 100) / 100;

  return { lo, hi, winRate: overallWinRate, settled: totalSettled };
}

function buildReport(db) {
  const stats = aggregateHistoricalStats(db).filter(
    (s) => s.marketId === MARKET_MG || s.marketId === MARKET_MS,
  );

  const byMarket = new Map();
  for (const s of stats) {
    if (!byMarket.has(s.marketId)) byMarket.set(s.marketId, new Map());
    const m = byMarket.get(s.marketId);
    if (!m.has(s.name)) m.set(s.name, []);
    m.get(s.name).push(s);
  }

  const results = { multigoals: {}, multiscores: {} };

  for (const [marketId, label] of [[MARKET_MG, 'multigoals'], [MARKET_MS, 'multiscores']]) {
    const byName = byMarket.get(marketId);
    if (!byName) continue;
    for (const [name, nameStats] of byName) {
      const band = computeBand(nameStats);
      if (band) results[label][name] = band;
    }
  }

  return results;
}

function renderMarkdown(results) {
  const lines = [
    '# Multigoals & Multiscores — Repeated-Odds → Outcome Bands',
    '',
    `_Generated ${new Date().toISOString()} UTC._`,
    '',
    '## Multigoals (market 548)',
    '',
  ];
  const mg = Object.entries(results.multigoals || {}).sort();
  if (!mg.length) {
    lines.push('_No multigoals bands._', '');
  } else {
    for (const [name, band] of mg) {
      lines.push(`### ${name}  —  ${band.settled} settled, base win rate ${((band.winRate ?? 0) * 100).toFixed(1)}%`);
      lines.push(`Band: ${band.lo} – ${band.hi}`);
      lines.push('');
    }
  }
  lines.push('## Multiscores (market 551)', '');
  const ms = Object.entries(results.multiscores || {}).sort();
  if (!ms.length) {
    lines.push('_No multiscores bands._', '');
  } else {
    for (const [name, band] of ms) {
      lines.push(`### ${name}  —  ${band.settled} settled, base win rate ${((band.winRate ?? 0) * 100).toFixed(1)}%`);
      lines.push(`Band: ${band.lo} – ${band.hi}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main() {
  const db = await loadDb(DB_FILE);
  const results = buildReport(db);
  await fs.mkdir(DATA_DIR, { recursive: true });

  const existing = JSON.parse(await fs.readFile(path.join(DATA_DIR, 'mg-mscore-bands.json'), 'utf8'));
  const existingMg = Object.keys(existing.multigoals || {});
  const existingMs = Object.keys(existing.multiscores || {});
  const newMg = Object.keys(results.multigoals);
  const newMs = Object.keys(results.multiscores);

  const mgChanges = newMg.filter((n) => existingMg.includes(n) &&
    (existing.multigoals[n].lo !== results.multigoals[n].lo || existing.multigoals[n].hi !== results.multigoals[n].hi));
  const msChanges = newMs.filter((n) => existingMs.includes(n) &&
    (existing.multiscores[n].lo !== results.multiscores[n].lo || existing.multiscores[n].hi !== results.multiscores[n].hi));

  if (mgChanges.length) console.log(`MG bands changed: ${mgChanges.length}: ${mgChanges.join(', ')}`);
  if (msChanges.length) console.log(`MS bands changed: ${msChanges.length}: ${msChanges.join(', ')}`);

  const mgNew = newMg.filter((n) => !existingMg.includes(n));
  const msNew = newMs.filter((n) => !existingMs.includes(n));
  if (mgNew.length) console.log(`New multigoals: ${mgNew.join(', ')}`);
  if (msNew.length) console.log(`New multiscores: ${msNew.join(', ')}`);

  let invalid = 0;
  for (const [, v] of Object.entries(results.multigoals)) {
    if (v.lo >= v.hi) { console.log(`INVALID MG: ${v.lo} >= ${v.hi}`); invalid++; }
  }
  for (const [, v] of Object.entries(results.multiscores)) {
    if (v.lo >= v.hi) { console.log(`INVALID MS: ${v.lo} >= ${v.hi}`); invalid++; }
  }

  results.generatedAt = new Date().toISOString();
  await fs.writeFile(path.join(DATA_DIR, 'mg-mscore-bands.json'), JSON.stringify(results, null, 2), 'utf8');
  await fs.writeFile(path.join(DATA_DIR, 'mg-mscore-report.md'), renderMarkdown(results), 'utf8');

  console.log(`Invalid bands: ${invalid}`);
  console.log(`Wrote mg-mscore-bands.json: ${newMg.length} MG + ${newMs.length} MS outcomes`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`analyze-ms-bands failed: ${e.message}`);
    process.exit(1);
  });
}

export { buildReport };