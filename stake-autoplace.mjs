import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UA } from './lib/common.mjs';
import { isFriendly, normalizeSlip } from './stake.mjs';
import { computeBankroll, parseBalance } from './bankroll.mjs';
import { shareUrl } from './share-code.mjs';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');
const ALLOW_FRIENDLIES = process.env.ALLOW_FRIENDLIES === 'true';

// ---------------------------------------------------------------------------
// Pure decision helpers (unit-tested in test/stake-autoplace.test.mjs).
// ---------------------------------------------------------------------------

// Escape a literal string for use inside a RegExp constructor.
export function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Verify a loaded slip really contains every leg: each leg's home AND away team
// name must appear on the page (case-insensitive). Guards against a share code
// that resolved to a different selection than the one we planned to place.
export function verifySlipLoaded(pageText, legs) {
  const txt = pageText ?? '';
  return legs.every(
    (l) =>
      new RegExp(escapeRegex(l.homeTeam), 'i').test(txt) &&
      new RegExp(escapeRegex(l.awayTeam), 'i').test(txt)
  );
}

// Confirm the stake keypad registered the typed amount: the field's text (with
// whitespace stripped) must contain the stake we intended to enter.
export function stakeRegistered(shownText, stake) {
  return String(shownText ?? '').replace(/\s+/g, '').includes(String(stake));
}

// A bet is only considered placed when SportyBet prints its success toast.
export function isPlacementSuccess(pageText) {
  return /Bet Successful/i.test(pageText ?? '');
}

// Definite-failure signals SportyBet shows when a bet cannot be placed.
export function isPlacementFailure(pageText) {
  return /insufficient|bet failed|place bet failed|error occurred/i.test(pageText ?? '');
}

// Extract old->new odds pairs from an "Accept Changes" dialog body.
// Handles multiple arrow styles and also a "From X to Y" pattern
// that some locales render instead of →. Returns [] when the text
// carries no recognizable change pair.
export function parseOddsChanges(dialogText) {
  const pairs = [];
  // Arrow styles used by the app: → -> => –> (including en-dash variants).
  const re = /(\d+(?:\.\d+)?)\s*(?:→|->|=>|–>|→)\s*(\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(String(dialogText ?? ''))) !== null) {
    pairs.push({ from: Number(m[1]), to: Number(m[2]) });
  }
  // Fallback: "From 1.85 to 1.60" / "X to Y" pattern when arrows are absent.
  if (!pairs.length) {
    const fallback = /(\d+(?:\.\d+)?)\s+to\s+(\d+(?:\.\d+)?)/gi;
    let fb;
    while ((fb = fallback.exec(String(dialogText ?? ''))) !== null) {
      pairs.push({ from: Number(fb[1]), to: Number(fb[2]) });
    }
  }
  return pairs;
}

// Decide whether every odds change still respects each leg's value floor
// (minOdds). A change is matched to its leg by the previous odds; any change
// that can't be matched to a leg, or a dialog whose prices couldn't be parsed
// at all, refuses the whole slip — never accept an odds change blind.
export function oddsChangesAcceptable(legs, changes) {
  if (!changes.length) return false;
  for (const ch of changes) {
    const leg = (legs ?? []).find((l) => Math.abs((l.odds ?? 0) - ch.from) < 1e-9);
    if (!leg) return false;
    if (ch.to < (leg.minOdds ?? 0) - 1e-9) return false;
  }
  return true;
}

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
  // Robust click helper: retries with a longer timeout and force-click
  // fallback. Returns true if the element was clicked or found.
  const ck = async (sel, { timeout = 8000, retries = 2 } = {}) => {
    for (let r = 0; r <= retries; r++) {
      try {
        const el = page.locator(sel).first();
        await el.waitFor({ state: 'visible', timeout });
        await el.click({ force: true, timeout });
        return true;
      } catch {
        if (r === retries) return false;
        await page.waitForTimeout(500);
      }
    }
    return false;
  };

  // Robust text-input helper: clears then types, retrying if the
  // field is stale or re-rendered by the app.
  const typeInto = async (loc, text, { retries = 2 } = {}) => {
    for (let r = 0; r <= retries; r++) {
      try {
        await loc.first().click({ force: true });
        await loc.first().selectAll();
        await loc.first().fill(text);
        await page.waitForTimeout(200);
        const val = await loc.first().inputValue().catch(() => '');
        if (val === text) return true;
      } catch {
        if (r === retries) return false;
        await page.waitForTimeout(500);
      }
    }
    return false;
  };

  await page.goto('https://sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(4000);
  let loggedIn = false;
  for (let a = 1; a <= 3; a++) {
    await ck('div.m-btn-login, [class*="login"], button:has-text("Log In")');
    // Wait for the login modal to appear with a generous timeout.
    try {
      await page.locator('input[type="tel"], input[type="email"], input[name="username"], input[name="login"]').first().waitFor({ state: 'visible', timeout: 20000 });
    } catch {
      // Modal may have already been open or may use a different selector; try anyway.
    }
    // Try common mobile login input patterns.
    const telInput = page.locator('input[type="tel"]').first();
    const emailInput = page.locator('input[type="email"]').first();
    const loginInput = telInput.count() ? telInput : emailInput.count() ? emailInput : page.locator('input').first();
    await typeInto(loginInput, process.env.SB_USER ?? '');
    await typeInto(page.locator('input[type="password"]').first(), process.env.SB_PASS ?? '');
    await ck('button:has-text("Login"), button:has-text("Log In"), [type="submit"]');
    // Wait for the GHS currency indicator that confirms login success.
    for (let w = 0; w < 5; w++) {
      await page.waitForTimeout(3000);
      const body = await page.evaluate(() => document.body.innerText);
      if (body.includes('GHS') || body.includes('Logout') || body.includes('My Bets')) { loggedIn = true; break; }
    }
    if (loggedIn) { console.log('[stake-autoplace] logged in'); break; }
    if (a === 3) { console.error('[stake-autoplace] login failed'); process.exit(1); }
  }

  // Bankroll: read the live balance, split into active/reserve halves, and
  // stake a fixed 25% of the ACTIVE half per slip. The stake is set once from
  // the first observed balance and stays fixed on later runs (wins/losses
  // recycle into the active half but never change the per-slip stake).
  // The wallet widget loads async after login, so retry the parse briefly.
  let balance = null;
  for (let i = 0; i < 6 && balance == null; i++) {
    const body = await page.evaluate(() => document.body.innerText);
    balance = parseBalance(body);
    if (balance == null) await page.waitForTimeout(2500);
  }
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
    // Load the slip via its share URL: the "Load Code" drawer does not expand
    // in headless Chromium, but navigating to ?shareCode=<code> while logged in
    // opens the booking-code input directly.
    await page.goto(shareUrl(code), { waitUntil: 'domcontentloaded', timeout: 60000 });
    const codeInput = page.locator('input[placeholder="Booking Code"]').first();
    try {
      await codeInput.waitFor({ state: 'visible', timeout: 30000 });
    } catch {
      s.status = 'skipped';
      s.skippedAt = new Date().toISOString();
      s.error = 'booking-code input never appeared';
      console.error(`[stake-autoplace] ${s.slipId}: booking-code input never appeared (${code})`);
      continue;
    }
    const prefilled = await codeInput.inputValue().catch(() => '');
    if (prefilled !== code) await codeInput.fill(code);
    await ck('div[data-op="load-code-button"], [data-op="load-code-button"]');
    await page.waitForTimeout(6000);
    const txt = await page.evaluate(() => document.body.innerText);
    const legsOk = verifySlipLoaded(txt, s.legs);
    console.log(`[stake-autoplace] slip ${s.slipId} (${s.type}) legs present?`, legsOk);
    if (!legsOk) {
      console.error(`[stake-autoplace] ABORT: wrong selection for ${code}`);
      s.status = 'skipped';
      s.skippedAt = new Date().toISOString();
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

    // Open the stake keypad (tapping the amount), clear the
    // prefilled amount, then type the bankroll stake. The keypad
    // field may re-render after tapping, so we type with retries.
    const stakeField = page.locator('[data-op="betslip-stake-amount"]');
    await ck('[data-op="betslip-stake-amount"]');
    await page.waitForTimeout(500);
    const typedOk = await typeInto(stakeField, stake);
    if (!typedOk) {
      s.status = 'failed';
      s.error = 'could not type stake into keypad field';
      console.error(`[stake-autoplace] ${s.slipId}: stake field not editable`);
      continue;
    }
    await page.waitForTimeout(600);
    const shownStake = (await page.evaluate(() => document.querySelector('[data-op="betslip-stake-amount"]')?.textContent ?? ''))
      .replace(/\s+/g, '');
    console.log(`[stake-autoplace] slip ${s.slipId} stake typed ${stake} (field shows ${shownStake})`);
    if (!stakeRegistered(shownStake, stake)) {
      // One retry: the field may not have refreshed yet.
      await page.waitForTimeout(500);
      const retryShown = (await page.evaluate(() => document.querySelector('[data-op="betslip-stake-amount"]')?.textContent ?? ''))
        .replace(/\s+/g, '');
      if (!stakeRegistered(retryShown, stake)) {
        s.status = 'failed';
        s.error = `stake did not register (field shows ${shownStake})`;
        console.error(`[stake-autoplace] ${s.slipId}: stake did not register`);
        continue;
      }
    }

    await ck('[data-op="betslip-placebet-button"], [data-op="betslip-placebet"]');
    await page.waitForTimeout(3000);
    const confirmBtn = page.locator('[data-op="betslip-confirm"]').first();
    if (await confirmBtn.count()) {
      await confirmBtn.click({ force: true }).catch(() => {});
      await page.waitForTimeout(6000);
    }
    const accept = page.locator('button:has-text("Accept Changes"), div:has-text("Accept Changes")').first();
    if (await accept.count()) {
      // "Accept Changes" means odds moved — usually down. Accepting blindly
      // would place the bet below the agent's recommendedMinOdds floor, so
      // parse the new prices and only accept when every leg is still at or
      // above its minOdds. Unparseable dialog -> refuse the slip.
      // Retry the text capture once in case the dialog rendered slowly.
      let changeText = await page.evaluate(() => document.body.innerText);
      let changes = parseOddsChanges(changeText);
      if (changes.length === 0) {
        await page.waitForTimeout(1000);
        changeText = await page.evaluate(() => document.body.innerText);
        changes = parseOddsChanges(changeText);
      }
      if (oddsChangesAcceptable(s.legs, changes)) {
        await accept.click({ force: true }).catch(() => {});
        await page.waitForTimeout(6000);
      } else {
        s.status = 'skipped';
        s.skippedAt = new Date().toISOString();
        s.error = `odds changed below recommendedMinOdds (${changes.map((c) => `${c.from}->${c.to}`).join(', ') || 'unparseable'})`;
        console.error(`[stake-autoplace] ${s.slipId}: odds changed below minOdds — refusing to accept (${s.error})`);
        continue;
      }
    }
    // Final verification: confirm the bet was placed by re-checking
    // the slip state on the page after a brief settlement window.
    await page.waitForTimeout(4000);
    let placedSeen = false;
    let definiteFail = false;
    let lastBody = '';
    for (let i = 0; i < 8 && !placedSeen && !definiteFail; i++) {
      if (i > 0) await page.waitForTimeout(2000);
      lastBody = await page.evaluate(() => document.body.innerText);
      placedSeen = isPlacementSuccess(lastBody);
      definiteFail = !placedSeen && isPlacementFailure(lastBody);
    }
    // lastBody holds the latest page text from the polling loop —
    // re-verify success/failure with a fresh read (the app may
    // render the toast after the last poll).
    const finalBody = await page.evaluate(() => document.body.innerText);
    if (isPlacementSuccess(finalBody)) {
      s.status = 'placed';
      s.placedAt = new Date().toISOString();
      for (const leg of s.legs) { leg.status = 'placed'; leg.placedAt = new Date().toISOString(); }
      console.log(`[stake-autoplace] PLACED ${s.slipId} [${s.type}] combined @${s.combinedOdds} stake ${stake} ${slip.currency}`);
    } else if (definiteFail) {
      s.status = 'failed';
      s.error = 'SportyBet reported a placement failure (no money moved)';
      console.error(`[stake-autoplace] ${s.slipId}: placement failed (definite failure signal)`);
    } else {
      // No success toast AND no failure message: the click may already have
      // moved money. Record 'unverified' — never a clean 'failed', which a
      // later run could treat as free capacity and double-stake. Reconcile
      // against My Bets before trusting this slip either way.
      s.status = 'unverified';
      s.error = 'no "Bet Successful" confirmation and no failure message — verify against bet history';
      console.error(`[stake-autoplace] ${s.slipId}: placement UNVERIFIED for ${code} — check bet history before re-staking`);
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