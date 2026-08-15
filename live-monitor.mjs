import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchSportyApiJson, assertEventListShape, SPORTYBET_BASE_URL, TARGET_SPORT } from './lib/common.mjs';

// Poll a live event's 1X2 market and log every odds change as it is seen.
// Usage:
//   node live-monitor.mjs <eventId>              # watch one match's 1X2
//   node live-monitor.mjs                        # auto-follow live football (productId 1)
//   node live-monitor.mjs <eventId> --seconds 5  # poll interval (default 5s)
//   node live-monitor.mjs <eventId> --max 60     # stop after N polls (default run forever)
//
// Output: data/live-1x2-<eventId>.json — a full change log. Every row is the
// odds exactly as shown by the API at that moment; only CHANGES are appended.

const LIVE_PRODUCT = '1'; // 1 = live, 3 = pre-match

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { eventId: null, seconds: 5, max: Infinity };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--seconds') opts.seconds = Number(args[++i]);
    else if (args[i] === '--max') opts.max = Number(args[++i]);
    else opts.eventId = args[i];
  }
  return opts;
}

function clockText(ev) {
  return ev.minute ?? ev.matchClock ?? ev.matchStatus ?? '';
}

async function fetchLiveFootball() {
  const data = await fetchSportyApiJson(SPORTYBET_BASE_URL + '/api/gh/factsCenter/wapConfigurableEventsByOrder', {
    method: 'POST',
    body: JSON.stringify({ productId: Number(LIVE_PRODUCT), pageNum: 1, pageSize: 200 }),
  });
  assertEventListShape(data);
  const events = [];
  for (const t of data?.tournaments ?? []) {
    for (const ev of t.events ?? []) {
      if (ev.sport?.id !== TARGET_SPORT) continue;
      events.push({
        eventId: ev.eventId,
        homeTeam: ev.homeTeamName,
        awayTeam: ev.awayTeamName,
        clock: clockText(ev),
      });
    }
  }
  return events;
}

// Read 1X2 (market id 1) odds exactly as shown. Returns { Home, Draw, Away } or
// null if the market is suspended/missing. Does NOT throw on suspension.
async function fetchOneXTwo(eventId) {
  try {
    const detail = await fetchSportyApiJson(
      `${SPORTYBET_BASE_URL}/api/gh/factsCenter/event?productId=${LIVE_PRODUCT}&eventId=${encodeURIComponent(eventId)}`
    );
    const m1 = (detail?.markets ?? []).find((m) => String(m.id) === '1');
    if (!m1) return null;
    const out = {};
    for (const o of m1.outcomes ?? []) {
      const name = (o.desc ?? o.name ?? '').trim();
      if (name === 'Home' || name === '1') out.Home = parseFloat(o.odds);
      else if (name === 'Draw' || name === 'X') out.Draw = parseFloat(o.odds);
      else if (name === 'Away' || name === '2') out.Away = parseFloat(o.odds);
    }
    return out.Home && out.Draw && out.Away ? out : null;
  } catch {
    return null; // transient network/API error = market "not seen this tick"
  }
}

function key(o) {
  return o ? `${o.Home}|${o.Draw}|${o.Away}` : null;
}

function delta(a, b) {
  if (!a || !b) return null;
  const d = {};
  for (const k of ['Home', 'Draw', 'Away']) {
    if (a[k] !== b[k]) d[k] = b[k] > a[k] ? `up ${(b[k] - a[k]).toFixed(2)}` : `down ${(a[k] - b[k]).toFixed(2)}`;
  }
  return d;
}

async function loadLog(eventId) {
  const file = path.join('data', `live-1x2-${eventId}.json`);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return { eventId, productId: LIVE_PRODUCT, market: '1 (1X2)', startedAt: new Date().toISOString(), changes: [] };
  }
}

async function main() {
  const opts = parseArgs();
  let eventId = opts.eventId;

  if (!eventId) {
    const live = await fetchLiveFootball();
    if (!live.length) {
      console.log('No live football right now. Pass an eventId, e.g. for a live cricket match:');
      console.log('  node live-monitor.mjs <eventId>');
      return;
    }
    eventId = live[0].eventId;
    console.log(`Auto-following live football: ${live[0].homeTeam} vs ${live[0].awayTeam} (${live[0].eventId})`);
  }

  const log = await loadLog(eventId);
  let last = null;
  let poll = 0;
  console.log(`Recording 1X2 odds for ${eventId} every ${opts.seconds}s (market shows as: Home | Draw | Away)`);
  console.log('Changes only are saved. Ctrl+C to stop.\n');

  const flush = async () => {
    const file = path.join('data', `live-1x2-${eventId}.json`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(log, null, 2), 'utf8');
  };

  const tick = async () => {
    poll++;
    const now = new Date().toISOString();
    const o = await fetchOneXTwo(eventId);
    if (o && key(o) !== key(last)) {
      log.changes.push({ at: now, minute: null, ...o, change: delta(last, o) });
      const chg = delta(last, o)
        ? Object.entries(delta(last, o)).map(([k, v]) => `${k} ${v}`).join(', ')
        : 'first sighting';
      console.log(`[${now.slice(11, 19)}Z] Home=${o.Home}  Draw=${o.Draw}  Away=${o.Away}  (${chg})`);
      last = o;
      await flush();
    } else if (o) {
      // same odds as last seen — no change, no save
    } else {
      log.changes.push({ at: now, minute: null, Home: null, Draw: null, Away: null, suspended: true });
      console.log(`[${now.slice(11, 19)}Z] market suspended / not seen this tick`);
      last = null;
      await flush();
    }
  };

  await tick();
  const timer = setInterval(async () => {
    if (poll >= opts.max) {
      clearInterval(timer);
      console.log(`\nStopped after ${poll} polls. Log: data/live-1x2-${eventId}.json`);
      process.exit(0);
    }
    await tick();
  }, opts.seconds * 1000);

  process.on('SIGINT', async () => {
    clearInterval(timer);
    await flush();
    console.log(`\nSaved ${log.changes.length} change(s) to data/live-1x2-${eventId}.json`);
    process.exit(0);
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`live-monitor failed: ${e.message}`);
    process.exit(1);
  });
}