// Web research: pulls recent news/preview snippets via a public search page
// (DuckDuckGo html, no API key) as a stand-in for search-engine indexing.
// Research is split per side so each team's news feeds its own confidence.

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

export interface ResearchSet {
  match: string[]; // shared preview (both teams)
  home: string[]; // home team's own news
  away: string[]; // away team's own news
  homeInjuries: string[]; // home team injury/suspension snippets
  awayInjuries: string[]; // away team injury/suspension snippets
  homePlayers: string[]; // home team key-player/lineup snippets
  awayPlayers: string[]; // away team key-player/lineup snippets
}

// Per-side research so both teams get symmetric web signal (fix: the old
// second query only ever researched the home team). Injury/suspension and
// key-player/lineup queries are split per side too, so each team's player news
// feeds its own confidence.
export async function webResearch(home: string, away: string, tournament: string): Promise<ResearchSet> {
  const queries = [
    { side: 'match', q: `${home} vs ${away} preview` },
    { side: 'home', q: `${home} ${tournament} recent form` },
    { side: 'away', q: `${away} ${tournament} recent form` },
    { side: 'homeInjuries', q: `${home} injuries suspensions team news` },
    { side: 'awayInjuries', q: `${away} injuries suspensions team news` },
    { side: 'homePlayers', q: `${home} predicted lineup key players` },
    { side: 'awayPlayers', q: `${away} predicted lineup key players` },
  ] as const;
  const results: ResearchSet = { match: [], home: [], away: [], homeInjuries: [], awayInjuries: [], homePlayers: [], awayPlayers: [] };
  for (const { side, q } of queries) {
    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en',
        },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const html = await res.text();
      results[side].push(...extractSnippets(html, 2));
    } catch {
      // best-effort: skip
    }
  }
  return {
    match: uniq(results.match).slice(0, 6),
    home: uniq(results.home).slice(0, 6),
    away: uniq(results.away).slice(0, 6),
    homeInjuries: uniq(results.homeInjuries).slice(0, 6),
    awayInjuries: uniq(results.awayInjuries).slice(0, 6),
    homePlayers: uniq(results.homePlayers).slice(0, 6),
    awayPlayers: uniq(results.awayPlayers).slice(0, 6),
  };
}