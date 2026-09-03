// Print every match the agent would RECOMMEND from today's real scrape, using the
// normal confidence analysis (no force-recommend, no band override). Uses only the
// scraped odds + historical odds-db. No network needed.
//
// Usage: node scripts/print-recommended.mjs [--max N]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, isSimulated } from '../lib/common.mjs';
import { buildRecommendations } from '../dist/analysis.js';

const LATEST = process.env.LATEST_FILE ?? path.join(DATA_DIR, 'latest.json');
const DB = process.env.DB_FILE ?? path.join(DATA_DIR, 'odds-db.json');
const MAX = Number(process.argv.includes('--max') ? process.argv[process.argv.indexOf('--max') + 1] : Infinity);

const emptyTeam = () => ({
  name: '', flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null,
  form: '', formScore: 0, lastResults: [], research: [], researchAt: null, scorers: [], assists: [], cards: [], league: null,
});

const marketNames = (mid) => ({ 1: '1X2', 18: 'O/U', 548: 'Multigoals', 41: 'CorrectScore', 551: 'Multiscores' }[mid] ?? mid);

function main() {
  const latest = JSON.parse(fs.readFileSync(LATEST, 'utf8'));
  const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
  const matches = (latest.matches ?? []).filter(
    (m) => !(isSimulated(m.homeTeam) || isSimulated(m.awayTeam) || isSimulated(m.tournament)) &&
      !/^(H|FT|Finished|Live|Playing)/i.test(m.matchStatus ?? '')
  );

  const researched = matches.map((m) => ({
    eventId: m.eventId, homeTeam: m.homeTeam, awayTeam: m.awayTeam,
    tournament: m.tournament, startTime: m.startTime,
    home: emptyTeam(), away: emptyTeam(), officials: null,
  }));

  const recs = buildRecommendations(researched, matches, db, marketNames);

  const lines = [];
  let total = 0;
  for (const r of recs) {
    const recsForMatch = r.candidates.filter((c) => c.recommended);
    if (!recsForMatch.length) continue;
    total++;
    lines.push(`\n${r.match.homeTeam} vs ${r.match.awayTeam}  (${r.match.tournament})  KO ${r.match.startTime ?? '?'}`);
    for (const c of recsForMatch) {
      const note = /LOW SAMPLE|NO DATA/.test(c.reason) ? '  [LOW SAMPLE]' : '';
      const edge = c.edge != null ? `edge ${(c.edge * 100).toFixed(0)}%` : 'edge n/a';
      lines.push(`   ${marketNames(c.marketId)}: ${c.outcome} @${c.odds}  (${edge}, conf ${(c.confidence * 100).toFixed(0)}%)${note}`);
    }
  }

  console.log(`\n=== RECOMMENDED MATCHES (normal analysis, no force-recommend) ===`);
  console.log(`Scanned ${matches.length} upcoming matches | Recommended: ${total}`);
  console.log('─'.repeat(80));
  console.log(lines.slice(0, MAX === Infinity ? lines.length : MAX * 2).join('\n'));
}

main();
