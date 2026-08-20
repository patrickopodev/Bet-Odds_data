import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isFriendly, normalizeSlip } from './stake.mjs';
import { computeBankroll, parseBalance } from './bankroll.mjs';

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
  slip = normalizeSlip(slip);
  let allReady = (slip.slips ?? []).filter((s) => s.status === 'slip-ready' && s.shareCode);

  // Money-boundary friendly gate: even a stale/hand-edited slip can't place a
  // friendly bet unless explicitly allowed.
  let changed = false;
  for (const s of allReady) {
    const friendlies = s.legs.filter((l) => isFriendly(l.tournament) && !ALLOW_FRIENDLIES);
    if (friendlies.length) {
      s.status = 'skipped';
      s.skippedAt = new Date().toISOString();
      s.error = 'friendly filtered (ALLOW_FRIENDLIES=false)';
      changed = true;
      console.warn(`[stake-autoplace] skipping friendly slip ${s.slipId} (${friendlies.map((l) => l.homeTeam).join(', ')})`);
    }
  }
  const slips = allReady.filter((s) => s.status === 'slip-ready');
  if (changed) fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
  if (!slips.length) {
    console.log('[stake-autoplace] no slip-ready slips to place');
    return;
  }
  if (!process.env.SB_USER || !process.env.SB_PASS) {
    console.warn('[stake-autoplace] SB_USER/SB_PASS not set — cannot auto-place; leave the code for manual staking');
    return;
  }
  if (process.env.STAKE_DRY_RUN === 'true') {
    console.log('[stake-autoplace] dry-run: would place', slips.length, 'slip(s) — skipping real placement');
    return;
  }

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
  });
  const page = await browser.newPage({ userAgent: UA, viewport: { width: 390, height: 844 } });
  // SportyBet blocks Playwright's stock automation: with navigator.webdriver
  // exposed, the login modal never opens. Mask it before any script runs.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  const ck = async (sel) => { try { await page.locator(sel).first().click({ force: true, timeout: 6000 }); return true; } catch { return false; } };

  await page.goto('https://sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);
  for (let a = 1; a <= 3; a++) {
    await ck('div.m-btn-login');
    try {
      await page.locator('input[type="tel"]').first().waitFor({ state: 'visible', timeout: 15000 });
    } catch {
      continue; // modal did not open; retry the login click
    }
    await page.locator('input[type="tel"]').first().fill(process.env.SB_USER);
    await page.locator('input[type="password"]').first().fill(process.env.SB_PASS);
    await ck('button:has-text("Login")');
    await page.waitForTimeout(9000);
    if (await page.evaluate(() => document.body.innerText.includes('GHS'))) { console.log('[stake-autoplace] logged in'); break; }
    if (a === 3) { console.error('[stake-autoplace] login failed'); process.exit(1); }
  }

  // Bankroll: read the live balance, split into active/reserve halves, and
  // stake a fixed 25% of the ACTIVE half per slip. The stake is set once from
  // the first observed balance and stays fixed on later runs (wins/losses
  // recycle into the active half but never change the per-slip stake).
  const body = await page.evaluate(() => document.body.innerText);
  const balance = parseBalance(body);
  const fixedStake = slip.bankroll?.stakePerSlip ?? null;
  const bankroll = computeBankroll(balance, fixedStake);
  if (bankroll) {
    slip.bankroll = bankroll;
    slip.stakePerSlip = bankroll.stakePerSlip;
    for (const s of slips) s.stake = bankroll.stakePerSlip;
    console.log(`[stake-autoplace] balance ${bankroll.balance} -> active half ${bankroll.activeHalf}, stake ${bankroll.stakePerSlip}/slip, max ${bankroll.maxSlips} slip(s)`);
    // Respect the active-half budget: as many slips as the half can fund.
    const fundable = slips.slice(0, bankroll.maxSlips);
    for (const s of slips.slice(bankroll.maxSlips)) {
      s.status = 'skipped';
      s.skippedAt = new Date().toISOString();
      s.error = 'no active-half budget left for this slip';
      console.warn(`[stake-autoplace] ${s.slipId} skipped: active half exhausted (${bankroll.maxSlips} slip max)`);
    }
    slips.length = 0;
    slips.push(...fundable);
    if (!slips.length) {
      console.log('[stake-autoplace] no slips within active-half budget');
      fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
      await browser.close().catch(() => {});
      return;
    }
  } else {
    console.warn(`[stake-autoplace] could not parse balance (${balance}); keeping slip.stakePerSlip ${slip.stakePerSlip}`);
  }

  for (const s of slips) {
    const code = s.shareCode;
    const stake = String(s.stake ?? 1);
    let txt = '';
    for (let a = 1; a <= 3; a++) {
      await ck('a:has-text("Load Code")');
      await page.waitForTimeout(2000);
      if (await page.locator('input[placeholder="Booking Code"]').first().isVisible().catch(() => false)) break;
    }
    for (let attempt = 1; attempt <= 4; attempt++) {
      await page.locator('input[placeholder="Booking Code"]').first().fill(code);
      await page.waitForTimeout(400);
      await ck('div[data-op="load-code-button"]');
      await page.waitForTimeout(6000);
      txt = await page.evaluate(() => document.body.innerText);
      const legsOk = s.legs.every(
        (l) =>
          new RegExp(l.homeTeam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt) &&
          new RegExp(l.awayTeam.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(txt)
      );
      if (legsOk) break;
      console.log(`[stake-autoplace] load-code attempt ${attempt}: slip not filled`);
      await ck('a:has-text("Load Code")');
      await page.waitForTimeout(2000);
    }
    const legsOk = s.legs.every(
      (l) => new RegExp(l.homeTeam, 'i').test(txt) && new RegExp(l.awayTeam, 'i').test(txt)
    );
    console.log(`[stake-autoplace] slip ${s.slipId} (${s.type}) legs present?`, legsOk);
    if (!legsOk) {
      console.error(`[stake-autoplace] ABORT: wrong selection for ${code}`);
      s.status = 'skipped';
      s.error = 'share code did not load expected selections';
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

    const confirmBody = await page.evaluate(() => document.body.innerText);
    if (/Bet Successful/i.test(confirmBody)) {
      s.status = 'placed';
      s.placedAt = new Date().toISOString();
      for (const leg of s.legs) { leg.status = 'placed'; leg.placedAt = new Date().toISOString(); }
      console.log(`[stake-autoplace] PLACED ${s.slipId} [${s.type}] combined @${s.combinedOdds} stake ${stake} ${slip.currency}`);
    } else {
      s.status = 'failed';
      s.error = 'no "Bet Successful" confirmation on page';
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