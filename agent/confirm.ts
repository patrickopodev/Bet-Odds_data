import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEventMarkets, loadShareCode, resolveOutcome } from './sporty.js';
import { findMatch } from './flashscore.js';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');
const CONFIRM_FILE = path.join(DATA_DIR, 'confirm-report.json');

export interface Bet {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  startTime: string;
  marketId: string;
  market?: string;
  outcome: string;
  odds: number;
  minOdds: number;
  stake: number;
  status: string;
  shareCode?: string;
  currentOdds?: number;
  outcomeId?: string;
  specifier?: string;
  flashscoreId?: string;
  finalScore?: string;
  result?: string | null;
  payout?: number | null;
  net?: number | null;
  settledAt?: string;
  confirmedAt?: string;
  cancelledAt?: string;
  error?: string | null;
}

export interface ConfirmResult {
  ok: boolean;
  checks: string[];
  errors: string[];
}

// Confirm one staked bet: the share code still resolves server-side, the
// current odds still respect the agent's minimum, and the fixture is confirmed
// on Flashscore for the staked kickoff.
export async function confirmBet(bet: Bet): Promise<ConfirmResult> {
  const checks: string[] = [];
  const errors: string[] = [];

  // 1. Share code still resolves.
  if (bet.shareCode) {
    try {
      const data = await loadShareCode(bet.shareCode);
      const selections = data?.ticket?.selections ?? [];
      if (selections.length === 0) {
        errors.push(`share code ${bet.shareCode} returned no selections`);
      } else {
        const mine = selections.filter(
          (s: any) => String(s.eventId) === String(bet.eventId)
        );
        if (mine.length === 0) {
          errors.push(`share code no longer contains ${bet.eventId}`);
        } else {
          checks.push(`share code resolves ${mine.length} selection(s)`);
        }
      }
    } catch (e) {
      errors.push(`share code load failed: ${(e as Error).message}`);
    }
  } else {
    errors.push('no share code on bet');
  }

  // 2. Live odds still at/above the agent's minimum.
  try {
    const data = await fetchEventMarkets(bet.eventId);
    const resolved = resolveOutcome(data, bet.marketId, bet.outcome);
    if (!resolved) {
      errors.push(`outcome "${bet.outcome}" no longer available on market ${bet.marketId}`);
    } else {
      bet.currentOdds = resolved.currentOdds;
      bet.outcomeId = String(resolved.outcome.id);
      if (resolved.market.specifier) bet.specifier = resolved.market.specifier;
      if (resolved.currentOdds >= bet.minOdds) {
        checks.push(`odds ${resolved.currentOdds} >= min ${bet.minOdds}`);
      } else {
        errors.push(`odds ${resolved.currentOdds} < min ${bet.minOdds} (no value)`);
      }
    }
  } catch (e) {
    errors.push(`market fetch failed: ${(e as Error).message}`);
  }

  // 3. Fixture confirmed on Flashscore near the staked kickoff.
  const kickoff = Date.parse(bet.startTime);
  if (Number.isNaN(kickoff)) {
    errors.push('invalid startTime');
  } else {
    try {
      const fm = await findMatch(bet.homeTeam, bet.awayTeam, kickoff, { requireFinished: false });
      if (fm.status === 'upcoming') {
        bet.flashscoreId = fm.flashscoreId;
        checks.push(`flashscore fixture ${fm.flashscoreId} @ ${fm.startTime}`);
      } else {
        errors.push(`flashscore fixture not found (${fm.status})`);
      }
    } catch (e) {
      errors.push(`flashscore lookup failed: ${(e as Error).message}`);
    }
  }

  return { ok: errors.length === 0, checks, errors };
}

export async function main() {
  let slip: any;
  try {
    slip = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
  } catch (e) {
    console.error(`agent:confirm: cannot read ${SLIP_FILE}: ${(e as Error).message}`);
    process.exit(0);
  }
  const bets = (slip.bets ?? []).filter((b: Bet) => b.status === 'pending' || b.status === 'slip-ready');
  if (!bets.length) {
    console.log('[agent:confirm] no pending bets to confirm');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CONFIRM_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), checked: 0, confirmed: 0, bets: [] }, null, 2));
    return;
  }

  const report = { generatedAt: new Date().toISOString(), checked: 0, confirmed: 0, bets: [] as any[] };
  for (const bet of bets) {
    const r = await confirmBet(bet);
    report.checked++;
    if (r.ok) {
      bet.status = 'confirmed';
      bet.confirmedAt = new Date().toISOString();
      bet.error = null;
      report.confirmed++;
      console.log(`  [confirmed] ${bet.homeTeam} vs ${bet.awayTeam} — ${bet.outcome} @${bet.currentOdds}`);
      for (const c of r.checks) console.log(`      ok: ${c}`);
    } else {
      bet.status = 'cancelled';
      bet.cancelledAt = new Date().toISOString();
      bet.error = r.errors.join('; ');
      console.error(`  [cancelled] ${bet.homeTeam} vs ${bet.awayTeam} — ${r.errors.join('; ')}`);
    }
    report.bets.push({ eventId: bet.eventId, homeTeam: bet.homeTeam, awayTeam: bet.awayTeam, ok: r.ok, checks: r.checks, errors: r.errors });
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
  fs.writeFileSync(CONFIRM_FILE, JSON.stringify(report, null, 2));
  console.log(`[agent:confirm] ${report.confirmed}/${report.checked} confirmed`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`[agent:confirm] failed: ${(e as Error).message}`);
    process.exit(1);
  });
}