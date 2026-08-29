// engine/deep-discovery.mjs
//
// Read-only, deeper discovery pass for markets beyond the two already-ruled
// strategies (1X2 LIVE, O/U PAPER). The point is NOT to force every market to
// produce a strategy. It is to test predefined hypothesis families against a
// FROZEN chronological holdout and report survivors for human review.
//
// Anti-mining rules (do not weaken):
//   - Only predefined families per market (see generatorsFor). No arbitrary
//     cross-feature combination search.
//   - A candidate must clear trainN >= MIN_TRAIN AND a positive ROI on the
//     FROZEN holdout (testN >= MIN_HOLDOUT, holdoutROI > 0).
//   - This module NEVER mints or registers a strategy. Survivors are shown
//     only; promotion is a separate, human-gated step (promotion.mjs).
//
// Each market also gets a data-quality report so we can tell "genuinely no
// signal" apart from "not enough resolved history to even test the hypothesis".

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolvedRows,
  chronologicalSplit,
  validateHoldout,
  BANDS,
  MIN_TRAIN,
  MIN_HOLDOUT,
  roiOf,
} from './per-market-train.mjs';

const MARKET_NAMES = {
  '1': '1X2',
  '18': 'O/U',
  '41': 'Correct Score',
  '548': 'Multigoals',
  '551': 'Multiscores',
};

function parseCsName(name) {
  const m = name.match(/^(\d+)[:-](\d+)$/);
  return m ? { home: Number(m[1]), away: Number(m[2]) } : null;
}

// --- candidate enumeration helpers -------------------------------------------
function rowsFor(marketId, trainEvents) {
  return trainEvents.flatMap((e) => e.rows).filter((r) => r.marketId === String(marketId));
}

// Generic baseline: every (outcome, odds-band) cell, exactly as the first sweep.
function genOutcomeBand(marketId, trainEvents) {
  const rows = rowsFor(marketId, trainEvents);
  const byName = {};
  for (const r of rows) (byName[r.name] ??= []).push(r);
  const out = [];
  for (const [name, arr] of Object.entries(byName)) {
    let best = null;
    for (const [lo, hi] of BANDS) {
      const inB = arr.filter((r) => r.odds >= lo && r.odds < hi);
      if (inB.length < MIN_TRAIN) continue;
      const m = roiOf(inB);
      if (m.roi == null || m.roi <= 0) continue;
      if (!best || m.roi > best.trainRoi) best = { lo, hi, trainRoi: m.roi, trainN: inB.length };
    }
    if (best) out.push({ selection: name, members: null, ...best });
  }
  return out;
}

// Generic family engine: pool outcomes by a predefined name-set, then best band.
function familiesFromNameSets(marketId, trainEvents, nameSets) {
  const rows = rowsFor(marketId, trainEvents);
  const out = [];
  for (const [famName, names] of Object.entries(nameSets)) {
    const arr = rows.filter((r) => names.has(r.name));
    let best = null;
    for (const [lo, hi] of BANDS) {
      const inB = arr.filter((r) => r.odds >= lo && r.odds < hi);
      if (inB.length < MIN_TRAIN) continue;
      const m = roiOf(inB);
      if (m.roi == null || m.roi <= 0) continue;
      if (!best || m.roi > best.trainRoi) best = { lo, hi, trainRoi: m.roi, trainN: inB.length };
    }
    if (best) out.push({ selection: famName, members: names, ...best });
  }
  return out;
}

// Correct Score: structure by score semantics (the outcome space is fragmented,
// so families pool related scores). Built dynamically from real outcome names.
function csNameSets(trainEvents) {
  const rows = rowsFor('41', trainEvents);
  const sets = {
    'Home win scores': new Set(),
    'Away win scores': new Set(),
    'Draw scores': new Set(),
    '1-goal margin': new Set(),
    '2+ goal margin': new Set(),
    'High scoring (5+)': new Set(),
  };
  for (const r of rows) {
    const p = parseCsName(r.name);
    if (!p) continue;
    if (p.home > p.away) sets['Home win scores'].add(r.name);
    if (p.away > p.home) sets['Away win scores'].add(r.name);
    if (p.home === p.away) sets['Draw scores'].add(r.name);
    if (Math.abs(p.home - p.away) === 1) sets['1-goal margin'].add(r.name);
    if (Math.abs(p.home - p.away) >= 2) sets['2+ goal margin'].add(r.name);
    if (p.home + p.away >= 5) sets['High scoring (5+)'].add(r.name);
  }
  return sets;
}

// Multigoals: pool the native goal-range outcomes into research buckets.
const MG_NAME_SETS = {
  'Goals 0-1': new Set(['No goal', '1-2']),
  'Goals 2-3': new Set(['1-2', '2-3', '1-3']),
  'Goals 2-4': new Set(['1-3', '2-3', '2-4', '3-4', '1-2']),
  'Goals 3-4': new Set(['2-3', '3-4', '3-5', '2-4']),
  'Goals 4+': new Set(['3-4', '4-5', '4-6', '5-6', '7+', '3-5', '3-6']),
};

// Multiscores: classify each outcome into semantic families.
function classifyMs(name) {
  const fams = [];
  if (/Homewin/i.test(name)) fams.push('Home win');
  if (/Awaywin/i.test(name)) fams.push('Away win');
  if (/Draw/i.test(name)) fams.push('Draw');
  const scores = [...name.matchAll(/(\d+):(\d+)/g)].map((m) => ({ home: +m[1], away: +m[2] }));
  if (scores.length) {
    const allHome = scores.every((s) => s.home > s.away);
    const allAway = scores.every((s) => s.away > s.home);
    const allDraw = scores.every((s) => s.home === s.away);
    if (allHome) fams.push('Home win');
    if (allAway) fams.push('Away win');
    if (allDraw) fams.push('Draw');
    if (scores.some((s) => s.home + s.away <= 2)) fams.push('Low score (<=2)');
    if (scores.some((s) => s.home + s.away >= 4)) fams.push('High score (>=4)');
  }
  return [...new Set(fams)];
}

function msNameSets(trainEvents) {
  const rows = rowsFor('551', trainEvents);
  const sets = {
    'Home win': new Set(),
    'Away win': new Set(),
    'Draw': new Set(),
    'Low score (<=2)': new Set(),
    'High score (>=4)': new Set(),
  };
  for (const r of rows) for (const f of classifyMs(r.name)) sets[f].add(r.name);
  return sets;
}

// --- per-market generator registry -------------------------------------------
export function generatorsFor(marketId) {
  const named = (fn, label) => Object.assign(fn, { label });
  switch (String(marketId)) {
    case '1': // 1X2 — already LIVE; baseline only (favorite band is Strategy A)
    case '18': // O/U — already PAPER (H1); baseline only
      return [genOutcomeBand];
    case '41': // Correct Score — score-family research
      return [genOutcomeBand, named((m, t) => familiesFromNameSets(m, t, csNameSets(t)), 'Score families')];
    case '548': // Multigoals — goal-range research
      return [genOutcomeBand, named((m, t) => familiesFromNameSets(m, t, MG_NAME_SETS), 'Goal ranges')];
    case '551': // Multiscores — score-group research
      return [genOutcomeBand, named((m, t) => familiesFromNameSets(m, t, msNameSets(t)), 'Score groups')];
    default:
      return [genOutcomeBand];
  }
}

// --- frozen holdout evaluation -----------------------------------------------
function evaluateCandidates(marketId, candidates, testEvents) {
  const survivors = [];
  for (const c of candidates) {
    const cand = {
      marketId,
      selection: c.selection,
      lo: c.lo,
      hi: c.hi,
      trainN: c.trainN,
      members: c.members ?? null,
    };
    const v = validateHoldout(cand, testEvents);
    if (v.pass) {
      survivors.push({
        selection: c.selection,
        lo: c.lo,
        hi: c.hi,
        trainRoi: c.trainRoi,
        trainN: c.trainN,
        holdoutRoi: v.holdoutRoi,
        holdoutN: v.holdoutN,
      });
    }
  }
  return survivors;
}

// --- top-level discovery -----------------------------------------------------
export function runDeepDiscovery(db) {
  const events = resolvedRows(db);
  const { train, test } = chronologicalSplit(events);
  const report = [];
  for (const marketId of ['1', '18', '41', '548', '551']) {
    const generators = generatorsFor(marketId);
    const genOut = [];
    let survivorsAll = [];
    for (const g of generators) {
      const cands = g(marketId, train);
      const survivors = evaluateCandidates(marketId, cands, test);
      survivorsAll = survivorsAll.concat(survivors);
      genOut.push({
        generator: g.label || g.name || 'anonymous',
        candidates: cands.length,
        survivors: survivors.length,
        survivorsList: survivors,
      });
    }
    report.push({ marketId, market: MARKET_NAMES[marketId], generators: genOut, survivors: survivorsAll });
  }
  return { trainEvents: train.length, testEvents: test.length, report };
}

// --- market data-quality report ----------------------------------------------
// Distinguishes "genuinely no signal" from "not enough resolved history to test
// the hypothesis at all". Read-only; never mints.
export function dataQualityReport(db) {
  const events = resolvedRows(db);
  const report = [];
  for (const marketId of ['1', '18', '41', '548', '551']) {
    const rows = events.flatMap((e) => e.rows).filter((r) => r.marketId === String(marketId));
    const resolved = rows.filter((r) => r.result === 'WON' || r.result === 'LOST');
    const names = [...new Set(resolved.map((r) => r.name))];

    const cells = {};
    for (const r of resolved) {
      const b = BANDS.find(([lo, hi]) => r.odds >= lo && r.odds < hi);
      if (!b) continue;
      const k = `${r.name}|${b[0]}-${b[1]}`;
      cells[k] = (cells[k] || 0) + 1;
    }
    const cellVals = Object.values(cells);
    const ge30 = cellVals.filter((n) => n >= MIN_TRAIN).length;
    const maxCell = cellVals.length ? Math.max(...cellVals) : 0;
    const eligibleSamples = Object.entries(cells)
      .filter(([, n]) => n >= MIN_TRAIN)
      .reduce((a, [, n]) => a + n, 0);
    const coveragePct = resolved.length ? +((eligibleSamples / resolved.length) * 100).toFixed(1) : 0;

    // Holdout-surviving candidate count across this market's generators.
    const { train, test } = chronologicalSplit(events);
    let survivors = 0;
    for (const g of generatorsFor(marketId)) {
      survivors += evaluateCandidates(marketId, g(marketId, train), test).length;
    }

    let verdict;
    if (marketId === '1') verdict = 'LIVE (STRAT-1X2-BAND-v1)';
    else if (marketId === '18') verdict = 'PAPER (STRAT-OU-H1-v1)';
    else if (survivors > 0) verdict = 'candidate(s) survived holdout -> PAPER-eligible';
    else if (ge30 >= 5) verdict = 'signal-poor (tested, no edge)';
    else verdict = 'data-poor (insufficient resolution)';

    report.push({
      marketId,
      market: MARKET_NAMES[marketId],
      resolvedMatches: events.filter((e) => e.rows.some((r) => r.marketId === String(marketId))).length,
      uniqueOutcomes: names.length,
      maxCellSample: maxCell,
      cellsGe30: ge30,
      coveragePct,
      survivors,
      verdict,
    });
  }
  return report;
}

// --- reporting helpers -------------------------------------------------------
export function formatDiscovery(r) {
  const lines = ['# Deep Discovery — read-only candidate report (no minting/registration)', ''];
  for (const m of r.report) {
    lines.push(`MARKET: ${m.market} (${m.marketId})`);
    lines.push('Generator'.padEnd(28), 'Candidates   Holdout Survivors'.padStart(0));
    lines.push('-'.repeat(47));
    for (const g of m.generators) {
      lines.push(`${g.generator.padEnd(28)} ${String(g.candidates).padStart(10)} ${String(g.survivors).padStart(18)}`);
    }
    for (const s of m.survivors) {
      lines.push(
        `  Survivor: ${s.selection} @ [${s.lo}, ${s.hi})  trainROI ${(s.trainRoi * 100).toFixed(1)}% (n=${s.trainN})  holdoutROI ${(s.holdoutRoi * 100).toFixed(1)}% (n=${s.holdoutN})`,
      );
    }
    lines.push('');
  }
  lines.push('Survivors are SHOWN ONLY. Human review decides whether to mint a PAPER strategy.');
  return lines.join('\n');
}

export function formatQuality(report) {
  const head = ['Market', 'Resolved', 'Uniq', 'MaxCell', 'Cells>=30', 'Coverage%', 'Surv', 'Verdict'];
  const rows = report.map((r) =>
    [r.market, r.resolvedMatches, r.uniqueOutcomes, r.maxCellSample, r.cellsGe30, r.coveragePct, r.candidates, r.verdict].join('\t'),
  );
  return ['# Market data-quality report (signal-poor vs data-poor)', '', head.join('\t'), ...rows].join('\n');
}

// --- CLI ---------------------------------------------------------------------
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const { loadDb } = await import('../lib/common.mjs');
  const { writeFile } = await import('node:fs/promises');
  const db = await loadDb();
  const quality = process.argv.includes('--quality');
  const write = process.argv.includes('--write');
  if (quality) {
    const out = formatQuality(dataQualityReport(db));
    if (write) await writeFile('data/data-quality.json', out);
    console.log(out);
  } else {
    const out = formatDiscovery(runDeepDiscovery(db));
    if (write) await writeFile('data/discovery-report.json', out);
    console.log(out);
  }
}
