// Pre-autoplace validation gate (P3). Runs immediately before
// stake-autoplace.mjs. Reads the staged slip + the live odds (latest.json) +
// agent recommendations, and refuses (exit 1) if any safeguard fails. The
// existing minOdds / stale-slip defenses inside stake-autoplace.mjs remain as
// defense in depth; this is the single, explicit gate the reviewer asked for.
import fs from 'node:fs';
import path from 'node:path';
import { frozenFavBand } from './lib/favband.mjs';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const SLIP_FILE = process.env.STAKE_SLIP ?? path.join(DATA_DIR, 'stake-slip.json');
const AGENT_FILE = path.join(DATA_DIR, 'agent-recommendations.json');
const LATEST_FILE = path.join(DATA_DIR, 'latest.json');

const MIN_CONFIDENCE = Number(process.env.MIN_CONFIDENCE ?? 0.6);
const STAKE_PER_BET = Number(process.env.STAKE_PER_BET ?? 10);
const STAKE_MAX_SLIPS = Number(process.env.STAKE_MAX_SLIPS ?? 2);
// FROZEN band from the validated strategy registry — never env-tunable (review
// action #1). A validated strategy must not be silently widened in production.
const { lo: FAV_BAND_LO, hi: FAV_BAND_HI } = frozenFavBand();
// Refuse placements when kickoff is within this window — too late to be safe.
const START_BUFFER_MS = 5 * 60 * 1000;

function fail(reason) {
  console.error(`[validate-stake] FAIL: ${reason}`);
  process.exit(1);
}

function findMatch(latest, slipMatch) {
  const evs = latest?.matches ?? [];
  let m = evs.find((e) => e.eventId && slipMatch.eventId && String(e.eventId) === String(slipMatch.eventId));
  if (!m && slipMatch.homeTeam && slipMatch.awayTeam) {
    m = evs.find((e) => e.homeTeam === slipMatch.homeTeam && e.awayTeam === slipMatch.awayTeam);
  }
  return m;
}

function outcomeOdds(match, leg) {
  const key = leg.marketId ?? leg.market ?? null;
  const market = key ? match.markets?.[key] : null;
  if (!market) return null;
  const o = (market.outcomes ?? []).find((x) => x.name === leg.outcome);
  return o ? Number(o.odds) : null;
}

let slip;
try {
  slip = JSON.parse(fs.readFileSync(SLIP_FILE, 'utf8'));
} catch {
  console.log('[validate-stake] no slip file; nothing to validate.');
  process.exit(0);
}

const toPlace = (slip.slips ?? []).filter(
  (s) => s.status === 'pending' || s.status === 'slip-ready' || s.status === 'confirmed'
);
if (toPlace.length === 0) {
  console.log('[validate-stake] no pending slips; nothing to place.');
  process.exit(0);
}

let latest = null;
try {
  latest = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8'));
} catch {
  /* may be absent */
}

const now = Date.now();
let activeCount = (slip.slips ?? []).filter((s) => s.status === 'confirmed' || s.status === 'placed').length;

for (const s of toPlace) {
  // Already placed/confirmed -> skip rather than fail (idempotent re-run guard).
  if (s.status === 'confirmed' || s.status === 'placed') {
    console.log(`[validate-stake] ${s.slipId} already placed; skipping.`);
    continue;
  }
  if (s.bookmaker && s.bookmaker !== 'sportybet') {
    fail(`${s.slipId}: unsupported bookmaker '${s.bookmaker}'`);
  }

  const m = latest ? findMatch(latest, s.match ?? {}) : null;
  if (!m) fail(`${s.slipId}: match not found in live odds (${s.match?.homeTeam} vs ${s.match?.awayTeam})`);
  const kickoff = m.startTime ? Date.parse(m.startTime) : null;
  if (kickoff === null) fail(`${s.slipId}: unknown kickoff`);
  if (now >= kickoff) fail(`${s.slipId}: match already started`);
  if (kickoff - now < START_BUFFER_MS) {
    fail(`${s.slipId}: kickoff too close (${Math.round((kickoff - now) / 1000)}s); refusing stale placement`);
  }

  const legs = s.legs ?? [];
  if (s.stake > STAKE_PER_BET * legs.length + 1e-9) {
    fail(`${s.slipId}: stake ${s.stake} exceeds per-bet limit`);
  }
  activeCount++;
  if (activeCount > STAKE_MAX_SLIPS) {
    fail(`${s.slipId}: would exceed STAKE_MAX_SLIPS=${STAKE_MAX_SLIPS} active slips`);
  }

  for (const leg of legs) {
    const cur = outcomeOdds(m, leg);
    if (cur === null) fail(`${s.slipId} leg ${leg.outcome}: outcome odds unavailable in live feed`);
    const minOdds = Number(leg.recommendedMinOdds ?? leg.minOdds ?? 0);
    if (minOdds && cur < minOdds - 1e-9) {
      fail(`${s.slipId} leg ${leg.outcome}: live odds ${cur} dropped below recommendedMinOdds ${minOdds}`);
    }
    const conf = Number(leg.confidence ?? 0);
    const odds = Number(leg.odds ?? cur);
    if (odds < FAV_BAND_LO - 1e-9 || odds >= FAV_BAND_HI + 1e-9) {
      if (conf < MIN_CONFIDENCE) {
        fail(
          `${s.slipId} leg ${leg.outcome}: odds ${odds} outside favorite band [${FAV_BAND_LO},${FAV_BAND_HI}) and confidence ${conf} < ${MIN_CONFIDENCE}`
        );
      }
    }
    if (conf > 0 && conf < MIN_CONFIDENCE) {
      fail(`${s.slipId} leg ${leg.outcome}: confidence ${conf} < MIN_CONFIDENCE ${MIN_CONFIDENCE}`);
    }
  }
  console.log(`[validate-stake] ${s.slipId}: PASS (${legs.length} leg(s), stake ${s.stake})`);
}

console.log('[validate-stake] all pending slips passed validation.');
process.exit(0);
