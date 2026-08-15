import { chromium } from 'playwright-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, UA, decodeFeedBlock, fetchTodayFootballEvents, kickoffDeltaMs, normTeam, sameTeam } from './lib/common.mjs';

const CHROMIUM_PATH = process.env.CHROMIUM_PATH || null;
const OUT = process.env.OUT || 'data/comparison.json';

// ---- Flashscore: full list of today's football ----
async function fetchFlashscoreToday() {
  const browser = await chromium.launch({
    executablePath: CHROMIUM_PATH || undefined,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  const page = await browser.newPage({ userAgent: UA });
  let feedText = '';
  page.on('response', async (res) => {
    if (res.url().includes('f_1_0_-4_en_1')) {
      try { feedText = await res.text(); } catch {}
    }
  });
  await page.goto('https://www.flashscore.com/football/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(8000);
  await browser.close();

  if (!feedText) throw new Error('Flashscore feed not captured');

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
  const fsMatches = await fetchFlashscoreToday();
  console.log(`  Flashscore: ${fsMatches.length} football matches today`);

  console.log('Scraping SportyBet TODAY\'S FOOTBALL...');
  const sbMatches = await fetchSportyBetToday();
  console.log(`  SportyBet: ${sbMatches.length} matches`);

  const matched = [];
  const missing = [];
  for (const m of fsMatches) {
    const hit = sbMatches.find((sb) => covers(sb, m));
    if (hit) matched.push({ fs: m, sb: hit });
    else missing.push(m);
  }

  // Reverse check: SportyBet matches that matched nothing on Flashscore.
  const coveredFs = new Set(matched.map((x) => x.fs.id));
  const notOnFlash = sbMatches.filter((sb) =>
    !fsMatches.some((m) => coveredFs.has(m.id) && covers(sb, m))
  );

  const report = {
    generatedAt: new Date().toISOString(),
    source: 'sportybet.com/gh/m/ vs flashscore.com/football/',
    flashscoreTotal: fsMatches.length,
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
  console.log(`  SportyBet not on Flashscore: ${report.notOnFlashscore}`);
  console.log(`  COVERAGE: ${report.complete ? 'COMPLETE' : 'INCOMPLETE'} (${OUT})`);

  if (missing.length) {
    console.log('');
    console.log('Missing on SportyBet (not scraped):');
    for (const m of report.missingMatches) {
      console.log(`  ${m.homeTeam} vs ${m.awayTeam} [${m.league}] ${m.kickoff}`);
    }
  }
  if (notOnFlash.length) {
    console.log('');
    console.log('On SportyBet but NOT in Flashscore today list:');
    for (const m of report.notOnFlashscore) {
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