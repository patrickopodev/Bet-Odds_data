import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA_DIR, UA, MARKET_ORDER, TARGET_MARKET_IDS } from './lib/common.mjs';

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? '/usr/bin/chromium';
const PHONE = process.env.SPORTYBET_PHONE;
const PASSWORD = process.env.SPORTYBET_PASSWORD;
const BASE_URL = 'https://www.sportybet.com';
const HOME_URL = BASE_URL + '/gh/m/';

// Four odds sections: "1X2 / O/U" (Main tab: 1X2 + Over/Under), "Correct Score
// [0:0]" (Match tab), "Multiscores" (Goals tab), "Multigoals" (Goals tab).
// "All" sub-tab is a catch-all for any stragglers.
const SUBTABS = process.env.DEBUG_HTML_DIR
  ? ['All', 'Main', 'Goals', 'Corners', 'Half', 'Players', 'Teams', 'Match', 'Bookings', 'Combo', 'Minutes']
  : ['Main', 'Goals', 'Match', 'All'];

if (!PHONE || !PASSWORD) {
  console.error('Set SPORTYBET_PHONE and SPORTYBET_PASSWORD first.');
  process.exit(1);
}

let browser;
let page;

function mark(msg) {
  console.log(msg);
}

async function waitLoaded() {
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(2000);
    const t = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
    if (!/Loading\.\.\./.test(t)) return true;
  }
  return false;
}

async function login() {
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  const loginBtn = page.locator('text=/log\\s*in/i').first();
  if (await loginBtn.count()) {
    await loginBtn.click({ timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  const phone = page.locator('input[type=tel]').first();
  await phone.click().catch(() => {});
  await phone.fill(PHONE).catch(() => {});
  const pw = page.locator('input[type=password]').first();
  await pw.click().catch(() => {});
  await pw.fill(PASSWORD).catch(() => {});
  await page.locator('button:has-text("Login")').first().click({ timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(8000);
  const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');
  return /Deposit|balance|GHS/.test(body);
}

// Land on the TODAY'S FOOTBALL grid. The mobile homepage usually shows it
// already, but click the "TODAY'S FOOTBALL" entry if present so we are
// unambiguously on the right section before we start enumerating matches.
async function gotoTodaysFootball() {
  const link = page.getByText(/today'?s\s+football/i).first();
  if (await link.count()) {
    await link.click({ timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(4000);
  }
  await waitLoaded();
  console.log('On TODAY\'S FOOTBALL grid.');
}

// Match rows on the TODAY'S FOOTBALL homepage grid: each match is a 3-row
// group (top = tournament, mid = teams + kickoff, bottom = 1X2 odds).
async function listFootballMatches() {
  return page.evaluate(() => {
    const all = [...document.querySelectorAll('[role="row"]')];
    const out = [];
    for (let i = 0; i + 2 < all.length; i++) {
      const top = (all[i].innerText || '').replace(/\s+/g, ' ').trim();
      const mid = (all[i + 1].innerText || '').replace(/\s+/g, ' ').trim();
      const bot = (all[i + 2].innerText || '').replace(/\s+/g, ' ').trim();
      if (/Football/.test(top) && /1X2/.test(mid)) {
        const a =
          all[i].closest('a') || all[i + 1].closest('a') || all[i + 2].closest('a') ||
          all[i].querySelector('a') || all[i + 1].querySelector('a') || all[i + 2].querySelector('a');
        out.push({ gridIndex: i + 1, top, mid, bot, href: a ? a.href : '' });
      }
    }
    return out;
  });
}

// Parse a match record from the TODAY'S FOOTBALL list row + the detail body.
// listRow = { top: "Football - Int Clubs - UEFA Super Cup", mid: "PSG 15:00 Today 1X2 Aston Villa", bot: odds }
// detailBody carries the exact Game ID and date.
function parseMatchInfo(listRow, detailBody) {
  const body = (detailBody || '').replace(/\s+/g, ' ').trim();
  const top = (listRow?.top || '').replace(/^HOT\s*/, '').replace(/^Football\s*-\s*/, '');
  const mid = (listRow?.mid || '').replace(/\s+/g, ' ').trim();

  // tournament / category: strip leading "Football - ", then first tier = category
  let category = null, tournament = null;
  const tourSrc = top || body;
  const tourMatch = tourSrc.match(/Football\s*-\s*(.+)/i);
  const tourLine = (tourMatch ? tourMatch[1] : tourSrc).trim();
  if (tourLine) {
    const parts = tourLine.split(' - ').map((s) => s.trim()).filter(Boolean);
    category = parts[0] || null;
    tournament = parts.slice(1).join(' - ') || null;
  }

  // teams: three detail-body shapes are seen in the wild:
  //   pre-match : "Home DD/MM Day HH:MM Away Game ID <n>"
  //   in-play   : "... H2 HomeScore AwayScore ..." (live clock + period + scores)
  //   generic   : "Home vs Away"
  let homeTeam = null, awayTeam = null;
  const teamM =
    body.match(/([A-Za-z0-9 .'&-]+?)\s+\d{1,2}\/\d{1,2}\s+[A-Za-z]+\s+\d{1,2}:\d{2}\s+([A-Za-z0-9 .'&-]+?)(?=\s+Game\s*ID|\s*$)/i)
    || body.match(/\bH[12]\b[^A-Za-z0-9]*([A-Za-z0-9 .'&-]+?)\s+\d{1,2}\s+([A-Za-z0-9 .'&-]+?)\s+\d{1,2}\b/i)
    || body.match(/([A-Za-z0-9 .'&-]+?)\s+vs\s+([A-Za-z0-9 .'&-]+)/i)
    || mid.match(/([A-Za-z0-9 .'&-]+?)\s+vs\s+([A-Za-z0-9 .'&-]+)/i);
  if (teamM) { homeTeam = teamM[1].trim(); awayTeam = teamM[2].trim(); }

  // kickoff: "06/08 Thursday 16:00"
  let kickoff = null;
  const dateM = body.match(/\b(\d{2})\/(\d{2})\b/);
  const timeM = body.match(/\b(\d{1,2}:\d{2})\b/);
  if (dateM && timeM) kickoff = `${dateM[1]}/${dateM[2]} ${timeM[1]}`;

  const gameIdM = body.match(/Game ID\s*(\d+)/i) || mid.match(/ID\s*(\d+)/) || top.match(/ID\s*(\d+)/);
  const gameId = gameIdM ? gameIdM[1] : null;
  const matchStatus = /Live/.test(body) ? 'live' : (/Finished/.test(body) ? 'finished' : null);

  if (!homeTeam || !tournament) {
    console.warn('  parseMatchInfo partial: home=' + homeTeam + ' tour=' + tournament +
      ' | body="' + body.slice(0, 240) + '"');
  }

  return { category, tournament, homeTeam, awayTeam, kickoff, matchStatus, gameId };
}

async function extractMarkets() {
  const byId = {};
  for (const subtab of SUBTABS) {
    const tab = page.getByText(subtab, { exact: true }).filter({ visible: true }).first();
    if (await tab.count()) {
      await tab.click({ timeout: 10000 }).catch(() => {});
      await page.waitForTimeout(3500);
    }
    // Markets can load after the tab switches (esp. on live/in-play pages); wait
    // for at least one block so we don't read an empty tab.
    await page.waitForSelector('.m-market', { timeout: 10000 }).catch(() => {});
    const titles = await page.evaluate(() => [...document.querySelectorAll('.m-market .m-market-title')].map((el) => (el.innerText || '').replace(/\s+/g, ' ').trim()));
    if (process.env.DEBUG_HTML_DIR) console.log(`  [debug] subtab '${subtab}' market titles: ${JSON.stringify(titles)}`);
    const blocks = await page.evaluate(() => [...document.querySelectorAll('.m-market')].map((el) => el.outerHTML));
    for (const html of blocks) {
      const parsed = await page.evaluate((h) => {
        const doc = document.createElement('div');
        doc.innerHTML = h;
        const block = doc.querySelector('.m-market');
        const titleEl = block.querySelector('.m-market-title .text') || block.querySelector('.m-market-title');
        const title = titleEl ? (titleEl.innerText || '').replace(/\s+/g, ' ').trim() : '';
        const marketId = (/^1\s?x\s?2$/i.test(title) || /match result|full[- ]?time result/i.test(title)) ? '1'
          : /over\s*\/?\s*under/.test(title.toLowerCase()) ? '18'
          : /correct\s*score/.test(title.toLowerCase()) ? '41'
          : /multiscores/.test(title.toLowerCase()) ? '551'
          : /multigoals/.test(title.toLowerCase()) ? '548'
          : null;
        if (!marketId) return null;
        const table = block.querySelector('.market-content');
        const outcomes = [];
        if (table) {
          const rows = [...table.querySelectorAll('.m-table-row')];
          let headerCols = [];
          for (let ri = 0; ri < rows.length; ri++) {
            const cells = [...rows[ri].children].filter((c) => c.classList.contains('m-table-cell'));
            const oddsCells = cells.filter((c) => c.classList.contains('m-outcome'));
            if (oddsCells.length === 0 && ri === 0 && cells.length > 1) {
              headerCols = cells.map((c) => (c.innerText || '').trim());
              continue;
            }
            const nameCells = cells.filter((c) => !c.classList.contains('m-outcome') && (c.innerText || '').trim());
            const rowName = nameCells.map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ');
            for (let ci = 0; ci < oddsCells.length; ci++) {
              const oc = oddsCells[ci];
              const oddsEl = oc.querySelector('.m-odds-value');
              const odds = oddsEl ? parseFloat((oddsEl.innerText || '').trim()) : NaN;
              if (Number.isNaN(odds)) continue;
              const name = marketId === '18' ? `${headerCols[ci] || ''} ${rowName}`.trim() : rowName;
              const suspended = !!oc.querySelector('.m-outcome-lock, .m-outcome-suspension, .m-odds-off');
              outcomes.push({ name, odds, active: !suspended });
            }
          }
        }
        return { marketId, title, outcomes, html: h };
      }, html);
      if (parsed && (!byId[parsed.marketId] || (byId[parsed.marketId].outcomes.length === 0 && parsed.outcomes.length > 0))) {
        byId[parsed.marketId] = parsed;
      }
      if (process.env.DEBUG_HTML_DIR) {
        const dir = process.env.DEBUG_HTML_DIR;
        require('node:fs').mkdirSync(dir, { recursive: true });
        const safe = ((parsed?.title) || `noid_${parsed?.marketId || 'x'}`).replace(/[^A-Za-z0-9]+/g, '_');
        require('node:fs').writeFileSync(`${dir}/${subtab}-${safe}.html`, html);
      }
    }
  }
  return byId;
}



async function writeSnapshot(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stamp = data.scrapedAt.replace(/[:.]/g, '-');
  const filename = path.join(DATA_DIR, `snapshot-${stamp}.json`);
  await fs.writeFile(filename, JSON.stringify(data, null, 2), 'utf8');
  await fs.writeFile(path.join(DATA_DIR, 'latest.json'), JSON.stringify(data, null, 2), 'utf8');
  return filename;
}

async function run() {
  console.log('=== SportyBet Odds Scraper (Playwright UI) ===');
  browser = await chromium.launch({
    executablePath: CHROMIUM_PATH,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  page = await browser.newPage({ userAgent: UA });
  page.setDefaultTimeout(25000);

  const loggedIn = await login();
  if (!loggedIn) {
    console.error('Login failed (blocked or bad creds). Aborting without overwriting latest.json.');
    await browser.close();
    process.exit(1);
  }
  console.log('Logged in.');

  if (process.env.LIST_ONLY) {
    await gotoTodaysFootball();
    const list = await listFootballMatches();
    console.log('MATCHES FOUND:', list.length);
    for (const m of list) console.log(`  [${m.gridIndex}] ${m.top} || ${m.mid}`);
    await browser.close();
    process.exit(0);
  }

  const matches = [];
  const seen = new Set();      // signature of successfully scraped rows
  const attempts = new Map();  // signature -> how many times we've tried a row
  let skips = 0;

  const limit = process.env.MATCH_LIMIT ? parseInt(process.env.MATCH_LIMIT, 10) : Infinity;

  await gotoTodaysFootball();

  const sigOf = (m) => m.href || `${m.top} || ${m.mid}`;

  // THE TRICK: from TODAY'S FOOTBALL, open the first not-yet-done match, scrape
  // the 4 target markets, go back, then repeat. We re-read the list every pass
  // and pick the first row we haven't finished, so we never skip a match and
  // never stop until every listed match for the day has been covered.
  let safety = 0;
  while (matches.length < limit) {
    if (++safety > 5000) {
      console.error('Safety cap hit - stopping to avoid a loop.');
      break;
    }
    const list = await listFootballMatches();
    const next = list.find((m) => {
      const s = sigOf(m);
      return !seen.has(s) && (attempts.get(s) || 0) < 3;
    });
    if (!next) break; // every listed match has been scraped (or retried enough)

    const sig = sigOf(next);
    attempts.set(sig, (attempts.get(sig) || 0) + 1);

    const rowEl = page.locator('[role="row"]').nth(next.gridIndex);
    await rowEl.click({ force: true, timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(6000);
    await waitLoaded();
    await page.waitForTimeout(2500);

    const eventMatch = page.url().match(/sr:match:(\d+)/);
    const eventId = eventMatch ? eventMatch[1] : null;

    // If this detail page is one we already recorded (list reordered), skip it.
    if (eventId && seen.has('e:' + eventId)) {
      seen.add(sig);
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
      await waitLoaded();
      continue;
    }

    const body = (await page.locator('body').innerText().catch(() => '')).replace(/\s+/g, ' ');

    // SKIP_LIVE: jump over in-play matches so we land on a pre-match fixture
    // (Multigoals / Multiscores / Correct Score only exist before kickoff).
    if (process.env.SKIP_LIVE && /Live In-Play|Live/.test(body)) {
      seen.add(sig);
      if (eventId) seen.add('e:' + eventId);
      console.log('  [skip-live] in-play match, skipping (SKIP_LIVE=1)');
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
      await waitLoaded();
      continue;
    }
    const header = parseMatchInfo(next, body);
    const byId = await extractMarkets();

    const marketsByKey = {};
    for (const key of MARKET_ORDER) marketsByKey[key] = null;
    for (const [id, mm] of Object.entries(byId)) {
      const key = TARGET_MARKET_IDS[id];
      if (!key) continue;
      // Tag every outcome with its own market id so the merged "1X2 / O/U"
      // section and the DB ingest can still tell 1X2 apart from Over/Under.
      const outs = mm.outcomes.map((o) => ({ ...o, marketId: id }));
      if (key === '1X2 / O/U') {
        const existing = marketsByKey[key];
        marketsByKey[key] = {
          marketId: '1+18',
          name: key,
          group: null,
          outcomes: (existing?.outcomes ?? []).concat(outs),
        };
      } else if (mm.outcomes.length > 0) {
        marketsByKey[key] = { marketId: id, name: key, group: null, outcomes: outs };
      }
    }

    let startTime = null;
    if (header.kickoff) {
      const km = header.kickoff.match(/^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/);
      if (km) {
        const now = new Date();
        const d = new Date(Date.UTC(now.getUTCFullYear(), parseInt(km[2], 10) - 1, parseInt(km[1], 10), parseInt(km[3], 10), parseInt(km[4], 10)));
        startTime = d.toISOString();
      }
    }

    if (!header.homeTeam || !header.awayTeam) {
      // Row didn't open to a usable match page; back off and let the retry
      // logic (or safety cap) handle it instead of recording a broken record.
      await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(3000);
      await waitLoaded();
      continue;
    }

    const rec = {
      eventId,
      gameId: header.gameId,
      homeTeam: header.homeTeam,
      awayTeam: header.awayTeam,
      startTime,
      matchStatus: header.matchStatus,
      tournament: header.tournament,
      category: header.category,
      markets: Object.fromEntries(MARKET_ORDER.map((k) => [k, marketsByKey[k]])),
    };
    matches.push(rec);
    seen.add(sig);
    if (eventId) seen.add('e:' + eventId);
    const present = Object.entries(rec.markets).filter(([, v]) => v && v.outcomes.length > 0).map(([k]) => k);
    console.log(`  [${matches.length}] ${rec.homeTeam} vs ${rec.awayTeam} (id ${rec.eventId}) markets: ${present.join(', ') || 'none'}`);

    // THE TRICK: move back to TODAY'S FOOTBALL, then the next pass picks the next match
    await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {});
    await page.waitForTimeout(3500);
    await waitLoaded();
  }

  if (matches.length === 0) {
    console.error('Scrape returned 0 matches - aborting without overwriting latest.json.');
    await browser.close();
    process.exit(1);
  }

  const data = {
    scrapedAt: new Date().toISOString(),
    source: 'sportybet.com/gh/m/ (Playwright UI)',
    marketIds: Object.fromEntries(Object.keys(TARGET_MARKET_IDS).map((id) => [id, true])),
    matches,
  };
  const filename = await writeSnapshot(data);
  console.log('');
  console.log('=== Results ===');
  console.log(`Saved to: ${filename}`);
  console.log(`Matches: ${matches.length}${skips ? ` (${skips} skipped as duplicate)` : ''}`);
  await browser.close();
}

run().catch(async (e) => {
  console.error(`Scrape failed: ${e.message}`);
  if (browser) await browser.close().catch(() => {});
  process.exit(1);
});
