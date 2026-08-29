import test from 'node:test';
import assert from 'node:assert/strict';
import { compare1X2Enrichment, compareMarketEnrichment, compareAllMarkets, runAblation, runFeatureSet, runKfold, runExpandingWindow, normalCI, BAND_1X2 } from '../../engine/backtest-harness.mjs';

// Build a synthetic odds-db spanning ALL FIVE relevant sections, where:
//  - TRAIN: 70 settled matches, every section's favourite WON (Home 3:1).
//  - HOLDOUT "win": 40 matches, every section's favourite steamed (drift<0), WON.
//  - HOLDOUT "lose": 40 matches, favourite drifted up (drift>0) and LOST (Home
//                     won 1:0, so Over/Multigoals/CorrectScore/Multiscores favourites
//                     also lose). These have NO train support, so dbHistory drops them.
// Because the section favourite is genuinely predictive in T+W (110 wins) and only
// loses in L (40), a trustworthy k-fold evaluator should surface a real edge for
// EVERY section, not just 1X2 (RESEARCH-PLAN.md Suggestion 1, generalized).
function buildDb() {
  const events = {};
  const otherPlay = (odds, t) => [{ odds, seenAt: t }];
  const mkt1 = (id, startTime, favName, favOdds, favPlays, finalScore) => {
    const others = favName === 'Home' ? { Draw: 3.4, Away: 4.0 } : { Home: 4.0, Draw: 3.4 };
    const outcomes = { [`1|${favName}`]: { marketId: '1', name: favName, plays: favPlays } };
    for (const [n, o] of Object.entries(others)) {
      outcomes[`1|${n}`] = { marketId: '1', name: n, plays: otherPlay(o, startTime) };
    }
    // O/U: Over is the section favourite (shorter than Under), train-backed, steamed.
    outcomes['18|Over 2.5'] = { marketId: '18', name: 'Over 2.5', plays: favPlays };
    outcomes['18|Under 2.5'] = { marketId: '18', name: 'Under 2.5', plays: otherPlay(2.1, startTime) };
    // Multigoals: "4-5" is the favourite; total 4 (3:1) wins, total 1 (1:0) loses.
    outcomes['548|4-5'] = { marketId: '548', name: '4-5', plays: favPlays };
    outcomes['548|1-2'] = { marketId: '548', name: '1-2', plays: otherPlay(3.0, startTime) };
    // Correct Score: "3:1" is the favourite (matches the 3:1 final).
    outcomes['41|3:1'] = { marketId: '41', name: '3:1', plays: favPlays };
    outcomes['41|0:0'] = { marketId: '41', name: '0:0', plays: otherPlay(8.0, startTime) };
    // Multiscores: "3:1, 2:1 or 4:1" contains 3:1 -> wins on 3:1, loses on 1:0.
    outcomes['551|3:1, 2:1 or 4:1'] = { marketId: '551', name: '3:1, 2:1 or 4:1', plays: favPlays };
    outcomes['551|Draw'] = { marketId: '551', name: 'Draw', plays: otherPlay(5.0, startTime) };
    events[id] = { eventId: id, homeTeam: 'H' + id, awayTeam: 'A' + id, tournament: 'Premier League', startTime, finalScore, outcomes };
  };
  const t0 = '2026-07-01T10:00:00Z', t1 = '2026-07-01T10:30:00Z', t2 = '2026-07-01T11:00:00Z';
  for (let i = 0; i < 70; i++) {
    mkt1('T' + i, `2026-01-${String(i + 1).padStart(2, '0')}T12:00:00Z`, 'Home', 1.95, [{ odds: 1.95, seenAt: t0 }], '3:1');
  }
  for (let i = 0; i < 40; i++) {
    mkt1('W' + i, `2026-07-02T12:00:00Z`, 'Home', 1.95, [
      { odds: 2.1, seenAt: t0 }, { odds: 2.0, seenAt: t1 }, { odds: 1.95, seenAt: t2 },
    ], '3:1');
  }
  for (let i = 0; i < 40; i++) {
    mkt1('L' + i, `2026-07-03T12:00:00Z`, 'Away', 2.0, [
      { odds: 1.95, seenAt: t0 }, { odds: 1.98, seenAt: t1 }, { odds: 2.0, seenAt: t2 },
    ], '1:0');
  }
  return { version: 1, updatedAt: '2026-08-28T00:00:00Z', events };
}

const TRAIN_FRAC = 70 / 150; // 70 train / 150 total -> clean chronological split

test('enriched 1X2 (odds-history + drift) beats baseline and is a real SIGNAL', () => {
  const db = buildDb();
  const cmp = compare1X2Enrichment(db, { trainFrac: TRAIN_FRAC });
  assert.equal(cmp.baseline.n, 80, 'baseline picks every holdout favourite');
  assert.equal(cmp.enriched.n, 40, 'enriched keeps only the steamed, train-backed winners');
  assert.equal(cmp.baseline.verdict, 'NO SIGNAL', 'baseline (50% losers) is not an edge');
  assert.equal(cmp.enriched.verdict, 'SIGNAL', 'enriched is a proven out-of-sample edge');
  assert.ok(cmp.deltaRoiPts > 0);
});

test('no leakage: an outcome with zero train support is never selected', () => {
  const db = buildDb();
  // Add one holdout event whose favourite (Home @6.66) has NO matching train
  // history at all. dbHistory must NOT select it — proving train stats are built
  // from the TRAIN slice only, never from holdout results.
  const orphan = JSON.parse(JSON.stringify(db));
  const eid = 'ORPHAN';
  orphan.events[eid] = {
    eventId: eid, homeTeam: 'ZZ', awayTeam: 'YY', tournament: 'X',
    startTime: '2026-08-01T12:00:00Z', finalScore: '2:0',
    outcomes: {
      '1|Home': { marketId: '1', name: 'Home', plays: [{ odds: 6.66, seenAt: '2026-08-01T10:00:00Z' }] },
      '1|Draw': { marketId: '1', name: 'Draw', plays: [{ odds: 4.0, seenAt: '2026-08-01T10:00:00Z' }] },
      '1|Away': { marketId: '1', name: 'Away', plays: [{ odds: 1.5, seenAt: '2026-08-01T10:00:00Z' }] },
    },
  };
  const only = runFeatureSet(orphan, { flags: { dbHistory: true }, trainFrac: TRAIN_FRAC });
  assert.equal(only.bets.some((b) => b.eventId === eid), false, 'no-train-support outcome is excluded');
});

test('per-section enrichment works for non-1X2 markets (O/U)', () => {
  const db = buildDb();
  const r = compareMarketEnrichment(db, { marketId: '18', trainFrac: TRAIN_FRAC });
  assert.equal(r.marketId, '18');
  assert.equal(r.baseline.n, 80, 'O/U favourite (Over) is selected on every holdout event');
  assert.equal(r.enriched.n, 40, 'enriched keeps only the steamed, train-backed Over winners');
  assert.ok(r.enriched.n <= r.baseline.n, 'enriched is a subset of baseline');
});

test('compareAllMarkets covers every relevant section', () => {
  const db = buildDb();
  const all = compareAllMarkets(db, { trainFrac: TRAIN_FRAC });
  assert.equal(all.length, 5);
  assert.ok(all.every((r) => r.baseline && r.enriched && r.dbHistoryOnly));
});

test('ablation table is produced and flags needing data report NO DATA', () => {
  const db = buildDb();
  const ab = runAblation(db, { features: null, trainFrac: TRAIN_FRAC });
  assert.equal(ab.rows.length, 7); // baseline + 5 features (dbHistory, drift, h2h, competition, form) + ALL
  assert.equal(ab.baseline.verdict, 'NO SIGNAL');
  const noDataRows = ab.rows.filter((r) => r.verdict === 'NO DATA');
  assert.ok(noDataRows.length >= 1, 'h2h/competition combos without data are flagged NO DATA');
});

test('NO SIGNAL gate fires when a candidate has no edge', () => {
  const db = buildDb();
  const base = runFeatureSet(db, { flags: { favBand: true }, trainFrac: TRAIN_FRAC });
  assert.equal(base.verdict, 'NO SIGNAL', 'a losing selector is not a signal');
  assert.ok(base.roi < 0, 'losing baseline has negative ROI');
});

test('normalCI is deterministic and ordered', () => {
  const pnls = [0.95, -1, 0.95, -1, 0.95];
  const [lo, hi] = normalCI(pnls);
  assert.ok(lo <= hi);
  assert.ok(Number.isFinite(lo) && Number.isFinite(hi));
});

// ---- Suggestion 1: k-fold / expanding-window evaluators (RESEARCH-PLAN.md) ----

test('k-fold pooled verdict: enriched refines baseline and stays a SIGNAL', () => {
  const db = buildDb();
  const enriched = runKfold(db, { flags: { favBand: true, dbHistory: true, drift: true }, k: 5 });
  const baseline = runKfold(db, { flags: { favBand: true }, k: 5 });
  assert.equal(enriched.verdict, 'SIGNAL', 'enriched edge holds under pooled k-fold');
  assert.equal(enriched.method, 'kfold');
  assert.ok(enriched.n < baseline.n, 'enriched is a strict subset: only steamed, train-backed winners');
  assert.ok(enriched.n >= 40, 'at least the 40 steamed 1X2 winners survive across folds');
  assert.ok(enriched.roi > baseline.roi, 'enrichment improves ROI over the pooled favourite');
});

test('expanding-window pooled verdict: enriched refines baseline and stays a SIGNAL', () => {
  const db = buildDb();
  const enriched = runExpandingWindow(db, { flags: { favBand: true, dbHistory: true, drift: true }, folds: 5 });
  const baseline = runExpandingWindow(db, { flags: { favBand: true }, folds: 5 });
  assert.equal(enriched.verdict, 'SIGNAL');
  assert.equal(enriched.method, 'expanding');
  assert.ok(enriched.n <= baseline.n, 'enriched is a subset of baseline');
});

test('k-fold pooled verdict is trustworthy for ALL 5 sections (not just 1X2)', () => {
  // Suggestion 1, generalized: the harness must be trusted per-section for every
  // market, mirroring the v5b k-fold rigour. The synthetic section favourite is
  // genuinely predictive in train+win holdout (110/150) and only loses in the
  // drift-excluded group, so k-fold must surface a real edge in each section.
  const db = buildDb();
  const all = compareAllMarkets(db, { method: 'kfold', k: 5 });
  assert.equal(all.length, 5, 'all five relevant sections are reported');
  for (const sec of all) {
    assert.equal(sec.method, 'kfold', `${sec.marketId} evaluated by k-fold`);
    assert.ok(sec.baseline.n > 0, `${sec.marketId} has pooled bets`);
    assert.equal(sec.baseline.verdict, 'SIGNAL', `${sec.marketId} k-fold baseline edge (CI excludes zero)`);
    // Enriched (favBand + db-history + steam) keeps only the 40 steamed winners.
    assert.equal(sec.enriched.n, 40, `${sec.marketId} enriched subset = steamed winners`);
    assert.equal(sec.enriched.verdict, 'SIGNAL');
  }
});

test('runAblation method option emits the same feature rows for k-fold', () => {
  const db = buildDb();
  const ab = runAblation(db, { features: null, method: 'kfold', k: 5 });
  assert.equal(ab.rows.length, 7);
  assert.equal(ab.method, 'kfold');
  // h2h / competition / form still report NO DATA without features.
  const noData = ab.rows.filter((r) => r.verdict === 'NO DATA');
  assert.ok(noData.length >= 3, 'h2h, competition and form gates need data');
});

test('form gate is exercised when features + formDb are supplied (not NO DATA)', () => {
  const db = buildDb();
  // Give the section favourites a form edge by seeding a team-form store.
  const formDb = {
    H: [{ asOf: '2026-06-01T00:00:00Z', position: 1, formScore: 15, lastResults: [], avgGoalsFor: 2, avgGoalsAgainst: 1 }],
  };
  // homeTeam for these events is 'H'+id; map one alias so the favourite (Home) passes.
  const features = {};
  for (const id of Object.keys(db.events)) {
    const ev = db.events[id];
    features[id] = { homeTeam: ev.homeTeam, awayTeam: ev.awayTeam, meetings: [], competition: null };
    formDb[ev.homeTeam] = formDb.H[0];
    formDb[ev.awayTeam] = { asOf: '2026-06-01T00:00:00Z', position: 10, formScore: 3, lastResults: [], avgGoalsFor: 1, avgGoalsAgainst: 2 };
  }
  const r = runFeatureSet(db, { flags: { favBand: true, form: true }, features, formDb });
  assert.notEqual(r.verdict, 'NO DATA', 'form gate is exercised, not skipped');
});
