import fs from 'node:fs/promises';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? 'data';
export const DB_FILE = process.env.DB_FILE ?? path.join(DATA_DIR, 'odds-db.json');

// Single source of truth for the four odds sections and the SportyBet market-id
// mapping. Shared by the scraper, DB builder, and analyzer so they can never drift
// on section names or id->section mapping.
// Four sections, in display order.
export const MARKET_ORDER = ['1X2 / O/U', 'Correct Score [0:0]', 'Multiscores', 'Multigoals'];

// Map SportyBet market ids -> the section a market belongs to. 1X2 (id 1) and
// Over/Under (id 18) are merged into one "1X2 / O/U" section.
export const TARGET_MARKET_IDS = {
  '1': '1X2 / O/U',
  '18': '1X2 / O/U',
  '41': 'Correct Score [0:0]',
  '548': 'Multigoals',
  '551': 'Multiscores',
};

// Set of market ids the legacy JSON scraper fetches.
export const TARGET_MARKET_IDS_SET = new Set(Object.keys(TARGET_MARKET_IDS));

export const UA =
  process.env.USER_AGENT ??
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const DEFAULT_TIMEOUT = 30000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout ?? DEFAULT_TIMEOUT);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': UA, ...(options.headers ?? {}) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export async function fetchText(url, options = {}) {
  const res = await fetchWithTimeout(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export async function mapWithConcurrency(items, worker, limit = 4) {
  const results = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (e) {
        results[idx] = { error: e.message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return results;
}

// Strict load: throws if the DB file is missing. Callers that want a fresh DB
// on first run should wrap this in try/catch and seed a new one.
export async function loadDb(dbFile = DB_FILE) {
  return JSON.parse(await fs.readFile(dbFile, 'utf8'));
}

export async function saveDb(db, dbFile = DB_FILE) {
  db.updatedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(dbFile), { recursive: true });
  await fs.writeFile(dbFile, JSON.stringify(db, null, 2), 'utf8');
}
