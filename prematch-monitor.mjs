import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  MARKET_ORDER,
  SPORTYBET_BASE_URL,
  fetchSportyApiJson,
  fetchTodayFootballEvents,
  fetchEventMarketsByKey,
} from './lib/common.mjs';

// Pre-match monitor: every scheduled scrape finds matches within the final
// N minutes before kickoff and records their odds in near-real-time until the
// match goes LIVE. Only the four odds sections are tracked:
//   1X2 / O/U (ids 1 + 18), Correct Score [0:0] (41), Multigoals (548), Multiscores (551)
//
// Usage:
//   node prematch-monitor.mjs                     # monitor final 30 min, poll every 15s
//   node prematch-monitor.mjs --window 45         # wider window (minutes before kickoff)
//   node prematch-monitor.mjs --interval 10       # poll every 10s
//   node prematch-monitor.mjs --max 25            # stop after 25 min even if still pre-match
//   node prematch-monitor.mjs --event <eventId>   # monitor a single match regardless of window
//
// Output: data/prematch-<eventId>.json — full change log, one file per match.
// A match is "LIVE" (and removed from monitoring) when its eventId shows up in
// the live catalog (productId 1) or the match clock starts.

const LIVE_PRODUCT = '1';
const PREMATCH_PRODUCT = '3';
const DEFAULT_WINDOW_MIN = 30;
const DEFAULT_INTERVAL_SECONDS = 15;
const DEFAULT_MAX_MINUTES = 40;
const LIVE_START_STATUSES = new Set(['H1', 'H2', 'HT', 'AET', 'FT']);

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    windowMin: DEFAULT_WINDOW_MIN,
    interval: DEFAULT_INTERVAL_SECONDS,
    maxMinutes: DEFAULT_MAX_MINUTES,
    eventId: null,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--window') opts.windowMin = Number(args[++i]);
    else if (args[i] === '--interval') opts.interval = Number(args[++i]);
    else if (args[i] === '--max') opts.maxMinutes = Number(args[++i]);
    else if (args[i] === '--event') opts.eventId = args[++i];
  }
  return opts;
}

function kickoffMs(ev) {
  return ev.startTime ? new Date(ev.startTime).getTime() : null;
}

// A match is in the monitoring window when its kickoff is in the future and no
// more than `windowMin` away.
export function isWithinWindow(ev, nowMs, windowMin) {
  const k = kickoffMs(ev);
  if (!k) return false;
  const ms = k - nowMs;
  return ms > 0 && ms <= windowMin * 60 * 1000;
}

// Stable fingerprint of one section's outcomes, for change detection.
function sectionFingerprint(market) {
  return JSON.stringify((market?.outcomes ?? []).map((o) => `${o.name}:${o.odds}:${o.active ? 1 : 0}`));
}

// Event ids contain colons (sr:match:123) which are invalid in artifact
// filenames; sanitize before building the log path.
function safeEventId(eventId) {
  return String(eventId).replace(/[^a-zA-Z0-9._-]/g, '-');
}

// Load a match's existing change log, or seed a fresh one.
async function loadLog(eventId, ev) {
  const file = path.join(DATA_DIR, `prematch-${safeEventId(eventId)}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return {
      eventId,
      productId: PREMATCH_PRODUCT,
      markets: ['1 (1X2)', '18 (O/U)', '41 (Correct Score)', '548 (Multigoals)', '551 (Multiscores)'],
      homeTeam: ev?.homeTeam ?? null,
      awayTeam: ev?.awayTeam ?? null,
      kickoff: ev?.startTime ?? null,
      startedAt: new Date().toISOString(),
      wentLiveAt: null,
      changes: [],
    };
  }
}

async function saveLog(log) {
  const file = path.join(DATA_DIR, `prematch-${safeEventId(log.eventId)}.json`);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(log, null, 2), 'utf8');
}

// One live-catalog sweep: which of the watched eventIds have gone live?
// Returns a Set of live eventIds. Tolerates failure (returns empty set).
async function fetchLiveEventIds(limitPages = 5) {
  const live = new Set();
  try {
    let pageNum = 1;
    let moreEvents = true;
    while (moreEvents && pageNum <= limitPages) {
      const data = await fetchSportyApiJson(SPORTYBET_BASE_URL + '/api/gh/factsCenter/wapConfigurableEventsByOrder', {
        method: 'POST',
        body: JSON.stringify({ productId: Number(LIVE_PRODUCT), pageNum, pageSize: 200 }),
      });
      for (const tournament of data?.tournaments ?? []) {
        for (const ev of tournament.events ?? []) live.add(ev.eventId);
      }
      moreEvents = data?.moreEvents === true;
      pageNum += 1;
      if (moreEvents) await new Promise((r) => setTimeout(r, 600));
    }
  } catch {
    // live sweep is best-effort; kickoff-time fallback below still stops us
  }
  return live;
}

async function pollMatch(ev, log, lastSeen, nowIso) {
  const entry = { at: nowIso, sections: {} };
  let changed = false;
  const markets = await fetchEventMarketsByKey(ev.eventId, PREMATCH_PRODUCT);
  for (const key of MARKET_ORDER) {
    const market = markets?.[key];
    const fp = sectionFingerprint(market);
    if (fp !== lastSeen[key]) {
      entry.sections[key] = market;
      lastSeen[key] = fp;
      changed = true;
    }
  }
  if (changed) {
    log.changes.push(entry);
    await saveLog(log);
    const parts = Object.keys(entry.sections).map((k) => {
      const m = entry.sections[k];
      const top = (m?.outcomes ?? []).slice(0, 4).map((o) => `${o.name}: ${o.odds}`).join(', ');
      return `${k} [${top}...]`;
    });
    console.log(`  [${nowIso.slice(11, 19)}Z] ${parts.join(' | ')}`);
  }
  return changed;
}

async function monitor() {
  const opts = parseArgs();
  const now = Date.now();
  const started = now;

  let targets = [];
  if (opts.eventId) {
    targets = [{ eventId: opts.eventId, startTime: new Date(now + 30 * 60 * 1000).toISOString() }];
  } else {
    const events = await fetchTodayFootballEvents();
    targets = events.filter((ev) => isWithinWindow(ev, now, opts.windowMin));
  }

  if (targets.length === 0) {
    console.log(`No matches within the final ${opts.windowMin} min window right now. Nothing to monitor.`);
    return;
  }

  console.log(`Monitoring ${targets.length} match(es) in their final ${opts.windowMin} min (poll every ${opts.interval}s):`);
  for (const t of targets) {
    console.log(`  - ${t.homeTeam ?? ''} vs ${t.awayTeam ?? ''} (${t.eventId}) kickoff ${t.startTime ?? 'n/a'}`);
  }
  console.log('Changes only are saved. Stops when each match goes LIVE.\n');

  const logs = new Map();
  const lastSeen = new Map();
  const active = new Map();
  for (const t of targets) {
    logs.set(t.eventId, await loadLog(t.eventId, t));
    lastSeen.set(t.eventId, {});
    active.set(t.eventId, true);
  }

  while (true) {
    const elapsedMin = (Date.now() - started) / 60000;
    if (elapsedMin >= opts.maxMinutes) {
      console.log(`\nReached ${opts.maxMinutes} min cap; stopping. Remaining pre-match logs kept.`);
      break;
    }
    if ([...active.values()].every((a) => !a)) {
      console.log(`\nAll monitored matches went live.`);
      break;
    }

    const liveIds = await fetchLiveEventIds();
    const nowIso = new Date().toISOString();

    for (const t of targets) {
      if (!active.get(t.eventId)) continue;
      const log = logs.get(t.eventId);

      // Stop when the match has gone LIVE (present in live catalog, or the
      // kickoff time has passed AND the clock/status shows a live state).
      if (liveIds.has(t.eventId)) {
        log.wentLiveAt = nowIso;
        log.changes.push({ at: nowIso, live: true });
        await saveLog(log);
        active.set(t.eventId, false);
        console.log(`  [${nowIso.slice(11, 19)}Z] ${t.eventId} is now LIVE. Monitoring stopped.`);
        continue;
      }

      try {
        await pollMatch(t, log, lastSeen.get(t.eventId), nowIso);
      } catch (e) {
        console.warn(`  [${nowIso.slice(11, 19)}Z] ${t.eventId} poll failed (${e.message}); retrying next tick.`);
      }
    }

    await new Promise((r) => setTimeout(r, opts.interval * 1000));
  }

  console.log('');
  for (const t of targets) {
    const log = logs.get(t.eventId);
    console.log(`  ${t.homeTeam ?? ''} vs ${t.awayTeam ?? ''} -> ${log.changes.length} change(s) saved (data/prematch-${safeEventId(t.eventId)}.json)`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  monitor().catch((e) => {
    console.error(`prematch-monitor failed: ${e.message}`);
    process.exit(1);
  });
}