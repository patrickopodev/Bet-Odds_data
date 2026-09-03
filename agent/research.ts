// Web research: a PLUGGABLE search provider (default DuckDuckGo html, no API
// key) that pulls recent news/preview and head-to-head (H2H) snippets as a
// stand-in for search indexing. H2H queries are tried first so both teams get
// the meetings history (this year and past seasons) alongside form/news. The
// same result list is shared by both sides, so each team's research is
// symmetric.
//
// Research is INFORMATIONAL ONLY. It is attached to each team as context for
// manual review and MUST NOT feed Strategy A's selection — the 1X2_BAND rule
// qualifies candidates independently of any web result.
//
// Anti-bot resilience (Phase 1): detects HTTP 202 / challenge pages, applies
// exponential backoff + jitter, spaces requests, and returns an explicit status
// (SEARCH_SUCCESS / SEARCH_NO_RESULTS / SEARCH_BLOCKED / SEARCH_ERROR). A blocked
// search is NEVER reported as an empty result, so it can never be mistaken for
// "no information found" by the betting pipeline.

import type { SearchStatus } from './types.js';

const UA =
  process.env.USER_AGENT ??
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let warnedMarkup = false;

// Normalize + dedupe snippets so identical results from different queries never
// inflate the count (fix: no duplication of the research array).
function uniq(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of items) {
    const key = s.toLowerCase().replace(/\s+/g, ' ').trim();
    if (key && !seen.has(key)) {
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

// DuckDuckGo html results: each result title+link in <a ... class="result__a">,
// snippet in <a class="result__snippet">. DuckDuckGo changes this markup over
// time and the old regexes then silently parse nothing, so if a non-trivial
// page returned zero snippets we warn once instead of failing quietly.
export function extractSnippets(html: string, limit = 3): string[] {
  const out: string[] = [];
  const titleRe = /class="result__a"[^>]*>([^<]+)</g;
  const snipRe = /class="result__snippet"[^>]*>([^<]*)</g;
  const titles: string[] = [];
  const snips: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = titleRe.exec(html)) && titles.length < limit) titles.push(m[1].trim());
  while ((m = snipRe.exec(html)) && snips.length < limit) snips.push(m[1].trim());
  for (let i = 0; i < Math.max(titles.length, snips.length); i++) {
    const t = titles[i] ?? '';
    const s = snips[i] ?? '';
    out.push(`${t}${s ? ` — ${s}` : ''}`.slice(0, 200));
  }
  const parsed = out.filter(Boolean);
  if (parsed.length === 0 && html.trim().length > 500 && !warnedMarkup) {
    warnedMarkup = true;
    console.warn('[research] DuckDuckGo markup may have changed; no snippets parsed.');
  }
  return uniq(parsed);
}

// ---------------------------------------------------------------------------
// Provider abstraction (Phase 2). A provider knows how to issue one raw request,
// how to recognise its own challenge/block page, and how to parse snippets. New
// providers (Bing / Google CSE / SerpAPI) can be registered here and read
// process.env.SEARCH_API_KEY — no research logic needs to change.
// ---------------------------------------------------------------------------
export interface SearchProvider {
  name: string;
  request(query: string): Promise<{ httpStatus: number; html: string }>;
  isBlock(httpStatus: number, html: string): boolean;
  parse(html: string, limit?: number): string[];
}

const DDG_BLOCK_RE =
  /anomaly|captcha|security check|unusual traffic|please verify|why_ddg|blocked/i;

const duckduckgoProvider: SearchProvider = {
  name: 'duckduckgo',
  async request(query: string) {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en',
      },
      signal: AbortSignal.timeout(10000),
    });
    const html = await res.text();
    return { httpStatus: res.status, html };
  },
  isBlock(httpStatus: number, html: string) {
    // DuckDuckGo answers challenges with HTTP 202 (not an error) and a verify
    // page; either signature means the request was throttled, not that there
    // are no results.
    return httpStatus === 202 || DDG_BLOCK_RE.test(html);
  },
  parse(html: string, limit = 3) {
    return extractSnippets(html, limit);
  },
};

const PROVIDERS: Record<string, SearchProvider> = { duckduckgo: duckduckgoProvider };

function getProvider(): SearchProvider {
  const name = (process.env.SEARCH_PROVIDER ?? 'duckduckgo').toLowerCase();
  const p = PROVIDERS[name];
  if (!p) {
    console.warn(`[research] unknown SEARCH_PROVIDER="${name}", falling back to duckduckgo`);
    return duckduckgoProvider;
  }
  return p;
}

export interface WebResearchResult {
  status: SearchStatus;
  snippets: string[];
  httpStatus?: number;
  reason?: string;
  predictions?: string[]; // external prediction snippets (winner / score / tips)
  predictionStatus?: SearchStatus; // SEARCH_SUCCESS | SEARCH_NO_RESULTS | SEARCH_BLOCKED | SEARCH_ERROR
}

// Pure builder for the prediction-focused queries — kept separate from
// runQuery so it can be unit-tested without network access.
export function buildPredictionQueries(home: string, away: string, tournament: string): string[] {
  return [
    `${home} vs ${away} prediction`,
    `${home} vs ${away} predicted score`,
    `${home} vs ${away} betting tips`,
    `${home} ${away} match prediction ${tournament}`,
  ];
}

// --- retry/backoff tuning ---
const MAX_ATTEMPTS = 5; // initial request + 4 retries for persistent anti-bot challenges
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (retry: number) => Math.min(15000, 1500 * 2 ** retry) + Math.random() * 1000;
const spacingMs = () => 1000 + Math.random() * 1000; // politeness between queries; increased base

// One query, with retry/backoff and explicit block detection. Never loops
// forever: ordinary 4xx (other than 429) are reported immediately, not retried.
async function runQuery(provider: SearchProvider, query: string): Promise<WebResearchResult> {
  let blockedSeen = false;
  let errorSeen = false;
  let successSeen = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(backoffMs(attempt));
    try {
      const { httpStatus, html } = await provider.request(query);
      if (provider.isBlock(httpStatus, html)) {
        blockedSeen = true;
        console.warn(
          `[research] SEARCH_BLOCKED (HTTP ${httpStatus}) "${query}" attempt ${attempt + 1}/${MAX_ATTEMPTS}`
        );
        continue;
      }
      if (httpStatus === 429 || httpStatus >= 500) {
        errorSeen = true;
        console.warn(
          `[research] transient HTTP ${httpStatus} "${query}" attempt ${attempt + 1}/${MAX_ATTEMPTS}`
        );
        continue;
      }
      if (httpStatus >= 400) {
        return { status: 'SEARCH_ERROR', snippets: [], httpStatus, reason: `HTTP ${httpStatus}` };
      }
      successSeen = true;
      const snippets = provider.parse(html, 2);
      return {
        status: snippets.length ? 'SEARCH_SUCCESS' : 'SEARCH_NO_RESULTS',
        snippets,
        httpStatus,
      };
    } catch (e) {
      errorSeen = true;
      console.warn(
        `[research] request error "${query}": ${(e as Error).message} attempt ${attempt + 1}/${MAX_ATTEMPTS}`
      );
      continue;
    }
  }
  if (blockedSeen) {
    return { status: 'SEARCH_BLOCKED', snippets: [], reason: 'exhausted retries (challenge/rate-limit)' };
  }
  if (errorSeen && !successSeen) {
    return { status: 'SEARCH_ERROR', snippets: [], reason: 'exhausted retries (network/5xx)' };
  }
  return { status: 'SEARCH_NO_RESULTS', snippets: [], reason: 'no results after retries' };
}

// Web research is a flat list of recent news/preview snippets shared by both
// teams. Injury/lineup queries were removed entirely: they fed confidence
// signals that did not improve recommendations (and the fields are gone from
// TeamInfo).
export async function webResearch(
  home: string,
  away: string,
  tournament: string
): Promise<WebResearchResult> {
  const provider = getProvider();
  // H2H first so the meetings history (this year + past seasons) is always
  // captured; form/preview queries follow.
  const queries = [
    `${home} vs ${away} head to head`,
    `${home} vs ${away} h2h record`,
    `${home} vs ${away} preview`,
    `${home} ${tournament} recent form`,
    `${away} ${tournament} recent form`,
  ];
  const all: string[] = [];
  let blocked = false;
  let errored = false;
  for (let i = 0; i < queries.length; i++) {
    if (i > 0) await sleep(spacingMs());
    const r = await runQuery(provider, queries[i]);
    if (r.status === 'SEARCH_SUCCESS') {
      all.push(...r.snippets);
      if (all.length >= 8) break;
    } else if (r.status === 'SEARCH_BLOCKED') {
      blocked = true;
    } else if (r.status === 'SEARCH_ERROR') {
      errored = true;
    }
  }
  let status: SearchStatus = 'SEARCH_NO_RESULTS';
  if (all.length > 0) status = 'SEARCH_SUCCESS';
  else if (blocked) status = 'SEARCH_BLOCKED';
  else if (errored) status = 'SEARCH_ERROR';

  // External predictions (winner / score / tips) fetched separately so they are
  // always reported distinctly from the H2H/form context snippets.
  const predQueries = buildPredictionQueries(home, away, tournament);
  const predictions: string[] = [];
  let predBlocked = false;
  let predErrored = false;
  for (const q of predQueries) {
    await sleep(spacingMs());
    const r = await runQuery(provider, q);
    if (r.status === 'SEARCH_SUCCESS') predictions.push(...r.snippets);
    else if (r.status === 'SEARCH_BLOCKED') predBlocked = true;
    else if (r.status === 'SEARCH_ERROR') predErrored = true;
  }
  let predictionStatus: SearchStatus = 'SEARCH_NO_RESULTS';
  if (predictions.length > 0) predictionStatus = 'SEARCH_SUCCESS';
  else if (predBlocked) predictionStatus = 'SEARCH_BLOCKED';
  else if (predErrored) predictionStatus = 'SEARCH_ERROR';

  return {
    status,
    snippets: uniq(all).slice(0, 10),
    predictions: uniq(predictions).slice(0, 10),
    predictionStatus,
  };
}
