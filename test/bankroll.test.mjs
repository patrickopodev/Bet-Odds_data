import test from 'node:test';
import assert from 'node:assert/strict';
import { computeBankroll, parseBalance, BANKROLL_DIVISOR, STAKE_PERCENT_OF_HALF } from '../bankroll.mjs';

test('computeBankroll splits balance into active/reserve halves with fixed 25% stake', () => {
  const b = computeBankroll(100);
  assert.ok(b);
  assert.equal(b.balance, 100);
  assert.equal(b.activeHalf, 50);
  assert.equal(b.reserveHalf, 50);
  assert.equal(b.stakePerSlip, 12.5); // 25% of the 50 active half
  assert.equal(b.maxSlips, 4); // 50 / 12.5
  assert.equal(BANKROLL_DIVISOR, 2);
  assert.equal(STAKE_PERCENT_OF_HALF, 0.25);
});

test('computeBankroll handles uneven balances', () => {
  const b = computeBankroll(20);
  assert.ok(b);
  assert.equal(b.activeHalf, 10);
  assert.equal(b.reserveHalf, 10);
  assert.equal(b.stakePerSlip, 2.5);
  assert.equal(b.maxSlips, 4);
});

test('computeBankroll returns null for missing/zero balance', () => {
  assert.equal(computeBankroll(null), null);
  assert.equal(computeBankroll(undefined), null);
  assert.equal(computeBankroll(0), null);
  assert.equal(computeBankroll(-5), null);
  assert.equal(computeBankroll('nope'), null);
});

test('parseBalance reads the wallet amount from the page body', () => {
  assert.equal(parseBalance('Welcome back | GHS | 36.80 | SportyBet'), 36.8);
  assert.equal(parseBalance('Balance: GHS 20.00'), 20);
  assert.equal(parseBalance('GHS 100'), 100);
  assert.equal(parseBalance('No wallet text here'), null);
  assert.equal(parseBalance(null), null);
});

test('recycling winnings grows the active half but keeps the stake fixed', () => {
  // Win 12.5 @2.1 -> balance 100 -> 112.5 after payout; the stake stays the
  // fixed 25% of the ORIGINAL half (12.5), never recomputed from the new half.
  const before = computeBankroll(100);
  assert.equal(before.stakePerSlip, 12.5);
  const after = computeBankroll(112.5, before.stakePerSlip); // reuse fixed stake
  assert.equal(after.stakePerSlip, before.stakePerSlip); // fixed, not 14.06
  assert.equal(after.activeHalf, 56.25); // winnings recycle into active half
  assert.ok(after.maxSlips >= before.maxSlips);
});