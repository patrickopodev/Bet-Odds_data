// ---------------------------------------------------------------------------
// TRAINING -> PROMOTION PIPELINE (spec #2, #5, #16).
//
// The pipeline is proposal-only. It evaluates a PAPER strategy's forward track
// against the promotion gate (>= minResolved AND positive ROI) and writes a
// PROPOSAL. It NEVER mutates the frozen strategy-registry.json and NEVER flips a
// strategy to LIVE — that is a human decision (spec #7, #5). This keeps training
// strictly isolated from live promotion.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR ?? 'data';

export const PROMOTION_DEFAULTS = { minResolved: 30, minRoi: 0 };

// Evaluate the gate. Pure function — no IO.
export function evaluatePromotionGate(metrics, { defaults = PROMOTION_DEFAULTS } = {}) {
  const resolved = metrics.resolved ?? metrics.settled ?? 0;
  const roi = metrics.roi ?? 0;
  const eligible = resolved >= defaults.minResolved && roi > defaults.minRoi;
  return {
    eligible,
    resolved,
    roi,
    reason: eligible
      ? 'ELIGIBLE_FOR_HUMAN_REVIEW (not auto-promoted)'
      : `resolved ${resolved}/${defaults.minResolved}, roi ${roi} — gate not met`,
  };
}

// Write a proposal record. Never edits the frozen registry.
export function proposePromotion(strategyId, metrics, { file, defaults } = {}) {
  const gate = evaluatePromotionGate(metrics, { defaults });
  const proposal = {
    strategyId,
    metrics,
    gate,
    autoPromoted: false,
    proposedAt: new Date().toISOString(),
  };
  const out = file ?? path.join(DATA_DIR, 'promotion-proposals.json');
  let arr = [];
  try {
    arr = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch {
    /* fresh */
  }
  arr.push(proposal);
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(arr, null, 2));
  return proposal;
}
