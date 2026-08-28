// ---------------------------------------------------------------------------
// ENGINE SLIP — the unified engine's manual execution path (spec #11, #13).
//
// Reads the engine's approved-picks.json, resolves live outcome IDs, builds the
// SportyBet share code, and STOPS. This is the single manual path going forward;
// manual-slip.yml becomes the legacy duplicate once equivalence is proven. It
// never stakes and never touches auto-staking.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { manualExecute } from './executors.mjs';
import { resolveOutcomeId } from './resolve-outcome.mjs';
import { createShareCode } from '../share-code.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';
const APPROVED = path.join(DATA_DIR, 'approved-picks.json');

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dryRun = process.argv.includes('--dry-run');
  let approved = [];
  try {
    approved = JSON.parse(fs.readFileSync(APPROVED, 'utf8')).approved ?? [];
  } catch {
    console.error(`[engine-slip] no approved-picks.json at ${APPROVED}; run engine-daily.yml first.`);
    process.exit(1);
  }
  if (!approved.length) {
    console.log('[engine-slip] no approved picks — nothing to code.');
    process.exit(0);
  }
  const create = dryRun
    ? async (sels) => ({ code: `DRYRUN(${sels.length})` })
    : createShareCode;
  const res = await manualExecute(approved, { resolveOutcomeId, createShareCode: create });
  console.log(`[engine-slip] ${res.picks.length} pick(s) -> share code: ${res.code}`);
  console.log(`[engine-slip] mode=MANUAL stakes=false (human places the code).`);
}
