import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL ?? 'https://www.sportybet.com/gh/m/';
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const PHONE = process.env.SPORTYBET_PHONE ?? '';
const PASSWORD = process.env.SPORTYBET_PASSWORD ?? '';
const TIMEOUT = 45000;

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

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function waitForAny(page, selectors, timeout = TIMEOUT) {
  for (const sel of selectors) {
    try {
      await page.waitForSelector(sel, { timeout: timeout / selectors.length });
      return sel;
    } catch { /* continue */ }
  }
  return null;
}

async function login(page) {
  if (!PHONE || !PASSWORD) {
    console.log('No credentials provided — skipping login (scraping public odds)');
    return false;
  }

  console.log('Logging in...');
  try {
    const loginBtn = await page.$('a[href*="login"], button:has-text("Log in"), [class*="login"]');
    if (loginBtn) {
      await loginBtn.click();
      await sleep(2000);
    }

    const phoneInput = await waitForAny(page, [
      'input[type="tel"]',
      'input[name="phone"]',
      'input[placeholder*="phone"]',
      'input[placeholder*="Phone"]',
    ], 10000);

    if (phoneInput) {
      await page.type(phoneInput, PHONE, { delay: 50 });
      await sleep(500);
    }

    const passwordInput = await waitForAny(page, [
      'input[type="password"]',
      'input[name="password"]',
    ], 5000);

    if (passwordInput) {
      await page.type(passwordInput, PASSWORD, { delay: 50 });
      await sleep(500);
    }

    const submitBtn = await waitForAny(page, [
      'button[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Log in")',
      '[class*="login-btn"]',
    ], 5000);

    if (submitBtn) {
      await page.click(submitBtn);
      await sleep(5000);
    }

    const loggedIn = await page.$('[class*="balance"], [class*="deposit"], [class*="avatar"]');
    if (loggedIn) {
      console.log('Login successful');
      return true;
    }

    console.warn('Login may have failed — continuing as guest');
    return false;
  } catch (e) {
    console.warn(`Login error: ${e.message} — continuing as guest`);
    return false;
  }
}

async function navigateToTodayFootball(page) {
  console.log('Navigating to Today\'s Football...');

  try {
    const todayTab = await waitForAny(page, [
      'text/TODAY\'S FOOTBALL',
      '[class*="tab"]:has-text("TODAY")',
      'button:has-text("TODAY")',
      'a:has-text("TODAY")',
    ], 10000);

    if (todayTab) {
      await page.click(todayTab);
      await sleep(3000);
    }
  } catch (e) {
    console.warn(`Could not find Today's Football tab: ${e.message}`);
  }

  await sleep(2000);
}

async function extractMatchesFromPage(page) {
  return page.evaluate(() => {
    const matches = [];
    const matchElements = document.querySelectorAll(
      '[class*="match-item"], [class*="event-item"], [class*="game-item"], ' +
      '[class*="match-row"], [class*="event-row"], [class*="game-row"], ' +
      '[class*="sport-event"], [class*="bet-event"]'
    );

    for (const el of matchElements) {
      try {
        const text = el.textContent || '';
        if (text.length < 10 || text.length > 3000) continue;

        const odds = [];
        const oddsEls = el.querySelectorAll('[class*="odd"], [class*="odds"], [class*="price"], [class*="value"]');
        for (const o of oddsEls) {
          const val = o.textContent.trim();
          if (/^\d+\.\d{2}$/.test(val)) odds.push(parseFloat(val));
        }

        if (odds.length < 2) continue;

        const teams = el.querySelectorAll('[class*="team-name"], [class*="team"], [class*="name"]');
        const home = teams[0]?.textContent?.trim() || '';
        const away = teams[1]?.textContent?.trim() || '';

        if (!home && !away) continue;

        const timeEl = el.querySelector('[class*="time"], [class*="date"], [class*="clock"]');
        const leagueEl = el.querySelector('[class*="league"], [class*="tournament"], [class*="competition"]');

        matches.push({
          home,
          away,
          time: timeEl?.textContent?.trim() || '',
          league: leagueEl?.textContent?.trim() || '',
          odds,
          rawText: text.replace(/\s+/g, ' ').trim().slice(0, 800),
        });
      } catch { continue; }
    }

    return matches;
  });
}

async function clickMarketTab(page, tabName) {
  const tabs = await page.$$('[class*="tab"], [class*="market"], [role="tab"]');
  for (const tab of tabs) {
    const text = await page.evaluate(el => el.textContent.trim().toLowerCase(), tab);
    if (text.includes(tabName.toLowerCase())) {
      await tab.click();
      await sleep(2500);
      return true;
    }
  }
  return false;
}

async function scrapeAllMarkets(page) {
  const markets = ['O/U', 'Correct Score', 'Multigoals', 'Multiscores'];
  const allData = {};

  for (const market of markets) {
    console.log(`Extracting ${market}...`);
    const clicked = await clickMarketTab(page, market);
    if (clicked) {
      const matches = await extractMatchesFromPage(page);
      allData[market] = matches;
      console.log(`  Found ${matches.length} matches for ${market}`);
    } else {
      console.warn(`  Tab "${market}" not found`);
      allData[market] = [];
    }
    await sleep(1000);
  }

  return allData;
}

async function extractOddsStructure(page) {
  return page.evaluate(() => {
    const info = {
      title: document.title,
      url: window.location.href,
      tabs: [],
      matchCount: 0,
      sampleOdds: [],
    };

    const tabs = document.querySelectorAll('[class*="tab"], [role="tab"], [class*="market"]');
    for (const t of tabs) {
      info.tabs.push(t.textContent.trim().replace(/\s+/g, ' ').slice(0, 50));
    }

    const allOdds = document.querySelectorAll('[class*="odd"], [class*="odds"], [class*="price"], [class*="value"]');
    for (const o of allOdds) {
      const val = o.textContent.trim();
      if (/^\d+\.\d{2}$/.test(val)) {
        info.sampleOdds.push(parseFloat(val));
        if (info.sampleOdds.length >= 20) break;
      }
    }

    const matches = document.querySelectorAll('[class*="match"], [class*="event"], [class*="game"]');
    info.matchCount = matches.length;

    return info;
  });
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
  await sleep(3000);

  await login(page);
  await sleep(2000);

  console.log('Checking page structure...');
  const pageInfo = await extractOddsStructure(page);
  console.log(`Page: ${pageInfo.title}`);
  console.log(`URL: ${pageInfo.url}`);
  console.log(`Tabs found: ${pageInfo.tabs.length} — ${pageInfo.tabs.join(' | ')}`);
  console.log(`Match elements: ${pageInfo.matchCount}`);
  console.log(`Sample odds: ${pageInfo.sampleOdds.slice(0, 10).join(', ')}`);

  await navigateToTodayFootball(page);

  console.log('Extracting 1X2 odds (default view)...');
  const defaultOdds = await extractMatchesFromPage(page);
  console.log(`Found ${defaultOdds.length} matches in default view`);

  const marketOdds = await scrapeAllMarkets(page);

  return {
    scrapedAt: new Date().toISOString(),
    sourceUrl: TARGET_URL,
    pageInfo,
    defaultOdds,
    marketOdds,
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

async function run() {
  console.log('=== SportyBet Odds Scraper ===');
  console.log(`Target: ${TARGET_URL}`);
  console.log(`Credentials: ${PHONE ? 'provided' : 'not set (guest mode)'}`);
  console.log('');

  const data = await scrapeSportyBet();
  const filename = await writeSnapshot(data);

  console.log('');
  console.log('=== Results ===');
  console.log(`Saved to: ${filename}`);
  console.log(`Default odds: ${data.defaultOdds.length} matches`);

  for (const [market, matches] of Object.entries(data.marketOdds)) {
    console.log(`${market}: ${matches.length} matches`);
  }

  if (data.defaultOdds.length > 0) {
    console.log('');
    console.log('Sample match:');
    console.log(JSON.stringify(data.defaultOdds[0], null, 2));
  }
}

run().catch((error) => {
  console.error(`Scrape failed: ${error.message}`);
  process.exit(1);
});
