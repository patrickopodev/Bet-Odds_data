import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, UA, decodeFeedBlock, fetchTodayFootballEvents, kickoffDeltaMs, normTeam, sameTeam } from './lib/common.mjs';

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || null;
const OUT = process.env.OUT || 'data/comparison.json';

// ---- Flashscore: full list of today's football ----
// Returns the raw feed text, or '' if the feed never fired (geo/captcha-gated
// pages, transient network issues). One reload retry is attempted since some
// gated pages only serve the feed after a second navigation.
async function captureFlashscoreFeed() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage({ userAgent: UA });
    let feedText = '';
    page.on('response', async (res) => {
      if (res.url().includes('f_1_0_-4_en_1')) {
        try { feedText = await res.text(); } catch {}
      }
    });
    const load = () => page.goto('https://www.flashscore.com/football/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await load();
    await page.waitForTimeout(10000);
    if (!feedText) {
      await load();
      await page.waitForTimeout(10000);
    }
    return feedText;
  } finally {
    await browser.close();
  }
}

function parseFlashscoreFeed(feedText) {
  const blocks = feedText.split('~');
  const matches = [];
  let league = null;
  for (const b of blocks) {
    const fields = decodeFeedBlock(b);
    if (fields.ZA) {
      league = fields.ZA;
      continue;
    }
    if (fields.AA && fields.CX && fields.AF && fields.AD) {
      matches.push({
        id: fields.AA,
        league,
        homeTeam: fields.CX,
        awayTeam: fields.AF,
        kickoff: Number(fields.AD) ? new Date(Number(fields.AD) * 1000).toISOString() : null,
      });
    }
  }
  return matches;
}

async function fetchFlashscoreToday() {
  const feedText = await captureFlashscoreFeed();
  if (!feedText) throw new Error('Flashscore feed not captured');
  return parseFlashscoreFeed(feedText);
}

// ---- SportyBet: today's matches via the full-catalog API (same method the
// scraper uses) ----
async function fetchSportyBetToday() {
  const events = await fetchTodayFootballEvents();
  const matches = [];
  const seen = new Set();
  for (const ev of events) {
    const key = `${ev.homeTeam} vs ${ev.awayTeam}`;
    if (seen.has(key)) continue;
    seen.add(key);
    matches.push({
      id: ev.eventId,
      league: ev.tournamentName,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      kickoff: ev.startTime ? new Date(ev.startTime).toISOString() : null,
      matchStatus: ev.matchStatus,
    });
  }
  return matches;
}

function pairKey(m) {
  return [normTeam(m.homeTeam), normTeam(m.awayTeam)].sort().join('|');
}

// A SportyBet match "covers" a Flashscore match when home~home AND away~away
// AND kickoff is within tolerance (default 6h; Flashscore lists today's window).
export function covers(sb, fsMatch, toleranceMs = 6 * 60 * 60 * 1000) {
  const h = sameTeam(normTeam(sb.homeTeam), normTeam(fsMatch.homeTeam));
  const a = sameTeam(normTeam(sb.awayTeam), normTeam(fsMatch.awayTeam));
  const t = kickoffDeltaMs(sb.kickoff, fsMatch.kickoff) <= toleranceMs;
  return h && a && t;
}

async function main() {
  console.log('=== SportyBet coverage vs Flashscore (today) ===');
  console.log('Fetching Flashscore today list...');
  let fsMatches = [];
  let fsError = null;
  try {
    fsMatches = await fetchFlashscoreToday();
  } catch (e) {
    fsError = e.message;
  }
  if (fsError) {
    // Coverage check is diagnostic, not part of the data pipeline. If
    // Flashscore is unreachable/gated (common on cloud runner IPs), write a
    // degraded report and exit 0 so the scrape results still commit.
    console.warn(`  WARNING: Flashscore capture failed (${fsError}); writing degraded report.`);
    const degraded = {
      generatedAt: new Date().toISOString(),
      source: 'sportybet.com/gh/m/ vs flashscore.com/football/',
      error: fsError,
      flashscoreTotal: 0,
      sportybetTotal: null,
      matched: null,
      missing: null,
      missingMatches: [],
      sportybetNotOnFlashscore: null,
      notOnFlashscore: [],
      complete: false,
    };
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(OUT, JSON.stringify(degraded, null, 2), 'utf8');
    console.log(`  COVERAGE: INCOMPLETE (Flashscore unavailable) (${OUT})`);
    return;
  }
  console.log(`  Flashscore feed: ${fsMatches.length} matches (raw feed)`);

  // Flashscore's /football/ feed is a rolling ~day-anchored window (it leans
  // towards the previous day early in the UTC day), so it is NOT a clean
  // "today" list. Compare against the same UTC-day window SportyBet uses, and
  // flag when the snapshot is clearly partial.
  const now = new Date();
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const dayEnd = dayStart + 24 * 60 * 60 * 1000;
  const fsToday = fsMatches.filter((m) => {
    const k = m.kickoff ? new Date(m.kickoff).getTime() : null;
    return k && k >= dayStart && k < dayEnd;
  });
  console.log(`  Flashscore in UTC-today window: ${fsToday.length} matches`);
  if (fsToday.length === 0 || fsToday.length < fsMatches.length / 4) {
    console.warn('  WARNING: Flashscore snapshot is partial for today (rolling feed); coverage numbers are best-effort.');
  }

  console.log('Scraping SportyBet TODAY\'S FOOTBALL...');
  const sbMatches = await fetchSportyBetToday();
  console.log(`  SportyBet: ${sbMatches.length} matches`);

  const matched = [];
  const missing = [];
  for (const m of fsToday) {
    const hit = sbMatches.find((sb) => covers(sb, m));
    if (hit) matched.push({ fs: m, sb: hit });
    else missing.push(m);
  }

  // Reverse check: SportyBet matches that matched nothing on Flashscore.
  const coveredFs = new Set(matched.map((x) => x.fs.id));
  const notOnFlash = sbMatches.filter((sb) =>
    !fsToday.some((m) => coveredFs.has(m.id) && covers(sb, m))
  );

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'sportybet.com/gh/m/ vs flashscore.com/football/',
    flashscoreTotal: fsToday.length,
    flashscoreRawFeed: fsMatches.length,
    sportybetTotal: sbMatches.length,
    matched: matched.length,
    missing: missing.length,
    missingMatches: missing.map((m) => ({
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      league: m.league,
      kickoff: m.kickoff,
    })),
    sportybetNotOnFlashscore: notOnFlash.length,
    notOnFlashscore: notOnFlash.map((m) => ({
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      league: m.league,
      kickoff: m.kickoff,
    })),
    complete: missing.length === 0,
  };

  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(report, null, 2), 'utf8');

  console.log('');
  console.log(`  Flashscore total:    ${report.flashscoreTotal}`);
  console.log(`  SportyBet total:     ${report.sportybetTotal}`);
  console.log(`  Matched:             ${report.matched}`);
  console.log(`  MISSING on SportyBet: ${report.missing}`);
  console.log(`  SportyBet not on Flashscore: ${report.sportybetNotOnFlashscore}`);
  console.log(`  COVERAGE: ${report.complete ? 'COMPLETE' : 'INCOMPLETE'} (${OUT})`);

  if (missing.length) {
    console.log('');
    console.log(`Missing on SportyBet (not scraped): ${missing.length} (showing first 15)`);
    for (const m of report.missingMatches.slice(0, 15)) {
      console.log(`  ${m.homeTeam} vs ${m.awayTeam} [${m.league}] ${m.kickoff}`);
    }
  }
  if (notOnFlash.length) {
    console.log('');
    console.log(`On SportyBet but NOT in Flashscore today window: ${notOnFlash.length} (showing first 15)`);
    for (const m of report.notOnFlashscore.slice(0, 15)) {
      console.log(`  ${m.homeTeam} vs ${m.awayTeam} [${m.league}] ${m.kickoff}`);
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`comparison failed: ${e.message}`);
    process.exit(1);
  });
}