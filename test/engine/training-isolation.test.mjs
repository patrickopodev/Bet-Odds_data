import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTraining, trainingMetrics, virtualStake } from '../../engine/training.mjs';
import { loadRegistry } from '../../engine/strategies.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.join(__dirname, '..', '..', 'engine');

test('training isolation: only virtualStake permitted', () => {
  const registry = loadRegistry();
  assert.throws(() => runTraining(registry.strategies, {}, { stakeFn: () => ({}) }), /TRAINING_ISOLATION/);
  // virtualStake is allowed and returns a virtual unit record.
  const v = virtualStake(registry.strategies[0], { odds: 1.9 });
  assert.equal(v.kind, 'virtual');
});

test('training isolation: module must not import the real staking adapter', () => {
  const src = fs.readFileSync(path.join(ENGINE_DIR, 'training.mjs'), 'utf8');
  assert.ok(!/\bimport\b[^\n]*\bexecutors\b/.test(src), 'training.mjs must not import the execution adapter');
  assert.ok(!src.includes('placeStake'), 'training.mjs must not reference any real staking path');
});

test('training metrics compute ROI/hit/drawdown/CI from virtual P&Ls', () => {
  // 3 wins @ avg odds 2.0 (pnl +1 each) and 1 loss (-1) -> n=4, pnl=2, ROI 50%.
  const pnls = [1, 1, 1, -1];
  const m = trainingMetrics(pnls);
  assert.equal(m.sample, 4);
  assert.equal(m.won, 3);
  assert.equal(m.lost, 1);
  assert.equal(m.pnl, 2);
  assert.equal(m.roi, 50);
  assert.equal(m.hitRate, 75);
  assert.ok(Array.isArray(m.ci) && m.ci.length === 2);
  assert.ok(m.drawdown <= 0);
});
