// Bankroll management (user-defined):
//  - balance is split into two halves: an ACTIVE half (money at risk) and a
//    RESERVE half (never touched).
//  - every slip stakes a FIXED 25% of the ORIGINAL active half (it does not
//    shrink after losses or grow after wins).
//  - winnings are recycled back into the active half, so the active balance
//    (and the number of slips it can fund) can grow over time.
//  - the reserve half is never staked.

export const BANKROLL_DIVISOR = 2; // split balance into 2 halves
export const STAKE_PERCENT_OF_HALF = 0.25; // 25% of the active half per slip

const round2 = (n) => Math.round(n * 100) / 100;

// Parse the wallet balance out of the logged-in page body text, e.g.
// "Balance: GHS 20.00" or "GHS | 36.80". Returns null when not found.
// Patterns are tried in order of how likely they are to name the actual wallet
// amount: a "Balance"-labelled figure first, then the wallet's "GHS | x" tile,
// then a bare "GHS <amount>" as a last resort. Bare amounts can be an odds
// quote elsewhere on the page, so the labelled patterns are preferred.
export function parseBalance(bodyText) {
  if (!bodyText) return null;
  const patterns = [
    /Balance[^\n]{0,40}?GHS\s*(?:[|:=-]\s*)?([0-9]+(?:\.[0-9]{1,2})?)/i,
    /GHS\s*\|\s*([0-9]+(?:\.[0-9]{1,2})?)/,
    /GHS[^\d]{0,4}([0-9]+(?:\.[0-9]{1,2})?)/,
  ];
  for (const re of patterns) {
    const m = bodyText.match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// Compute the bankroll plan from a live balance:
//  - activeHalf  = balance / BANKROLL_DIVISOR (money available to stake)
//  - reserveHalf = balance - activeHalf (never staked)
//  - stakePerSlip = fixed 25% of the active half. Once the plan exists, the
//    stake stays fixed (pass the previous stakePerSlip so wins/losses never
//    change it); only the active half grows as winnings recycle back in.
//  - maxSlips    = how many whole slips the active half can fund at that stake
// Returns null when the balance cannot be determined.
export function computeBankroll(balance, fixedStakePerSlip = null) {
  if (balance == null || !Number.isFinite(balance) || balance <= 0) return null;
  const activeHalf = round2(balance / BANKROLL_DIVISOR);
  const reserveHalf = round2(balance - activeHalf);
  const stakePerSlip = fixedStakePerSlip ?? round2(activeHalf * STAKE_PERCENT_OF_HALF);
  const maxSlips = stakePerSlip > 0 ? Math.floor(activeHalf / stakePerSlip) : 0;
  return { balance, activeHalf, reserveHalf, stakePerSlip, maxSlips };
}