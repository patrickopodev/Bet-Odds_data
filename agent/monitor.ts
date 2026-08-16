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
  bet.payout = result === 'WON' ? bet.stake * bet.odds : result === 'VOID' ? bet.stake : 0;
  bet.net = Math.round((bet.payout - bet.stake) * 100) / 100;
  return { settled: true, result: bet.result, score: fm.score, net: bet.net };
}

export function writeReport(slip: any, resultsFile = path.join(process.env.DATA_DIR ?? 'data', 'stake-results.md')) {
  const all: Bet[] = slip.bets ?? [];
  const won = all.filter((b) => b.result === 'WON');
  const lost = all.filter((b) => b.result === 'LOST');
  const voide = all.filter((b) => b.result === 'VOID');
  const open = all.filter((b) => b.status !== 'settled');
  const totalNet = Math.round(all.reduce((n, b) => n + (b.net ?? 0), 0) * 100) / 100;
  const staked = all.reduce((n, b) => n + (b.stake ?? 0), 0);

  const lines = [
    '# Stake results',
    '',
    `Updated: ${new Date().toISOString()}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    `| Bets | ${all.length} |`,
    `| Settled | ${all.filter((b) => b.status === 'settled').length} |`,
    `| Won | ${won.length} |`,
    `| Lost | ${lost.length} |`,
    `| Void | ${voide.length} |`,
    `| Open | ${open.length} |`,
    `| Staked | ${staked} |`,
    `| Net P&L | ${totalNet} |`,
    '',
    '| Fixture | Market | Outcome | Odds | Stake | Result | Payout | Net |',
    '| --- | --- | --- | ---: | ---: | --- | ---: | ---: |',
  ];
  for (const b of all) {
    lines.push(
      `| ${b.homeTeam} vs ${b.awayTeam} | ${b.market ?? ''} | ${b.outcome} | ${b.odds} | ${b.stake} | ${b.result ?? b.status} | ${b.payout ?? '-'} | ${b.net ?? '-'} |`
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
  const open = (slip.bets ?? []).filter(
    (b: Bet) => b.status === 'pending' || b.status === 'placed' || b.status === 'slip-ready' || b.status === 'confirmed'
  );
  let settledCount = 0;
  for (const bet of open) {
    try {
      const r = await settleBet(bet);
      if (r.settled) {
        settledCount++;
        console.log(`  ${bet.homeTeam} ${r.score} ${bet.awayTeam} — ${bet.outcome} → ${r.result} (net ${r.net})`);
      } else {
        console.log(`  ${bet.homeTeam} vs ${bet.awayTeam}: ${r.skipped}`);
      }
    } catch (e) {
      console.warn(`  ${bet.homeTeam} vs ${bet.awayTeam}: ${(e as Error).message}`);
    }
  }
  if (settledCount) {
    fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));
  }
  writeReport(slip);
  const stillOpen = (slip.bets ?? []).filter((b: Bet) => b.status !== 'settled').length;
  console.log(`[agent:monitor] ${settledCount} settled; ${stillOpen} still open`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`[agent:monitor] failed: ${(e as Error).message}`);
    process.exit(1);
  });
}