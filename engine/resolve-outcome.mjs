// Real outcome-id resolver for the Manual/Auto executors (spec #13). Maps an
// ApprovedPick (eventId, marketId, selection) -> SportyBet's numeric outcomeId
// by querying the live event catalog. Injectable in tests (no network).
import { fetchEventMarkets } from '../lib/common.mjs';

export async function resolveOutcomeId(pick, { fetchMarkets = fetchEventMarkets } = {}) {
  const data = await fetchMarkets(pick.matchId);
  const market = (data?.markets ?? []).find((m) => String(m.id) === String(pick.marketId));
  if (!market) return null;
  const outcome = (market.outcomes ?? []).find(
    (o) => o.desc === pick.selection || o.name === pick.selection
  );
  return outcome?.id ?? null;
}
