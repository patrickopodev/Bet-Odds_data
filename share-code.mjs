import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SPORTYBET_BASE_URL,
  fetchTodayFootballEvents,
  fetchEventMarkets,
  fetchJson,
} from './lib/common.mjs';

const SHARE_ENDPOINT = `${SPORTYBET_BASE_URL}/api/gh/orders/share`;
const SHARE_HEADERS = {
  'Content-Type': 'application/json;charset=UTF-8',
  'OperId': '0',
  'Referer': `${SPORTYBET_BASE_URL}/gh/m/`,
  'Origin': SPORTYBET_BASE_URL,
};

// "eventId,marketId,outcomeId[,specifier]" -> a selection object. Commas
// separate the fields because eventIds themselves contain colons
// ("sr:match:73014456"). The outcomeId is SportyBet's outcome id ("1" = Home on
// the 1X2 market), NOT the outcome name.
export function parseSelection(spec) {
  const parts = String(spec).split(',');
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`Invalid selection "${spec}" - expected "eventId,marketId,outcomeId[,specifier]"`);
  }
  const [eventId, marketId, outcomeId, specifier] = parts;
  if (!eventId || !marketId || !outcomeId) {
    throw new Error(`Invalid selection "${spec}" - all of eventId, marketId, outcomeId are required`);
  }
  return { eventId, marketId, outcomeId, ...(specifier ? { specifier } : {}) };
}

// Build a share code from a bet-slip of selections. No odds are sent - SportyBet
// resolves the current odds from the ids when the code is loaded.
export async function createShareCode(selections, { fetchImpl = fetchJson } = {}) {
  const res = await fetchImpl(`${SHARE_ENDPOINT}?throwInvalidEvent=true`, {
    method: 'POST',
    headers: SHARE_HEADERS,
    body: JSON.stringify({ selections }),
  });
  if (res.bizCode !== 10000) {
    throw new Error(`API error ${res.bizCode}: ${res.message ?? res.innerMsg}`);
  }
  const code = res.data?.shareCode;
  if (!code) throw new Error('Share response did not contain data.shareCode');
  return { code, data: res.data };
}

// Load a code's selections. Works without login; codes persist ~30 days.
export async function loadShareCode(code, { fetchImpl = fetchJson } = {}) {
  const res = await fetchImpl(`${SHARE_ENDPOINT}/${encodeURIComponent(code)}`);
  if (res.bizCode !== 10000) {
    throw new Error(`API error ${res.bizCode}: ${res.message ?? res.innerMsg}`);
  }
  return res.data;
}

export function shareUrl(code) {
  return `${SPORTYBET_BASE_URL}/gh/?shareCode=${code}`;
}

export function ticketSummary(data) {
  const ticket = data?.ticket ?? {};
  const rows = (ticket.selections ?? []).map((sel) => {
    const ev = (data.outcomes ?? []).find((e) => e.eventId === sel.eventId);
    const market = ev?.markets?.find((m) => String(m.id) === String(sel.marketId));
    const outcome = market?.outcomes?.find((o) => String(o.id) === String(sel.outcomeId));
    return {
      eventId: sel.eventId,
      teams: ev ? `${ev.homeTeamName} vs ${ev.awayTeamName}` : null,
      market: market?.desc ?? sel.marketId,
      outcome: outcome?.desc ?? sel.outcomeId,
      odds: outcome?.odds ?? null,
    };
  });
  const lines = [`Selections: ${rows.length}`];
  for (const r of rows) {
    lines.push(`  ${r.teams ?? r.eventId} | ${r.market} | ${r.outcome}${r.odds ? ` @ ${r.odds}` : ''}`);
  }
  if (data.deadline) lines.push(`Code valid until: ${new Date(data.deadline).toISOString()}`);
  if (ticket.displayTotalOdds) lines.push(`Total odds: ${ticket.displayTotalOdds}`);
  if (ticket.stake) lines.push(`Stake: ${ticket.stake}`);
  return lines.join('\n');
}

// Search today's pre-match catalog for an event by team name, and list the 1X2
// outcome ids so the caller can hand them straight to `create`.
export async function findEventSelections(query, { fetchEvents = fetchTodayFootballEvents, fetchMarkets = fetchEventMarkets } = {}) {
  const q = query.toLowerCase();
  const events = (await fetchEvents()).filter(
    (ev) => ev.homeTeam.toLowerCase().includes(q) || ev.awayTeam.toLowerCase().includes(q)
  );
  const out = [];
  for (const ev of events.slice(0, 10)) {
    const data = await fetchMarkets(ev.eventId).catch(() => null);
    const oneXTwo = (data?.markets ?? []).find((m) => String(m.id) === '1');
    out.push({
      eventId: ev.eventId,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      startTime: ev.startTime ? new Date(ev.startTime).toISOString() : null,
      outcomes: (oneXTwo?.outcomes ?? []).map((o) => ({ outcomeId: o.id, desc: o.desc })),
    });
  }
  return out;
}

async function run(argv) {
  const [cmd, ...args] = argv;

  if (cmd === 'create') {
    if (args.length === 0) {
      console.error('Usage: node share-code.mjs create "<eventId>,<marketId>,<outcomeId>" [more selections...]');
      process.exit(1);
    }
    const selections = args.map(parseSelection);
    const { code } = await createShareCode(selections);
    console.log(`Share code: ${code}`);
    console.log(`Share URL:  ${shareUrl(code)}`);
    console.log('');
    console.log(ticketSummary(await loadShareCode(code)));
    return;
  }

  if (cmd === 'load') {
    if (!args[0]) {
      console.error('Usage: node share-code.mjs load <CODE>');
      process.exit(1);
    }
    const data = await loadShareCode(args[0]);
    console.log(ticketSummary(data));
    console.log(`Share URL:  ${shareUrl(args[0])}`);
    return;
  }

  if (cmd === 'find') {
    const q = args.join(' ');
    if (!q) {
      console.error('Usage: node share-code.mjs find <team name>');
      process.exit(1);
    }
    const matches = await findEventSelections(q);
    if (matches.length === 0) {
      console.log(`No events found matching "${q}"`);
      return;
    }
    for (const m of matches) {
      console.log(`\n${m.homeTeam} vs ${m.awayTeam} (${m.startTime})`);
      console.log(`  eventId: ${m.eventId}`);
      for (const o of m.outcomes) console.log(`  outcomeId ${o.outcomeId}: ${o.desc}`);
    }
    console.log('\nCreate a code with:');
    console.log(`  node share-code.mjs create "<eventId>,1,<outcomeId>"`);
    return;
  }

  console.error(`Unknown command "${cmd}". Commands: create | load | find`);
  process.exit(1);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`share-code failed: ${error.message}`);
    process.exit(1);
  });
}