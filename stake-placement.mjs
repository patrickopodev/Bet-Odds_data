import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchEventMarkets } from './lib/common.mjs';
import { createShareCode, loadShareCode, shareUrl, ticketSummary } from './share-code.mjs';
import { isFriendly, refillSlip, normalizeSlip } from './stake.mjs';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');
const CODE_FILE = path.join(DATA_DIR, 'stake-code.md');
const AGENT_FILE = path.join(DATA_DIR, 'agent-recommendations.json');
const ALLOW_FRIENDLIES = process.env.ALLOW_FRIENDLIES === 'true';
const REFILL_ROUNDS = 3;

// Resolve one slip leg's outcome to SportyBet's numeric outcomeId by fetching
// the event's markets. Returns null when the market/outcome no longer exists
// or the current odds have drifted below the agent's minimum.
async function resolveLeg(leg) {
  const data = await fetchEventMarkets(leg.eventId);
  const entries = (data?.markets ?? []).filter((m) => String(m.id) === String(leg.marketId));
  if (entries.length === 0) {
    leg.error = `market ${leg.marketId} no longer on event`;
    return null;
  }
  let found = null;
  for (const m of entries) {
    const outcome = (m.outcomes ?? []).find(
      (o) => String(o.desc).trim().toLowerCase() === String(leg.outcome).trim().toLowerCase()
    );
    if (outcome) {
      found = { marketEntry: m, outcome };
      break;
    }
  }
  if (!found) {
    leg.error = `outcome "${leg.outcome}" no longer on market ${leg.marketId}`;
    return null;
  }
  const current = Number(found.outcome.odds);
  if (current < leg.minOdds) {
    leg.error = `odds drifted ${leg.odds} -> ${current} (below min ${leg.minOdds})`;
    return null;
  }
  leg.currentOdds = current;
  leg.outcomeId = String(found.outcome.id);
  leg.specifier = found.marketEntry.specifier ?? undefined;
  const sel = {
    eventId: leg.eventId,
    marketId: String(leg.marketId),
    outcomeId: String(found.outcome.id),
  };
  if (leg.specifier) sel.specifier = leg.specifier;
  return sel;
}

// Resolve every leg of a pending slip. If any leg fails, the whole slip is
// skipped (an accumulator can't be built from a missing leg); the skipped
// record lets the refill replace it from the pipeline.
async function processPendingSlip(slip) {
  for (const leg of slip.legs) {
    if (isFriendly(leg.tournament) && !ALLOW_FRIENDLIES) {
      leg.error = 'friendly filtered (ALLOW_FRIENDLIES=false)';
      continue;
    }
    const sel = await resolveLeg(leg).catch((e) => {
      leg.error = e.message;
      return null;
    });
    if (sel) console.log(`  + ${leg.homeTeam} vs ${leg.awayTeam} — ${leg.market} ${leg.outcome} @${leg.currentOdds} (outcomeId ${sel.outcomeId})`);
    else console.error(`  - ${leg.homeTeam} vs ${leg.awayTeam} — ${leg.market} ${leg.outcome}: ${leg.error}`);
  }
  const ok = slip.legs.filter((l) => l.outcomeId);
  const bad = slip.legs.filter((l) => !l.outcomeId);
  if (bad.length) {
    slip.status = 'skipped';
    slip.skippedAt = new Date().toISOString();
    slip.error = bad.map((l) => `${l.homeTeam} vs ${l.awayTeam}: ${l.error}`).join('; ');
    console.error(`  slip ${slip.slipId} [${slip.type}] skipped: ${slip.error}`);
    return [];
  }
  return ok.map((l) => ({
    eventId: l.eventId,
    marketId: String(l.marketId),
    outcomeId: String(l.outcomeId),
    ...(l.specifier ? { specifier: l.specifier } : {}),
  }));
}

async function run() {
  let slip;
  try {
    slip = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
  } catch (e) {
    console.error(`stake-placement: cannot read ${SLIP_FILE}: ${e.message}`);
    process.exit(0);
  }
  slip = normalizeSlip(slip);

  let report = null;
  try {
    report = JSON.parse(fs.readFileSync(AGENT_FILE, 'utf8'));
  } catch {
    report = null;
  }

  const codes = [];
  let sawPending = false;

  for (let round = 1; round <= REFILL_ROUNDS; round++) {
    const pending = (slip.slips ?? []).filter((s) => s.status === 'pending');
    if (!pending.length) break;
    sawPending = true;

    for (const s of pending) {
      const selections = await processPendingSlip(s);
      if (!selections.length) continue;
      const created = await createShareCode(selections);
      const data = await loadShareCode(created.code);
      s.shareCode = created.code;
      s.shareUrl = shareUrl(created.code);
      s.codeReadyAt = new Date().toISOString();
      s.status = 'slip-ready';
      for (const leg of s.legs) {
        leg.status = 'slip-ready';
        leg.shareCode = created.code;
        leg.shareUrl = shareUrl(created.code);
      }
      codes.push({ code: created.code, summary: ticketSummary(data) });
      console.log(`[stake-placement] slip ${s.slipId} [${s.type}] share code: ${created.code}`);
      console.log(`[stake-placement] load this in the SportyBet app to fill the slip:`);
      console.log(`    ${shareUrl(created.code)}`);
      console.log(ticketSummary(data));
    }

    // Auto-re-select from the pipeline: replace any skipped slip with the
    // next-best candidates the agent ranked, instead of substituting by hand.
    const { added, exhausted } = report ? refillSlip(slip, report) : { added: 0, exhausted: true };
    if (added > 0) {
      console.log(`[stake-placement] refilled ${added} skipped slot(s) from the agent report`);
    }
    if (added === 0 || exhausted || round >= REFILL_ROUNDS) break;
  }

  if (sawPending && !codes.length) {
    console.warn('[stake-placement] no valid slips — no share code generated');
  }

  fs.writeFileSync(SLIP_FILE, JSON.stringify(slip, null, 2));

  const lines = [];
  lines.push('# Stake share code');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`Open in the SportyBet app to fill your bet slip (stake per slip: ${slip.stakePerSlip}):`);
  for (const c of codes) {
    lines.push('');
    lines.push(`- Share code: \`${c.code}\``);
    lines.push(`- URL: ${shareUrl(c.code)}`);
  }
  lines.push('');
  lines.push('```');
  lines.push(codes.length ? codes.map((c) => c.summary).join('\n\n') : 'no slips');
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