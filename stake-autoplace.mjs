import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFriendly } from './stake.mjs';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');
const ALLOW_FRIENDLIES = process.env.ALLOW_FRIENDLIES === 'true';

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

async function run() {
  let slip;
  try {
    slip = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
  } catch (e) {
    console.error(`stake-autoplace: cannot read ${SLIP_FILE}: ${e.message}`);
    process.exit(0);
  }
  let allReady = (slip.bets ?? []).filter((b) => b.status === 'slip-ready' && b.shareCode);
  // Money-boundary friendly gate: even a stale/hand-edited slip can't place a
  // friendly bet unless explicitly allowed.
  let changed = false;
  for (const b of allReady) {
    if (isFriendly(b.tournament) && !ALLOW_FRIENDLIES) {
      b.status = 'skipped';
      b.skippedAt = new Date().toISOString();
      b.error = 'friendly filtered (ALLOW_FRIENDLIES=false)';
      changed = true;
      console.warn(`[stake-autoplace] skipping friendly ${b.homeTeam} vs ${b.awayTeam}`);
    }
  }
  const bets = allReady.filter((b) => b.status === 'slip-ready');
  if (changed) fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
  if (!bets.length) {
    console.log('[stake-autoplace] no slip-ready bets to place');
    return;
  }
  if (!process.env.SB_USER || !process.env.SB_PASS) {
    console.warn('[stake-autoplace] SB_USER/SB_PASS not set — cannot auto-place; leave the code for manual staking');
    return;
  }
  if (process.env.STAKE_DRY_RUN === 'true') {
    console.log('[stake-autoplace] dry-run: would place', bets.length, 'bet(s) — skipping real placement');
    return;
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 390, height: 844 } });
  const ck = async (sel) => { try { await page.locator(sel).first().click({ force: true, timeout: 6000 }); return true; } catch { return false; } };

  await page.goto('https://sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  for (let a = 1; a <= 3; a++) {
    await ck('div.m-btn-login');
    await page.waitForTimeout(2500);
    if (await page.locator('input[type="tel"]').first().count()) {
      await page.locator('input[type="tel"]').first().fill(process.env.SB_USER);
      await page.locator('input[type="password"]').first().fill(process.env.SB_PASS);
      await ck('button:has-text("Login")');
      await page.waitForTimeout(9000);
    }
    if (await page.evaluate(() => document.body.innerText.includes('GHS'))) { console.log('[stake-autoplace] logged in'); break; }
    if (a === 3) { console.error('[stake-autoplace] login failed'); process.exit(1); }
  }

  for (const bet of bets) {
    const code = bet.shareCode;
    const home = bet.homeTeam;
    const away = bet.awayTeam;
    const stake = String(bet.stake ?? 1);
    for (let a = 1; a <= 3; a++) {
      await ck('a:has-text("Load Code")');
      await page.waitForTimeout(2000);
      if (await page.locator('input[placeholder="Booking Code"]').first().isVisible().catch(() => false)) break;
    }
    let txt = '';
    for (let attempt = 1; attempt <= 4; attempt++) {
      await page.locator('input[placeholder="Booking Code"]').first().fill(code);
      await page.waitForTimeout(400);
      await ck('div[data-op="load-code-button"]');
      await page.waitForTimeout(6000);
      txt = await page.evaluate(() => document.body.innerText);
      if (new RegExp(home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt) &&
          new RegExp(away.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt)) break;
      console.log(`[stake-autoplace] load-code attempt ${attempt}: slip not filled`);
      await ck('a:has-text("Load Code")');
      await page.waitForTimeout(2000);
    }
    console.log(`[stake-autoplace] slip ${home} vs ${away}?`, new RegExp(home, 'i').test(txt), new RegExp(away, 'i').test(txt));
    if (!new RegExp(home, 'i').test(txt) || !new RegExp(away, 'i').test(txt)) {
      console.error(`[stake-autoplace] ABORT: wrong selection for ${code}`);
      bet.status = 'skipped';
      bet.error = 'share code did not load expected selection';
      continue;
    }

    await ck('[dataop="close_guide_button"]');
    await page.waitForTimeout(700);
    const realActive = await page.evaluate(() => /show-highlight/.test(document.querySelector('div[data-op="switch-box-right"]')?.className ?? ''));
    if (!realActive) {
      await ck('div[data-op="switch-box-right"]');
      await page.waitForTimeout(1200);
    }

    await page.locator('span[data-op="single-union-keyboard"]').first().focus();
    await page.waitForTimeout(400);
    for (let i = 0; i < 12; i++) { await page.keyboard.press('Backspace'); await page.waitForTimeout(80); }
    await page.keyboard.type(stake);
    await page.waitForTimeout(800);

    await ck('[data-op="betslip-placebet-button"], [data-op="betslip-placebet"]');
    await page.waitForTimeout(3000);
    const confirmBtn = page.locator('[data-op="betslip-confirm"]').first();
    if (await confirmBtn.count()) {
      await confirmBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(6000);
    }
    const accept = page.locator('button:has-text("Accept Changes"), div:has-text("Accept Changes")').first();
    if (await accept.count()) { await accept.click({ force: true }).catch(() => {}); await page.waitForTimeout(6000); }
    await page.waitForTimeout(4000);

    const body = await page.evaluate(() => document.body.innerText);
    if (/Bet Successful/i.test(body)) {
      bet.status = 'placed';
      bet.placedAt = new Date().toISOString();
      console.log(`[stake-autoplace] PLACED ${home} vs ${away} — ${bet.market} ${bet.outcome} @${bet.odds} stake ${stake} ${slip.currency}`);
    } else {
      bet.status = 'failed';
      bet.error = 'no "Bet Successful" confirmation on page';
      console.error(`[stake-autoplace] placement did not confirm for ${code}`);
    }
  }

  fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
  await browser.close().catch(() => {});
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error(`stake-autoplace failed: ${e.message}`);
    process.exit(1);
  });
}