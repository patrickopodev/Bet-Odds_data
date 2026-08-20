import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMatch } from './flashscore.js';
import { evaluateOutcome } from './db.js';
import type { Bet } from './confirm.js';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');
const KICKOFF_TOLERANCE_MS = 60 * 60 * 1000;

// Settle a confirmed bet against the finished Flashscore fixture. Returns
// { settled:false, skipped } when the match has not ended yet (kept open).
export async function settleBet(bet: Bet): Promise<{ settled: boolean; result?: string; score?: string; net?: number; skipped?: string }> {
  const kickoffMs = Date.parse(bet.startTime);
  if (Number.isNaN(kickoffMs) || kickoffMs > Date.now() + KICKOFF_TOLERANCE_MS) {
    return { settled: false, skipped: 'not started' };
  }
  const fm = await findMatch(bet.homeTeam, bet.awayTeam, kickoffMs, { requireFinished: true });
  if (fm.status !== 'finished') {
    return { settled: false, skipped: 'no finished match yet' };
  }
  const [h, a] = (fm.score ?? '').split(':').map(Number);
  const result = evaluateOutcome(bet.marketId, bet.outcome, { home: h, away: a }, []);
  bet.finalScore = fm.score;
  bet.flashscoreId = fm.flashscoreId;
  bet.result = result ?? 'UNKNOWN';
  bet.status = 'settled';
  bet.settledAt = new Date().toISOString();
  return { settled: true, result: bet.result, score: fm.score };
}

// Settle a slip: every leg must finish first. For a single-leg slip the payout
// is stake * odds; for an accumulator it is stake * product of every WON leg's
// odds, and any LOST leg voids the whole slip.
export function settleSlip(slip: any): { settled: boolean; skipped?: string } {
  const open = (slip.legs ?? []).filter((l: any) => l.status === 'placed' || l.status === 'confirmed');
  const stillOpen = open.filter((l: any) => l.status !== 'settled');
  if (stillOpen.length) return { settled: false, skipped: `${stillOpen.length} leg(s) not settled yet` };

  const legs = slip.legs ?? [];
  const results = legs.map((l: any) => l.result);
  if (results.some((r: any) => r === 'LOST')) {
    slip.result = 'LOST';
    slip.payout = 0;
    slip.net = -Math.round(slip.stake * 100) / 100;
  } else if (results.every((r: any) => r === 'WON')) {
    const product = legs.reduce((acc: number, l: any) => acc * l.odds, 1);
    slip.result = 'WON';
    slip.payout = Math.round(slip.stake * product * 100) / 100;
    slip.net = Math.round((slip.payout - slip.stake) * 100) / 100;
  } else {
    slip.result = 'VOID';
    slip.payout = slip.stake;
    slip.net = 0;
  }
  slip.settledAt = new Date().toISOString();
  slip.status = 'settled';
  return { settled: true };
}

export function writeReport(slip: any, resultsFile = path.join(process.env.DATA_DIR ?? 'data', 'stake-results.md')) {
  const all: any[] = (slip.slips ?? []).map((s: any) => ({
    ...s,
    legNames: (s.legs ?? []).map((l: any) => `${l.homeTeam} vs ${l.awayTeam}`).join(' + '),
  }));
  const won = all.filter((s) => s.result === 'WON');
  const lost = all.filter((s) => s.result === 'LOST');
  const voide = all.filter((s) => s.result === 'VOID');
  const open = all.filter((s) => s.status !== 'settled');
  const totalNet = Math.round(all.reduce((n, s) => n + (s.net ?? 0), 0) * 100) / 100;
  const staked = all.reduce((n, s) => n + (s.stake ?? 0), 0);

  const lines = [
    '# Stake results',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Slips | ${all.length} |`,
    `| Settled | ${all.filter((s) => s.status === 'settled').length} |`,
    `| Won | ${won.length} |`,
    `| Lost | ${lost.length} |`,
    `| Void | ${voide.length} |`,
    `| Open | ${open.length} |`,
    `| Staked | ${staked} |`,
    `| Net P&L | ${totalNet} |`,
    '',
    '| Slip | Type | Fixture(s) | Combined Odds | Stake | Result | Payout | Net |',
    '| --- | --- | --- | ---: | ---: | --- | ---: | ---: |',
  ];
  for (const s of all) {
    lines.push(
      `| ${s.slipId} | ${s.type} | ${s.legNames} | ${s.combinedOdds ?? '-'} | ${s.stake} | ${s.result ?? s.status} | ${s.payout ?? '-'} | ${s.net ?? '-'} |`
    );
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(resultsFile, lines.join('\n'));
  console.log(`[agent:monitor] wrote ${resultsFile}`);
}

export async function main() {
  let slip: any;
  try {
    slip = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
  } catch (e) {
    console.error(`agent:monitor: cannot read ${SLIP_FILE}: ${(e as Error).message}`);
    process.exit(0);
  }
  const open = (slip.slips ?? []).filter(
    (s: any) => s.status === 'pending' || s.status === 'placed' || s.status === 'slip-ready' || s.status === 'confirmed'
  );
  let settledCount = 0;
  for (const s of open) {
    // First settle every leg of the slip against its finished fixture.
    for (const leg of s.legs ?? []) {
      if (leg.status !== 'placed' && leg.status !== 'confirmed') continue;
      try {
        const r = await settleBet(leg);
        if (r.settled) {
          console.log(`  ${leg.homeTeam} ${r.score} ${leg.awayTeam} — ${leg.outcome} → ${r.result}`);
        } else {
          console.log(`  ${leg.homeTeam} vs ${leg.awayTeam}: ${r.skipped}`);
        }
      } catch (e) {
        console.warn(`  ${leg.homeTeam} vs ${leg.awayTeam}: ${(e as Error).message}`);
      }
    }
    const r = settleSlip(s);
    if (r.settled) {
      settledCount++;
      console.log(`  slip ${s.slipId} [${s.type}] → ${s.result} (payout ${s.payout}, net ${s.net})`);
    } else {
      console.log(`  slip ${s.slipId}: ${r.skipped}`);
    }
  }
  if (settledCount) {
    fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
  }
  writeReport(slip);
  const stillOpen = (slip.slips ?? []).filter((s: any) => s.status !== 'settled').length;
  console.log(`[agent:monitor] ${settledCount} settled; ${stillOpen} still open`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`[agent:monitor] failed: ${(e as Error).message}`);
    process.exit(1);
  });
}