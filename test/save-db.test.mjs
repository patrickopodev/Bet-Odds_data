import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveDb } from '../lib/common.mjs';

async function withTempFile(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-db-'));
  const file = path.join(dir, 'db.json');
  t.after(async () => fs.rm(dir, { recursive: true, force: true }));
  return file;
}

test('saveDb writes a fresh DB and returns true', async (t) => {
  const file = await withTempFile(t);
  const db = { version: 1, events: {} };
  const wrote = await saveDb(db, file);
  assert.equal(wrote, true);
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.ok(onDisk.updatedAt);
});

test('saveDb is a no-op when only updatedAt would change', async (t) => {
  const file = await withTempFile(t);
  const db = { version: 1, updatedAt: null, events: {} };
  assert.equal(await saveDb(db, file), true);
  const mtimeBefore = (await fs.stat(file)).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const wrote = await saveDb({ version: 1, updatedAt: 'ignored', events: {} }, file);
  assert.equal(wrote, false);
  const mtimeAfter = (await fs.stat(file)).mtimeMs;
  assert.equal(mtimeBefore, mtimeAfter);
});

test('saveDb writes again when the data changed', async (t) => {
  const file = await withTempFile(t);
  await saveDb({ version: 1, updatedAt: null, events: {} }, file);
  const wrote = await saveDb({ version: 1, updatedAt: null, events: { sr: { finalScore: '1:1' } } }, file);
  assert.equal(wrote, true);
  const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(onDisk.events.sr.finalScore, '1:1');
});