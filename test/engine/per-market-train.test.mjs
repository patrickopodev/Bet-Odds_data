import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolvedRows,
  chronologicalSplit,
  discoverCandidate,
  validateHoldout,
  findExistingEquivalent,
  mintPaperStrategy,
  registerStrategy,
  createLedger,
  runSweep,
} from '../../engine/per-market-train.mjs';
import { loadRegistry, REGISTRY_PATH } from '../../engine/strategies.mjs';
import fs from 'node:fs';

// Synthetic resolved DB with a strong, reproducible Correct Score edge so the
// sweep discovers + validates a candidate on the frozen holdout.
function makeResolvedEvents(n, { score = '1:0', selection = '1:0', odds = 3.5, marketId = '41' } = {}) {
  const evs = {};
  for (let i = 0; i < n; i++) {
    const ts = new Date(2020, 0, 1 + i).toISOString();
    evs[`E${i}`] = {
      eventId: `E${i}`,
      startTime: ts,
      finalScore: score,
      outcomes: {
        [`${marketId}|${selection}`]: { marketId, name: selection, plays: [{ odds }] },
      },
    };
  }
  return { events: evs };
}

test('resolvedRows extracts chronological, evaluated history per market', () => {
  const db = makeResolvedEvents(5);
  const rows = resolvedRows(db);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.t > 0));
  // Each event contributes one row for the "1-0" outcome, which must be WON at 1-0.
  assert.ok(rows[0].rows[0].result === 'WON');
  assert.equal(rows[0].rows[0].marketId, '41');
});

test('discoverCandidate finds a positive-edge band in TRAIN only', () => {
  const db = makeResolvedEvents(80);
  const { train } = chronologicalSplit(resolvedRows(db), 0.6);
  const cand = discoverCandidate('41', train);
  assert.ok(cand, 'should discover a candidate');
  assert.equal(cand.selection, '1:0');
  assert.ok(cand.trainRoi > 0 && cand.trainN >= 30);
});

test('validateHoldout passes on frozen holdout, fails on a negative one', () => {
  const db = makeResolvedEvents(80);
  const { train, test } = chronologicalSplit(resolvedRows(db), 0.6);
  const cand = discoverCandidate('41', train);
  const good = validateHoldout(cand, test);
  assert.equal(good.pass, true);
  assert.ok(good.holdoutRoi > 0 && good.holdoutN >= 20);

  // Negative holdout: flip all test outcomes to losers.
  const testLose = test.map((e) => ({ ...e, rows: e.rows.map((r) => ({ ...r, result: 'LOST' })) }));
  const bad = validateHoldout(cand, testLose);
  assert.equal(bad.pass, false);
});

test('findExistingEquivalent detects a duplicate; mintPaperStrategy is unique', () => {
  const reg = loadRegistry();
  const cand = { selection: '1-0', lo: 3.0, hi: 4.0 };
  const existing = findExistingEquivalent(reg, '41', cand);
  assert.equal(existing, undefined); // not present yet
  const s1 = mintPaperStrategy('41', cand, { holdoutRoi: 0.2, holdoutN: 25 }, { registry: reg });
  assert.equal(s1.strategyId, 'STRAT-CS-H1-v1');
  const reg2 = { strategies: [...reg.strategies, s1] };
  const dup = findExistingEquivalent(reg2, '41', cand);
  assert.equal(dup.strategyId, 'STRAT-CS-H1-v1');
});

test('registerStrategy is append-only and never alters existing entries', () => {
  const reg = loadRegistry();
  const before = JSON.parse(JSON.stringify(reg.strategies.find((s) => s.strategyId === 'STRAT-1X2-FAVBAND-v1')));
  const cand = { selection: '1-0', lo: 3.0, hi: 4.0 };
  const s = mintPaperStrategy('41', cand, { holdoutRoi: 0.2, holdoutN: 25 }, { registry: reg });
  const updated = registerStrategy(reg, s);
  const after = updated.strategies.find((x) => x.strategyId === 'STRAT-1X2-FAVBAND-v1');
  assert.deepEqual(after, before); // LIVE 1X2 untouched
  assert.ok(updated.strategies.some((x) => x.strategyId === s.strategyId));
});

test('runSweep (dry-run): skips LIVE 1X2, preserves O/U H1, would mint CS, no mutation', () => {
  const db = makeResolvedEvents(80);
  const beforeCount = loadRegistry().strategies.length;
  const { discovered } = runSweep(db, { apply: false });
  const byMarket = Object.fromEntries(discovered.map((d) => [d.market, d]));
  assert.match(byMarket['1X2'].action, /Continue monitoring/);
  assert.ok(byMarket['O/U'].preserved === 'STRAT-OU-H1-v1', 'O/U H1 preserved, not duplicated');
  assert.ok(byMarket['Correct Score'].strategyId === 'STRAT-CS-H1-v1', 'CS candidate discovered');
  // No registry mutation in dry-run.
  assert.equal(loadRegistry().strategies.length, beforeCount);
});

test('createLedger preserves an existing ledger and creates a new one', () => {
  const s = mintPaperStrategy('41', { selection: '1-0', lo: 3.0, hi: 4.0 }, { holdoutRoi: 0.2, holdoutN: 25 }, { registry: loadRegistry() });
  const file = `data/test-paper-${s.strategyId}.json`;
  try { fs.unlinkSync(file); } catch {}
  const f1 = createLedger(s, { write: true });
  assert.ok(fs.existsSync(f1));
  const before = fs.readFileSync(f1, 'utf8');
  // Second call must NOT overwrite an existing ledger.
  createLedger(s, { write: true });
  assert.equal(fs.readFileSync(f1, 'utf8'), before);
  fs.unlinkSync(f1);
});
