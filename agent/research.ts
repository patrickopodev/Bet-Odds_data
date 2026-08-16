// Web research: pulls recent news/preview snippets via a public search page
// (DuckDuckGo html, no API key) as a stand-in for search-engine indexing.

const UA =
  process.env.USER_AGENT ??
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export function extractSnippets(html: string, limit = 3): string[] {
  // DuckDuckGo html results: each result title+link in <a ... class="result__a">,
  // snippet in <a class="result__snippet">.
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
  return out.filter(Boolean);
}

export async function webResearch(home: string, away: string, tournament: string): Promise<string[]> {
  const queries = [
    `${home} vs ${away} preview`,
    `${home} ${tournament} recent form`,
  ];
  const results: string[] = [];
  for (const q of queries) {
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
      results.push(...extractSnippets(html, 2));
    } catch {
      // best-effort: skip
    }
    if (results.length >= 6) break;
  }
  return [...new Set(results)].slice(0, 6);
}