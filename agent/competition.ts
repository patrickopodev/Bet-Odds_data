// Competition-type classification for a team's recent results. Pure, no I/O, so
// it stays trivially unit-testable and importable without pulling in the browser.

export type MatchType = 'league' | 'cup' | 'friendly' | 'international' | 'other';

// Map a tournament/competition name to a coarse type. Order matters: friendly
// and international are tested before cup/league so e.g. "UEFA Euro" is
// international (not caught by the "league" branch) and "Europa League" is cup.
export function classifyCompetition(name?: string | null): MatchType {
  if (!name) return 'other';
  const n = name.toLowerCase();
  if (/(friendly|exhib|charity match|benchmark|test match)/.test(n)) return 'friendly';
  if (
    /(world cup|euro\b|european championship|nations league|copa am[eé]rica|afcon|asian cup|gold cup|concacaf|intercontinental|olympic|u-?1[7-9]|u-?2[0-9]|under-?\d+|confederations cup|continental cup)/.test(
      n
    )
  )
    return 'international';
  if (
    /(cup|champions league|europa|conference league|fa cup|coppa|dfb|coupe|liber|sudamericana|supercopa|league cup|copa del|taça|taça|knockout|play-?off|final|shield|trophy)/.test(
      n
    )
  )
    return 'cup';
  if (
    /(league|bundesliga|premier|serie a|ligue|primera|segunda|super lig|ekstraklasa|eredivisie|primeira|championship|division|oberliga|regionalliga|bundes|liga|lig|championnat)/.test(
      n
    )
  )
    return 'league';
  return 'other';
}

// Build a human-readable summary of the competition mix across a set of recent
// results, e.g. "Last 5: 3 league, 1 cup, 1 friendly". Drives the "state the
// difference of the type of matches" requirement.
export function competitionMix(types: MatchType[]): string {
  if (!types.length) return 'no recent results';
  const counts = new Map<MatchType, number>();
  for (const t of types) counts.set(t, (counts.get(t) ?? 0) + 1);
  const order: MatchType[] = ['league', 'cup', 'international', 'friendly', 'other'];
  const parts = order
    .filter((t) => counts.has(t))
    .map((t) => `${counts.get(t)} ${t}`);
  return `Last ${types.length}: ${parts.join(', ')}`;
}
