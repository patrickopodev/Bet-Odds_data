import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DATA_DIR,
  mapWithConcurrency,
  MARKET_ORDER,
  TARGET_MARKET_IDS,
  TARGET_MARKET_IDS_SET,
  fetchTodayFootballEvents,
  fetchEventMarkets,
} from './lib/common.mjs';

const BASE_URL = 'https://www.sportybet.com';

// Sort Over/Under outcomes ascending by goal line (0.5, 1, 1.5, 2, ... 5.5)
// so each Over/Under pair reads like the UI table.
function sortOverUnder(outcomes) {
  return [...outcomes].sort((a, b) => {
    const va = parseFloat(a.name.replace(/[^\d.]/g, ''));
    const vb = parseFloat(b.name.replace(/[^\d.]/g, ''));
    if (va === vb) return a.name.startsWith('Under') ? 1 : -1;
    return (va || 0) - (vb || 0);
  });
}

// All other markets (Correct Score, Multiscores, Multigoals) keep the API's
// native outcome order, which matches the SportyBet UI exactly.
const MARKET_SORTERS = {
  '18': sortOverUnder,
};

async function getEventMarkets(eventId) {
  const data = await fetchEventMarkets(eventId);
  const markets = (data?.markets ?? []).filter(m => TARGET_MARKET_IDS_SET.has(String(m.id)));
  if (markets.length === 0) return [];

  const merged = {};
  for (const m of markets) {
    const id = String(m.id);
    if (!merged[id]) {
      merged[id] = { marketId: id, name: m.desc || m.name, group: m.group, outcomes: [] };
    }
    for (const o of m.outcomes ?? []) {
      merged[id].outcomes.push({
        name: o.desc,
        odds: parseFloat(o.odds),
        active: o.isActive === 1,
      });
    }
  }

  for (const m of Object.values(merged)) {
    const sorter = MARKET_SORTERS[m.marketId];
    if (sorter) m.outcomes = sorter(m.outcomes);
  }

  return Object.values(merged);
}

async function scrapeSportyBet() {
  console.log(`Fetching today's football events...`);
  const events = await fetchTodayFootballEvents();
  console.log(`Found ${events.length} football events today`);

  const results = await mapWithConcurrency(events, async (ev) => {
    const markets = await getEventMarkets(ev.eventId);
    const byId = {};
    for (const m of markets) byId[m.marketId] = m;
    const marketsByKey = {};
    for (const key of MARKET_ORDER) marketsByKey[key] = null;
    for (const [id, m] of Object.entries(byId)) {
      const key = TARGET_MARKET_IDS[id];
      if (!key) continue;
      const outs = m.outcomes.map((o) => ({ ...o, marketId: id }));
      if (key === '1X2 / O/U') {
        const existing = marketsByKey[key];
        marketsByKey[key] = {
          marketId: '1+18',
          name: key,
          group: null,
          outcomes: (existing?.outcomes ?? []).concat(outs),
        };
      } else {
        marketsByKey[key] = { marketId: id, name: key, group: null, outcomes: outs };
      }
    }
    return {
      eventId: ev.eventId,
      gameId: ev.gameId,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      startTime: ev.startTime ? new Date(ev.startTime).toISOString() : null,
      matchStatus: ev.matchStatus,
      tournament: ev.tournamentName,
      category: ev.categoryName,
      markets: Object.fromEntries(MARKET_ORDER.map(k => [k, marketsByKey[k]])),
    };
  });

  const failed = results.filter(r => r?.error);
  if (failed.length) {
    console.warn(`  ${failed.length} event(s) failed: ${failed[0].error}`);
  }

  return {
    scrapedAt: new Date().toISOString(),
    source: 'sportybet.com/gh/m/',
    marketIds: Object.fromEntries([...TARGET_MARKET_IDS_SET].map(id => [id, true])),
    matches: results.filter(r => !r?.error),
  };
}

async function writeSnapshot(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stamp = data.scrapedAt.replace(/[:.]/g, '-');
  const filename = path.join(DATA_DIR, `snapshot-${stamp}.json`);

  await fs.writeFile(filename, JSON.stringify(data, null, 2), 'utf8');
  await fs.writeFile(
    path.join(DATA_DIR, 'latest.json'),
    JSON.stringify(data, null, 2),
    'utf8'
  );
  return filename;
}

function oddsMarkdown(outcomes) {
  const rows = outcomes.map(o => `| ${o.name} | ${o.odds}${o.active ? '' : ' (suspended)'} |`);
  return `| Outcome | Odds |\n| --- | ---: |\n${rows.join('\n')}`;
}

async function writeReport(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stamp = data.scrapedAt.replace(/[:.]/g, '-');
  const filename = path.join(DATA_DIR, `report-${stamp}.md`);

  const groups = new Map();
  for (const m of data.matches) {
    if (!groups.has(m.tournament)) groups.set(m.tournament, []);
    groups.get(m.tournament).push(m);
  }

  const blocks = [`# SportyBet Odds Report`, ``, `_Scraped at ${data.scrapedAt} UTC_`, ``, `Total matches: ${data.matches.length}`, ``];

  for (const [tournament, matches] of groups) {
    blocks.push(`## ${tournament}`, ``);
    for (const m of matches) {
      const kickoff = m.startTime ? m.startTime.replace('T', ' ').slice(0, 16) + 'Z' : 'unknown';
      blocks.push(`### ${m.homeTeam} vs ${m.awayTeam}`, ``, `_Kickoff: ${kickoff}_`, ``);
      for (const key of MARKET_ORDER) {
        const market = m.markets[key];
        if (market && market.outcomes.length > 0) {
          blocks.push(`**${key}**`, ``, oddsMarkdown(market.outcomes), ``);
        }
      }
    }
  }

  await fs.writeFile(filename, blocks.join('\n'), 'utf8');
  return filename;
}

async function run() {
  console.log('=== SportyBet Odds Scraper (API) ===');
  console.log(`Base: ${BASE_URL}/gh/m/`);
  console.log('');

  const data = await scrapeSportyBet();

  if (data.matches.length === 0) {
    console.error('Scrape returned 0 matches - aborting without overwriting latest.json (API likely blocked or empty).');
    process.exit(1);
  }

  const filename = await writeSnapshot(data);
  const reportName = await writeReport(data);

  console.log('');
  console.log('=== Results ===');
  console.log(`Saved to: ${filename}`);
  console.log(`Report:  ${reportName}`);
  console.log(`Matches: ${data.matches.length}`);

  let withMarkets = 0;
  for (const m of data.matches) {
    const present = Object.entries(m.markets).filter(([, v]) => v && v.outcomes.length > 0);
    if (present.length > 0) withMarkets++;
  }
  console.log(`Matches with market data: ${withMarkets}`);

  if (data.matches.length > 0) {
    console.log('');
    console.log('Sample match:');
    console.log(JSON.stringify(data.matches[0], null, 2));
  }
}

run().catch((error) => {
  console.error(`Scrape failed: ${error.message}`);
  process.exit(1);
});
