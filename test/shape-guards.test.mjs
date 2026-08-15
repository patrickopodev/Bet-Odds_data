import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDb, assertEventListShape } from '../lib/common.mjs';

test('assertEventListShape accepts a valid tournaments array', () => {
  assert.doesNotThrow(() => assertEventListShape({ tournaments: [] }));
  assert.doesNotThrow(() => assertEventListShape({ tournaments: [{ events: [] }] }));
});

test('assertEventListShape accepts null/undefined (no data yet)', () => {
  assert.doesNotThrow(() => assertEventListShape(null));
  assert.doesNotThrow(() => assertEventListShape(undefined));
});

test('assertEventListShape throws when tournaments is not an array', () => {
  assert.throws(() => assertEventListShape({ tournaments: 'drifted' }), /changed shape/);
  assert.throws(() => assertEventListShape({}), /changed shape/);
});

test('loadDb returns a valid v1 database', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'load-db-'));
  const file = path.join(dir, 'db.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, JSON.stringify({ version: 1, updatedAt: null, events: {} }), 'utf8');
  const db = await loadDb(file);
  assert.equal(db.version, 1);
  assert.deepEqual(db.events, {});
});

test('loadDb rejects a drifted or malformed database schema', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'load-db-'));
  const file = path.join(dir, 'db.json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(file, JSON.stringify({ version: 2, updatedAt: null, events: {} }), 'utf8');
  await assert.rejects(() => loadDb(file), /not a v1 database/);
  await fs.writeFile(file, JSON.stringify({ version: 1 }), 'utf8');
  await assert.rejects(() => loadDb(file), /not a v1 database/);
});