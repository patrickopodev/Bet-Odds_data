import { chromium } from 'playwright-core';
import { shareUrl } from './share-code.mjs';

const UA = 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-blink-features=AutomationControlled'],
});
const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 } });
await ctx.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

// Login once on a page, keep the context for subsequent pages
const loginPage = await ctx.newPage();
const ck = async (sel, p = loginPage) => { try { await p.locator(sel).first().click({ force: true, timeout: 6000 }); return true; } catch { return false; } };
await loginPage.goto('https://sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await loginPage.waitForTimeout(6000);
for (let a = 1; a <= 3; a++) {
  await ck('div.m-btn-login');
  try { await loginPage.locator('input[type="tel"]').first().waitFor({ state: 'visible', timeout: 15000 }); } catch { continue; }
  await loginPage.locator('input[type="tel"]').first().fill(process.env.SB_USER);
  await loginPage.locator('input[type="password"]').first().fill(process.env.SB_PASS);
  await ck('button:has-text("Login")');
  await loginPage.waitForTimeout(9000);
  if (await loginPage.evaluate(() => document.body.innerText.includes('GHS'))) { console.log('logged in'); break; }
}

// Login once in a master context, then seed fresh contexts with its cookies
const master = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 } });
await master.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});
const mp = await master.newPage();
const mck = async (sel) => { try { await mp.locator(sel).first().click({ force: true, timeout: 6000 }); return true; } catch { return false; } };
await mp.goto('https://sportybet.com/gh/m/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await mp.waitForTimeout(6000);
for (let a = 1; a <= 3; a++) {
  await mck('div.m-btn-login');
  try { await mp.locator('input[type="tel"]').first().waitFor({ state: 'visible', timeout: 15000 }); } catch { continue; }
  await mp.locator('input[type="tel"]').first().fill(process.env.SB_USER);
  await mp.locator('input[type="password"]').first().fill(process.env.SB_PASS);
  await mck('button:has-text("Login")');
  await mp.waitForTimeout(9000);
  if (await mp.evaluate(() => document.body.innerText.includes('GHS'))) { console.log('logged in'); break; }
}
const cookies = await master.cookies();

// Process each slip in a fresh context seeded with master cookies
const codes = ['DBVCQR', 'AJYD1C'];
for (const CODE of codes) {
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 390, height: 844 } });
  await ctx.addCookies(cookies);
  const p = await ctx.newPage();
  console.log(`\n=== processing ${CODE} on COOKIE-SEEDED FRESH CONTEXT ===`);
  const loggedIn = await p.evaluateOnNewDocument; // noop
  await p.goto(shareUrl(CODE), { waitUntil: 'domcontentloaded', timeout: 60000 });
  const input = p.locator('input[placeholder="Booking Code"]').first();
  let appeared = false;
  for (let r = 0; r < 3; r++) {
    try { await input.waitFor({ state: 'visible', timeout: 15000 }); appeared = true; break; }
    catch {
      console.log('  input not visible, reloading...');
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForTimeout(3000);
    }
  }
  const bodyHasGhs = await p.evaluate(() => document.body.innerText.includes('GHS'));
  console.log('  input appeared:', appeared, '| logged-in check (GHS):', bodyHasGhs);
  await ctx.close();
}

await browser.close();