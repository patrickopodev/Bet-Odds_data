import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, fetchEventMarkets, fetchTodayFootballEvents } from '../lib/common.mjs';
import { createShareCode, shareUrl, ticketSummary } from '../share-code.mjs';
import { frozen1X2 } from '../lib/1x2.mjs';

const { lo, hi } = frozen1X2();
const catalog = await fetchTodayFootballEvents();
console.log(`Live catalog events (today): ${catalog.length}`);

const eligible = [];
for (const ev of catalog) {
  try {
    const data = await fetchEventMarkets(ev.eventId);
    const m1 = (data?.markets ?? []).find(m => String(m.id) === '1');
    if (!m1) continue;
    const outs = m1.outcomes ?? [];
    const get = (re) => outs.find(o => re.test(o.desc));
    const home = get(/^home$/i), draw = get(/^draw$/i), away = get(/^away$/i);
    if (!home || !draw || !away) continue;
    const odds = { Home: parseFloat(home.odds), Draw: parseFloat(draw.odds), Away: parseFloat(away.odds) };
    const fav = [['Home', odds.Home, home.id], ['Draw', odds.Draw, draw.id], ['Away', odds.Away, away.id]]
      .sort((a, b) => a[1] - b[1])[0];
    if (fav[1] >= lo && fav[1] < hi) {
      eligible.push({ ev, team: fav[0], odds: fav[1], outcomeId: String(fav[2]) });
    }
  } catch (e) { /* skip event on fetch error */ }
  await new Promise(r => setTimeout(r, 150));
}
console.log(`Fav-band eligible (1X2 favorite in [${lo}, ${hi})): ${eligible.length}`);

const G = 4;
const size = Math.max(1, Math.ceil(eligible.length / G));
const groups = Array.from({ length: G }, (_, i) => eligible.slice(i * size, i * size + size));

let generated = 0;
for (let i = 0; i < groups.length; i++) {
  const g = groups[i];
  if (!g.length) { console.log(`\n=== GROUP ${i+1}: (no picks) ===`); continue; }
  console.log(`\n=== GROUP ${i+1} (${g.length} legs) ===`);
  const selections = [];
  for (const p of g) {
    console.log(`  ${p.ev.homeTeam} v ${p.ev.awayTeam} | 1X2 ${p.team} @${p.odds}`);
    selections.push({ eventId: p.ev.eventId, marketId: '1', outcomeId: p.outcomeId });
  }
  try {
    const created = await createShareCode(selections);
    console.log(`  SHARE CODE: ${created.code}`);
    console.log(`  URL: ${shareUrl(created.code)}`);
    console.log(ticketSummary(created.data));
    generated++;
  } catch (e) {
    console.error(`  FAILED group ${i+1}: ${e.message}`);
  }
}
console.log(`\nGenerated ${generated} share code(s) from live catalog.`);
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(path.join(DATA_DIR, 'favband-today-groups.json'), JSON.stringify({ band: [lo, hi], eligible: eligible.map(e => ({ eventId: e.ev.eventId, home: e.ev.homeTeam, away: e.ev.awayTeam, team: e.team, odds: e.odds })), groups: groups.map((g, i) => ({ group: i + 1, legs: g.length })) }, null, 2));
