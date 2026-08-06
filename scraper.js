import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import * as cheerio from 'cheerio';

const TARGET_URL = process.env.TARGET_URL ?? 'https://www.sportybet.com/gh/m/';
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fetchHtml(url, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await axios.get(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        timeout: 30000,
        maxRedirects: 5,
      });
      if (response.status !== 200) {
        throw new Error(`HTTP ${response.status}`);
      }
      return response.data;
    } catch (error) {
      lastError = error;
      const delayMs = attempt * 2000;
      console.warn(`Attempt ${attempt}/${retries} failed for ${url}: ${error.message}. Retrying in ${delayMs}ms...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

function parsePage(html, sourceUrl) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim() || null;
  const metaDescription = $('meta[name="description"]').attr('content') ?? null;
  const metaKeywords = $('meta[name="keywords"]').attr('content') ?? null;

  const navLinks = [];
  $('a[href]').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    const href = $(el).attr('href');
    if (text && href && href !== '#') {
      navLinks.push({ text, href });
    }
  });

  const headings = [];
  $('h1, h2, h3').each((_, el) => {
    const text = $(el).text().trim().replace(/\s+/g, ' ');
    if (text) headings.push(text);
  });

  return {
    scrapedAt: new Date().toISOString(),
    sourceUrl,
    title,
    metaDescription,
    metaKeywords,
    headings: [...new Set(headings)].slice(0, 50),
    navLinks: navLinks.slice(0, 100),
    htmlBytes: Buffer.byteLength(html),
  };
}

async function writeSnapshot(snapshot) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const stamp = snapshot.scrapedAt.replace(/[:.]/g, '-');
  const filename = path.join(DATA_DIR, `snapshot-${stamp}.json`);
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
  const html = await fetchHtml(TARGET_URL);
  const snapshot = parsePage(html, TARGET_URL);
  const filename = await writeSnapshot(snapshot);
  console.log(`Saved snapshot to ${filename}`);
  console.log(
    `Title: ${snapshot.title} | Headings: ${snapshot.headings.length} | Links: ${snapshot.navLinks.length}`
  );
}

run().catch((error) => {
  console.error(`Scrape failed: ${error.message}`);
  process.exit(1);
});