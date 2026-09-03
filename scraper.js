import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  mapWithConcurrency,
  MARKET_ORDER,
  TARGET_MARKET_IDS_SET,
  fetchTodayFootballEvents,
  fetchEventMarketsByKey,
} from './lib/common.mjs';

const BASE_URL = 'https://www.sportybet.com';

export async function scrapeSportyBet({ fetchEvents = fetchTodayFootballEvents, fetchMarkets = fetchEventMarketsByKey } = {}) {
  console.log(`Fetching today's football events...`);
  const events = await fetchEvents();
  console.log(`Found ${events.length} football events today`);

  const results = await mapWithConcurrency(events, async (ev) => {
    const marketsByKey = await fetchMarkets(ev.eventId);
    return {
      eventId: ev.eventId,
      gameId: ev.gameId,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      startTime: ev.startTime ? new Date(ev.startTime).toISOString() : null,
      matchStatus: ev.matchStatus,
      tournament: ev.tournamentName,
      category: ev.categoryName,
      markets: marketsByKey,
    };
  });

  const failed = results.filter(r => r?.error);
  if (failed.length) {
    console.warn(`  ${failed.length} event(s) failed: ${failed[0].error}`);
  }

  // Collect all marketIds found across all matches (no TARGET_MARKET_IDS_SET filter)
  const allMarketIds = new Set();
  for (const m of results.filter(r => !r?.error)) {
    const mkts = m.markets;
    for (const [id, market] of Object.entries(mkts ?? {})) {
      if (market && market.marketId) allMarketIds.add(id);
    }
  }
  const marketIdsObj = Object.fromEntries([...allMarketIds].map(id => [id, true]));

  return {
    scrapedAt: new Date().toISOString(),
    source: 'sportybet.com/gh/m/',
    marketIds: marketIdsObj,
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

export function oddsMarkdown(outcomes) {
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
    // Genuinely no qualifying matches this cycle (or API returned empty). We
    // preserve the last good latest.json by NOT writing it, and exit 2 so the
    // collector can treat this as a soft/no-op (build-db + upload still run and
    // preserve the prior artifact) rather than a hard API failure (exit 1).
    console.error('Scrape returned 0 matches - preserving last good latest.json (exit 2: soft/no-op).');
    process.exit(2);
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

  // Correct Score (market 41) is only offered by SportyBet on a subset of
  // matches, so track how many actually carried it this cycle. The DB builder
  // (build-db.mjs) already records market 41 whenever present and stops at
  // kickoff, so this is purely visibility into capture breadth — if this count
  // is low, it reflects SportyBet's offering, not a scraper gap.
  let withCorrectScore = 0;
  for (const m of data.matches) {
    if (m.markets && m.markets['Correct Score [0:0]']) withCorrectScore++;
  }
  console.log(`Matches with Correct Score (market 41) odds: ${withCorrectScore}/${data.matches.length}`);

  if (data.matches.length > 0) {
    console.log('');
    console.log('Sample match:');
    console.log(JSON.stringify(data.matches[0], null, 2));
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((error) => {
    console.error(`Scrape failed: ${error.message}`);
    process.exit(1);
  });
}
