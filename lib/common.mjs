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
    const { headers, timeout, ...rest } = options;
    return await fetch(url, {
      headers: { 'User-Agent': UA, ...(headers ?? {}) },
      signal: controller.signal,
      ...rest,
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

// ---------------------------------------------------------------------------
// SportyBet API: full-catalog event list + per-event market detail.
// These two endpoints are the main (and only) way matches are found and
// scraped. The list endpoint (wapConfigurableEventsByOrder) paginates over the
// whole pre-match catalog, so today's matches come from it rather than the
// curated recommendScrollEvents feed which only surfaces a hand-picked subset.
// ---------------------------------------------------------------------------

export const SPORTYBET_BASE_URL = 'https://www.sportybet.com';
export const SPORTYBET_LIST_URL = `${SPORTYBET_BASE_URL}/api/gh/factsCenter/wapConfigurableEventsByOrder`;
export const SPORTYBET_PRODUCT_ID = '3'; // 3 = pre-match, 1 = live
export const TARGET_SPORT = 'sr:sport:1'; // Football

const SPORTYBET_HEADERS = {
  'Accept': 'application/json, text/plain, */*',
  'Content-Type': 'application/json',
  'Referer': SPORTYBET_BASE_URL + '/gh/m/',
  'Origin': SPORTYBET_BASE_URL,
};

export async function fetchSportyApiJson(url, options = {}) {
  const body = await fetchJson(url, {
    headers: { ...SPORTYBET_HEADERS, ...(options.headers ?? {}) },
    ...options,
  });
  if (body.bizCode !== 10000) {
    throw new Error(`API error ${body.bizCode}: ${body.message ?? body.innerMsg} for ${url}`);
  }
  return body.data;
}

// Paginate the full pre-match catalog and return every football event.
// `filter` receives each event and returns true to keep it; callers filter for
// today's window / "Not start" status as appropriate.
export async function fetchAllFootballEvents({ pageSize = 200, maxPages = 50, filter = () => true } = {}) {
  const events = [];
  let pageNum = 1;
  let moreEvents = true;

  while (moreEvents && pageNum <= maxPages) {
    const data = await fetchSportyApiJson(SPORTYBET_LIST_URL, {
      method: 'POST',
      body: JSON.stringify({ productId: Number(SPORTYBET_PRODUCT_ID), pageNum, pageSize }),
    });

    for (const tournament of data?.tournaments ?? []) {
      for (const ev of tournament.events ?? []) {
        if (ev.sport?.id !== TARGET_SPORT) continue;
        if (!filter(ev)) continue;
        events.push({
          eventId: ev.eventId,
          gameId: ev.gameId,
          homeTeam: ev.homeTeamName,
          awayTeam: ev.awayTeamName,
          startTime: ev.estimateStartTime,
          matchStatus: ev.matchStatus,
          tournamentId: ev.sport?.category?.tournament?.id,
          tournamentName: ev.sport?.category?.tournament?.name,
          categoryName: ev.sport?.category?.name,
        });
      }
    }

    moreEvents = data?.moreEvents === true;
    pageNum += 1;
    if (moreEvents) await new Promise((r) => setTimeout(r, 600)); // endpoint rate-limits rapid pages
  }

  return events;
}

// Convenience: today's not-started football matches, shared by the scraper and
// the coverage comparison so they can never disagree about what "today" is.
export async function fetchTodayFootballEvents() {
  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60 * 1000);
  return fetchAllFootballEvents({
    filter: (ev) => {
      // Product 3 is the pre-match catalog, but some lower-tier events omit
      // the matchStatus field entirely; treat those as not started. Any event
      // that has clearly kicked off is excluded.
      const started = ['H1', 'H2', 'HT', 'AET', 'FT'].includes(ev.matchStatus);
      return (
        !started &&
        ev.estimateStartTime >= dayStart.getTime() &&
        ev.estimateStartTime < dayEnd.getTime()
      );
    },
  });
}

// Fetch one event's full market list (includes the four odds sections).
export async function fetchEventMarkets(eventId, productId = SPORTYBET_PRODUCT_ID) {
  const url = `${SPORTYBET_BASE_URL}/api/gh/factsCenter/event?productId=${productId}&eventId=${encodeURIComponent(eventId)}`;
  return fetchSportyApiJson(url);
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

// ---------------------------------------------------------------------------
// Flashscore feed + team-name normalization, shared by resolve-results.mjs and
// compare-coverage.mjs so the two sides can never drift on how a team name is
// compared or how a feed block is decoded.
// ---------------------------------------------------------------------------

// Decode a Flashscore feed block ("key÷value¬key÷value¬...") into a map.
export function decodeFeedBlock(block) {
  const fields = {};
  for (const p of block.split('¬')) {
    const x = p.indexOf('÷');
    if (x > 0) fields[p.slice(0, x)] = p.slice(x + 1);
  }
  return fields;
}

// Club-type and regional abbreviations that SportyBet and Flashscore spell
// differently (or one omits). Stripping them from BOTH sides lets the search
// match on the stable core name. Includes Brazilian state codes (trailing) and
// common prefixes (FC/FK/AC/SC/RC/CA/IL/Club...).
export const CLUB_TOKENS = new Set([
  'fc', 'fk', 'ac', 'sc', 'cf', 'ec', 'kc', 'bk', 'kf', 'nk', 'cd', 'ud',
  'rc', 'il', 'clube', 'club', 'ca', 'afc', 'rcd', 'sd', 'udl',
  'ac', 'al', 'ap', 'am', 'ba', 'ce', 'df', 'es', 'go', 'ma', 'mt', 'ms',
  'mg', 'pa', 'pb', 'pr', 'pe', 'pi', 'rn', 'rs', 'rj', 'ro', 'rr', 'sp',
  'se', 'to',
]);
// Filler particles that flip between the two sites ("de La", "do", "y"...).
export const TEAM_PARTICLES = new Set(['de', 'la', 'do', 'dos', 'da', 'das', 'di', 'du', 'del']);
// Known core-name mismatches the tokenizer can't bridge.
export const TEAM_ALIASES = {
  manutd: 'manchesterunited',
  manchesterutd: 'manchesterunited',
  heartofmidlothian: 'hearts',
};

// Normalize a team name to its comparable core: lowercase, drop club/state
// tokens at either end, drop filler particles, strip country tags in
// parentheses (Flashscore writes "Hearts (Sco)", "Benfica (Por)"), apply aliases.
export function normTeam(s) {
  const stripped = (s || '').replace(/\([^)]*\)/g, ' ');
  let tokens = stripped.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && CLUB_TOKENS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && CLUB_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  tokens = tokens.filter((t) => !TEAM_PARTICLES.has(t));
  const core = tokens.join('');
  return TEAM_ALIASES[core] || core;
}

// Spaced version of the core name, for sending to the search API (which handles
// readable queries far better than a concatenated blob like "dynamokyiv").
export function queryTeam(s) {
  let tokens = (s || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  while (tokens.length > 1 && CLUB_TOKENS.has(tokens[0])) tokens.shift();
  while (tokens.length > 1 && CLUB_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
  tokens = tokens.filter((t) => !TEAM_PARTICLES.has(t));
  return tokens.join(' ');
}

// Loose same-team test: exact core, or one core is contained in the other and
// the shared part is long enough to be meaningful ("Hearts" vs "Heart of
// Midlothian FC" -> "hearts" in "heartmidlothianfc").
export function sameTeam(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.includes(short);
}

export function kickoffDeltaMs(a, b) {
  if (!a || !b) return Infinity;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime());
}
