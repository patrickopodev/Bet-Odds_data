import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL ?? 'https://www.sportybet.com/gh/m/';
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const TIMEOUT = 30000;

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=375,812',
    ],
  });
}

async function waitForContent(page, selector, timeout = TIMEOUT) {
  try {
    await page.waitForSelector(selector, { timeout });
    return true;
  } catch {
    return false;
  }
}

async function extractOddsForMarket(page, marketTabText) {
  const oddsData = [];

  try {
    const tabs = await page.$$('.m-tab-item, [class*="tab"]');
    for (const tab of tabs) {
      const text = await page.evaluate(el => el.textContent.trim(), tab);
      if (text.toLowerCase().includes(marketTabText.toLowerCase())) {
        await tab.click();
        await new Promise(r => setTimeout(r, 2000));
        break;
      }
    }
  } catch (e) {
    console.warn(`Tab "${marketTabText}" not found: ${e.message}`);
  }

  const matches = await page.$$('.m-match-item, [class*="match-item"], [class*="event-item"]');
  for (const match of matches) {
    try {
      const data = await page.evaluate(el => {
        const teams = el.querySelectorAll('[class*="team-name"], [class*="team"]');
        const odds = el.querySelectorAll('[class*="odd"], [class*="odds"], [class*="price"]');
        const time = el.querySelector('[class*="time"], [class*="date"]');
        const league = el.querySelector('[class*="league"], [class*="tournament"]');

        return {
          home: teams[0]?.textContent?.trim() || '',
          away: teams[1]?.textContent?.trim() || '',
          time: time?.textContent?.trim() || '',
          league: league?.textContent?.trim() || '',
          odds: Array.from(odds).map(o => o.textContent.trim()).filter(Boolean),
        };
      }, match);

      if (data.home || data.away) {
        oddsData.push(data);
      }
    } catch {
      continue;
    }
  }

  return oddsData;
}

async function scrapeSportyBet() {
  console.log('Launching browser...');
  const browser = await launchBrowser();
  const page = await browser.newPage();

  await page.setViewport({ width: 375, height: 812 });
  await page.setUserAgent(
    'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36'
  );

  console.log(`Navigating to ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'networkidle2', timeout: TIMEOUT });

  await new Promise(r => setTimeout(r, 3000));

  const hasMatches = await waitForContent(page, '[class*="match"], [class*="event"], [class*="game"]', 10000);

  if (!hasMatches) {
    console.warn('No match elements detected — page may have changed structure');
  }

  console.log('Extracting football matches with odds...');

  const allData = await page.evaluate(() => {
    const result = [];
    const allElements = document.querySelectorAll('[class*="match"], [class*="event"], [class*="game"], [class*="card"]');

    for (const el of allElements) {
      const text = el.textContent || '';
      if (text.length < 10 || text.length > 2000) continue;

      const oddsMatch = text.match(/\d+\.\d{2}/g);
      if (!oddsMatch || oddsMatch.length < 2) continue;

      const teams = el.querySelectorAll('[class*="team"], [class*="name"]');
      const home = teams[0]?.textContent?.trim() || '';
      const away = teams[1]?.textContent?.trim() || '';

      if (!home && !away) continue;

      const timeEl = el.querySelector('[class*="time"], [class*="date"]');
      const leagueEl = el.querySelector('[class*="league"], [class*="tournament"]');

      result.push({
        home,
        away,
        time: timeEl?.textContent?.trim() || '',
        league: leagueEl?.textContent?.trim() || '',
        allOdds: oddsMatch,
        rawText: text.replace(/\s+/g, ' ').trim().slice(0, 500),
      });
    }

    return result;
  });

  console.log(`Found ${allData.length} potential match entries`);

  await browser.close();
  return allData;
}

async function writeSnapshot(data) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = path.join(DATA_DIR, `snapshot-${stamp}.json`);
  const snapshot = {
    scrapedAt: new Date().toISOString(),
    sourceUrl: TARGET_URL,
    matchCount: data.length,
    matches: data,
  };

  await fs.writeFile(filename, JSON.stringify(snapshot, null, 2), 'utf8');
  await fs.writeFile(
    path.join(DATA_DIR, 'latest.json'),
    JSON.stringify(snapshot, null, 2),
    'utf8'
  );
  return filename;
}

async function run() {
  console.log(`Scraping ${TARGET_URL}`);
  const data = await scrapeSportyBet();
  const filename = await writeSnapshot(data);
  console.log(`Saved snapshot to ${filename}`);
  console.log(`Matches: ${data.length}`);

  if (data.length > 0) {
    console.log('Sample match:', JSON.stringify(data[0], null, 2));
  }
}

run().catch((error) => {
  console.error(`Scrape failed: ${error.message}`);
  process.exit(1);
});
