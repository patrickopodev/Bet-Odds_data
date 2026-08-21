// SportyBet API client for the TypeScript agent: reads the live market state
// and the share code so the agent can confirm a staked selection before the
// match and monitor it until it ends.

import { UA } from '../lib/common.mjs';

const SPORTYBET_BASE_URL = process.env.SPORTYBET_BASE_URL ?? 'https://www.sportybet.com';

async function fetchSportyJson(url: string): Promise<any> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Referer: `${SPORTYBET_BASE_URL}/gh/m/`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// SportyBet wraps responses in { bizCode, message, data }; unwrap `.data` the
// same way lib/common.mjs does, and fail loudly on a non-success code.
async function fetchSportyData(url: string): Promise<any> {
  const body = await fetchSportyJson(url);
  if (body.bizCode !== 10000) {
    throw new Error(`API error ${body.bizCode}: ${body.message ?? body.innerMsg} for ${url}`);
  }
  return body.data;
}

export interface FsOutcome {
  id: string;
  desc: string;
  odds: number;
  isActive?: number;
}

export interface FsMarket {
  id: number | string;
  desc?: string;
  specifier?: string;
  outcomes?: FsOutcome[];
}

// Fetch one event's full market list (productId 3 = pre-match).
export async function fetchEventMarkets(eventId: string, productId = 3): Promise<{ markets?: FsMarket[] }> {
  const url = `${SPORTYBET_BASE_URL}/api/gh/factsCenter/event?productId=${productId}&eventId=${encodeURIComponent(eventId)}`;
  return fetchSportyData(url);
}

// Resolve a bet's outcome name against the fetched markets. Returns the
// matching market entry (with its specifier), the outcome, and the live odds.
export function resolveOutcome(
  data: { markets?: FsMarket[] },
  marketId: string,
  outcomeName: string
): { market: FsMarket; outcome: FsOutcome; currentOdds: number } | null {
  const target = String(outcomeName).trim().toLowerCase();
  for (const m of data?.markets ?? []) {
    if (String(m.id) !== String(marketId)) continue;
    const outcome = (m.outcomes ?? []).find(
      (o) => String(o.desc).trim().toLowerCase() === target
    );
    if (outcome) return { market: m, outcome, currentOdds: Number(outcome.odds) };
  }
  return null;
}

// Load a share code's stored selections (proves the code still resolves).
export async function loadShareCode(code: string): Promise<any> {
  const url = `${SPORTYBET_BASE_URL}/api/gh/orders/share/${encodeURIComponent(code)}`;
  return fetchSportyData(url);
}