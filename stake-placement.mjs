import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEventMarkets } from './lib/common.mjs';
import { createShareCode, loadShareCode, shareUrl, ticketSummary } from './share-code.mjs';
import { isFriendly, refillSlip } from './stake.mjs';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');
const CODE_FILE = path.join(DATA_DIR, 'stake-code.md');
const AGENT_FILE = path.join(DATA_DIR, 'agent-recommendations.json');
const ALLOW_FRIENDLIES = process.env.ALLOW_FRIENDLIES === 'true';
const REFILL_ROUNDS = 3;

// Resolve a slip bet's outcome name to SportyBet's numeric outcomeId by
// fetching the event's markets. Returns null when the market/outcome no longer
// exists or the current odds have drifted below the agent's minimum.
async function resolveOutcome(bet) {
  const data = await fetchEventMarkets(bet.eventId);
  // A market id may appear once per line (e.g. Over/Under "total=3.5"); each
  // entry carries a specifier that disambiguates which line we mean.
  const entries = (data?.markets ?? []).filter((m) => String(m.id) === String(bet.marketId));
  if (entries.length === 0) {
    bet.error = `market ${bet.marketId} no longer on event`;
    return null;
  }
  let found = null;
  for (const m of entries) {
    const outcome = (m.outcomes ?? []).find(
      (o) => String(o.desc).trim().toLowerCase() === String(bet.outcome).trim().toLowerCase()
    );
    if (outcome) {
      found = { marketEntry: m, outcome };
      break;
    }
  }
  if (!found) {
    bet.error = `outcome "${bet.outcome}" no longer on market ${bet.marketId}`;
    return null;
  }
  const current = Number(found.outcome.odds);
  if (current < bet.minOdds) {
    bet.error = `odds drifted ${bet.odds} -> ${current} (below min ${bet.minOdds})`;
    return null;
  }
  bet.currentOdds = current;
  bet.outcomeId = String(found.outcome.id);
  bet.specifier = found.marketEntry.specifier ?? undefined;
  const sel = {
    eventId: bet.eventId,
    marketId: String(bet.marketId),
    outcomeId: String(found.outcome.id),
  };
  if (bet.specifier) sel.specifier = bet.specifier;
  return sel;
}

// One pass over a set of pending bets: enforce the friendly filter at the
// money boundary, resolve each outcome server-side, and return the selections
// that survive. Skipped bets are marked 'skipped' with a reason so the refill
// step can replace them from the pipeline.
async function processPending(slip, bets) {
  const selections = [];
  for (const bet of bets) {
    if (isFriendly(bet.tournament) && !ALLOW_FRIENDLIES) {
      bet.status = 'skipped';
      bet.skippedAt = new Date().toISOString();
      bet.error = 'friendly filtered (ALLOW_FRIENDLIES=false)';
      console.error(`  - ${bet.homeTeam} vs ${bet.awayTeam} — ${bet.market} ${bet.outcome}: ${bet.error}`);
      continue;
    }
    try {
      const sel = await resolveOutcome(bet);
      if (sel) {
        selections.push(sel);
        console.log(`  + ${bet.homeTeam} vs ${bet.awayTeam} — ${bet.market} ${bet.outcome} @${bet.currentOdds} (outcomeId ${sel.outcomeId})`);
      } else {
        console.error(`  - ${bet.homeTeam} vs ${bet.awayTeam} — ${bet.market} ${bet.outcome}: ${bet.error}`);
        bet.status = 'skipped';
        bet.skippedAt = new Date().toISOString();
      }
    } catch (e) {
      bet.error = e.message;
      bet.status = 'skipped';
      bet.skippedAt = new Date().toISOString();
      console.error(`  - ${bet.homeTeam} vs ${bet.awayTeam}: ${e.message}`);
    }
  }
  return selections;
}

async function run() {
  let slip;
  try {
    slip = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
  } catch (e) {
    console.error(`stake-placement: cannot read ${SLIP_FILE}: ${e.message}`);
    process.exit(0);
  }

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
  } catch {
    report = null; // refill needs the agent report; without it we just process
  }

  let code = null;
  let summary = '';
  let sawPending = false;

  for (let round = 1; round <= REFILL_ROUNDS; round++) {
    const bets = (slip.bets ?? []).filter((b) => b.status === 'pending');
    if (!bets.length) break;
    sawPending = true;

    const selections = await processPending(slip, bets);
    if (selections.length) {
      const created = await createShareCode(selections);
      code = created.code;
      const data = await loadShareCode(code);
      summary = ticketSummary(data);
      console.log(`[stake-placement] share code: ${code}`);
      console.log(`[stake-placement] load this in the SportyBet app to fill the slip:`);
      console.log(`    ${shareUrl(code)}`);
      console.log(summary);
      for (const bet of bets) {
        if (bet.status === 'pending') {
          bet.status = 'slip-ready';
          bet.shareCode = code;
          bet.shareUrl = shareUrl(code);
          bet.codeReadyAt = new Date().toISOString();
        }
      }
    }

    // Auto-re-select from the pipeline: replace any skipped slot with the
    // next-best candidate the agent ranked, instead of substituting by hand.
    const { added, exhausted } = report ? refillSlip(slip, report) : { added: 0, exhausted: true };
    if (added > 0) {
      console.log(`[stake-placement] refilled ${added} skipped slot(s) from the agent report`);
    }
    if (added === 0 || exhausted || round >= REFILL_ROUNDS) break;
  }

  if (sawPending && !code) {
    console.warn('[stake-placement] no valid selections — no share code generated');
  }

  fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));

  const lines = [];
  lines.push('# Stake share code');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Open in the SportyBet app to fill your bet slip (stake per bet: ${slip.stakePerBet}):`);
  if (code) {
    lines.push('');
    lines.push(`- Share code: \`${code}\``);
    lines.push(`- URL: ${shareUrl(code)}`);
  }
  lines.push('');
  lines.push('```');
  lines.push(summary || 'no selections');
  lines.push('```');
  fs.writeFileSync(CODE_FILE, lines.join('\n'));
  console.log(`[stake-placement] wrote ${CODE_FILE}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error(`stake-placement failed: ${e.message}`);
    process.exit(1);
  });
}