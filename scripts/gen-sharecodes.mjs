import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, isSimulated, fetchEventMarkets, fetchTodayFootballEvents } from '../lib/common.mjs';
import { createShareCode, shareUrl, ticketSummary } from '../share-code.mjs';
import { buildRecommendations } from '../dist/analysis.js';
import { selectBets } from '../stake.mjs';

const latest = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'latest.json'), 'utf8'));
const db = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'odds-db.json'), 'utf8'));
const empty = () => ({ name:'', flashscoreId:null, flashscoreUrl:null, position:null, played:null, points:null, form:'', formScore:0, lastResults:[], research:[], researchAt:null, scorers:[], assists:[], cards:[], league:null });
const mkt = (id) => ({ 1:'1X2', 18:'O/U', 548:'Multigoals', 41:'CorrectScore', 551:'Multiscores' }[id] ?? id);
const matches = (latest.matches ?? []).filter(m => !(isSimulated(m.homeTeam)||isSimulated(m.awayTeam)||isSimulated(m.tournament)) && !/^(H|FT|Finished|Live|Playing)/i.test(m.matchStatus ?? ''));
const researched = matches.map(m => ({ eventId:m.eventId, homeTeam:m.homeTeam, awayTeam:m.awayTeam, tournament:m.tournament, startTime:m.startTime, home:empty(), away:empty(), officials:null }));
const recs = buildRecommendations(researched, matches, db, mkt);
const picks = selectBets({ matches: recs }); // all recommended (high eligibility), all markets
console.log(`Recommended (high-eligibility) picks: ${picks.length}`);

const catalog = await fetchTodayFootballEvents();
const byId = new Map(catalog.map(e => [e.eventId, e]));
const byName = new Map(catalog.map(e => [`${e.homeTeam}|${e.awayTeam}`.toLowerCase(), e]));
const resolveEvent = (p) => byId.get(p.match.eventId) || byName.get(`${p.match.homeTeam}|${p.match.awayTeam}`.toLowerCase());
const resolvable = picks.filter(resolveEvent);
console.log(`In today's SportyBet catalog (open markets): ${resolvable.length} / ${picks.length}`);

const G = 4;
const size = Math.max(1, Math.ceil(resolvable.length / G));
const groups = Array.from({ length: G }, (_, i) => resolvable.slice(i * size, i * size + size));

async function resolveLeg(p) {
  const data = await fetchEventMarkets(p.match.eventId);
  const entries = (data?.markets ?? []).filter(m => String(m.id) === String(p.candidate.marketId));
  for (const m of entries) {
    const o = (m.outcomes ?? []).find(x => String(x.desc).trim().toLowerCase() === String(p.candidate.outcome).trim().toLowerCase());
    if (o) return { eventId: p.match.eventId, marketId: String(p.candidate.marketId), outcomeId: String(o.id), ...(m.specifier ? { specifier: m.specifier } : {}) };
  }
  throw new Error(`outcome "${p.candidate.outcome}" not found on market ${p.candidate.marketId}`);
}

let generated = 0;
for (let i = 0; i < groups.length; i++) {
  const g = groups[i].filter(Boolean);
  if (!g.length) { console.log(`\n=== GROUP ${i+1}: (no resolvable picks) ===`); continue; }
  console.log(`\n=== GROUP ${i+1} (${g.length} legs) ===`);
  for (const p of g) console.log(`  ${p.match.homeTeam} v ${p.match.awayTeam} | ${mkt(p.candidate.marketId)} ${p.candidate.outcome} @${p.candidate.odds}`);
  try {
    const selections = [];
    for (const p of g) { selections.push(await resolveLeg(p)); await new Promise(r => setTimeout(r, 200)); }
    const created = await createShareCode(selections);
    console.log(`  SHARE CODE: ${created.code}`);
    console.log(`  URL: ${shareUrl(created.code)}`);
    console.log(ticketSummary(created.data));
    generated++;
  } catch (e) {
    console.error(`  FAILED group ${i+1}: ${e.message}`);
  }
}
console.log(`\nGenerated ${generated} share code(s).`);
const skipped = picks.filter(p => !resolveEvent(p));
if (skipped.length) console.log(`Skipped ${skipped.length} recommended pick(s) with no open SportyBet market yet: ` + skipped.map(p=>`${p.match.homeTeam} v ${p.match.awayTeam}`).join('; '));
