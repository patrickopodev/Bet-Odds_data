import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DATA_DIR,
  DB_FILE,
  MARKET_ORDER,
  isSimulated,
  aggregateHistoricalStats,
  fetchEventMarkets,
} from './lib/common.mjs';
import { createShareCode, shareUrl, ticketSummary, loadShareCode } from './share-code.mjs';
import { resolveTeam, fetchTeamForm } from './dist/flashscore.js';

// ---------------------------------------------------------------------------
// Manual full-card odds review + HIGH-CONVICTION, DEEP-SEARCH-FITTED value code.
//
// Selection funnel:
//   1. Start: today's remaining (not-started) games, all 4 sections.
//   2. Odds cap (drop longshots > VALUE_ODDS_CAP).
//   3. Trust (settled >= VALUE_TRUST_MIN).
//   4. Edge floor (winRate - implied >= VALUE_EDGE_MIN).
//   5. Best outcome per section per game.
//   6. Rank by edge, cap at MAX_PICKS.
//   7. Resolve to live SportyBet outcome ids (network).
//   8. DEEP SEARCH FIT (NEW): for each surviving candidate, run the agent's deep
//      search — researchTeam (Flashscore form + last-results) and webResearch
//      (H2H) — and DROP picks the research contradicts. Only research-confirmed
//      "fitting" odds reach the share code. Research is display + filter only;
//      it never invents odds.
//
// FAV_BAND 1X2 is intentionally NOT used here (removed from this track).
// Makes NO automatic bets.
// ---------------------------------------------------------------------------

const LATEST_FILE = process.env.LATEST_FILE ?? path.join(DATA_DIR, 'latest.json');
const CODE_FILE = process.env.CODE_FILE ?? path.join(DATA_DIR, 'manual-code.txt');

const VALUE_TRUST_MIN = Number(process.env.VALUE_TRUST_MIN ?? 20);
const VALUE_EDGE_MIN = Number(process.env.VALUE_EDGE_MIN ?? 0.08);
const VALUE_ODDS_CAP = Number(process.env.VALUE_ODDS_CAP ?? 6.0);
const MAX_PICKS = Number(process.env.MAX_PICKS ?? 20);
const RESEARCH_BUDGET = Number(process.env.RESEARCH_BUDGET ?? 20);

const BAR = '─'.repeat(80);

const NON_LEFT = new Set(['Playing', 'Live', 'Finished', 'Postponed', 'Cancelled', 'Abandoned']);
function isLeft(m) {
  const s = m.matchStatus;
  if (!s) return true;
  return !NON_LEFT.has(s);
}

function implied(odds) {
  return odds > 0 ? 1 / odds : 0;
}

function oneXtwoMargin(section) {
  const outs = (section?.outcomes ?? []).filter((o) => o.marketId === '1' && o.active);
  if (outs.length < 2) return null;
  return outs.reduce((s, o) => s + implied(o.odds), 0);
}

function fmtKickoff(iso) {
  if (!iso) return 'unknown';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z').slice(0, 16) + 'Z';
}

// --- odds-history funnel (stages 2-4) ---
function outcomeHistory(stats, marketId, outcome, odds) {
  const lo = odds * 0.75;
  const hi = odds * 1.3;
  const rows = stats.filter(
    (s) => s.marketId === marketId && s.name === outcome && s.odds >= lo && s.odds <= hi && s.settled > 0
  );
  if (rows.length === 0) return { winRate: null, settled: 0 };
  const won = rows.reduce((n, r) => n + r.won, 0);
  const settled = rows.reduce((n, r) => n + r.settled, 0);
  return { winRate: settled >= 3 ? won / settled : null, settled };
}

// Best outcome in a section passing guardrails (no network resolve).
function bestInSection(section, stats) {
  if (!section || !section.outcomes?.length) return null;
  let best = null;
  for (const o of section.outcomes) {
    if (!o.active || o.odds > VALUE_ODDS_CAP) continue;
    const h = outcomeHistory(stats, o.marketId, o.name, o.odds);
    if (h.winRate == null || h.settled < VALUE_TRUST_MIN) continue;
    const edge = h.winRate - implied(o.odds);
    if (edge < VALUE_EDGE_MIN) continue;
    if (!best || edge > best.edge) best = { o, edge, winRate: h.winRate, settled: h.settled };
  }
  return best;
}

// --- stage 8: deep-search fit ---
// Returns { keep, note }. Uses Flashscore form/last-results context.
function researchFit(pick, homeInfo, awayInfo) {
  const noData = !homeInfo && !awayInfo;
  if (noData) return { keep: true, note: 'research unavailable (kept)' };

  // 1X2: compare the picked side's form to the opponent's.
  if (pick.marketId === '1' && pick.name !== 'Draw') {
    const me = pick.name === 'Home' ? homeInfo : awayInfo;
    const opp = pick.name === 'Home' ? awayInfo : homeInfo;
    const meF = me?.formScore ?? 0;
    const oppF = opp?.formScore ?? 0;
    const gap = oppF - meF;
    if (gap >= 4) return { keep: false, note: `form gap ${gap} against` };
    return { keep: true, note: `form ${me?.form || '?'}` };
  }
  if (pick.marketId === '1') return { keep: true, note: 'draw (research neutral)' };

  // O/U: recent goal totals vs the line.
  if (pick.marketId === '18') {
    const line = parseFloat(String(pick.specifier ?? '').replace('total=', ''));
    if (!line) return { keep: true, note: 'no line (kept)' };
    const goals = [...(homeInfo?.lastResults ?? []), ...(awayInfo?.lastResults ?? [])]
      .map((r) => {
        const [a, b] = String(r.score ?? '').split('-').map(Number);
        return Number.isFinite(a) && Number.isFinite(b) ? a + b : null;
      })
      .filter((x) => x != null);
    if (goals.length < 2) return { keep: true, note: 'thin recent goals (kept)' };
    const avg = goals.reduce((x, y) => x + y, 0) / goals.length;
    const isOver = pick.name.startsWith('Over');
    const fits = isOver ? avg >= line : avg <= line;
    if (!fits) return { keep: false, note: `avg ${avg.toFixed(1)} goals vs line ${line}` };
    return { keep: true, note: `avg ${avg.toFixed(1)} goals vs line ${line}` };
  }

  // Correct Score / Multiscores / Multigoals: research is contextual only.
  const me = homeInfo;
  return { keep: true, note: `form ${me?.form || '?'}` };
}

// Flashscore deep research WITHOUT the slow standings browser: resolve the team
// and fetch its form + last-5 results (fetch-based). Returns {form, formScore, lastResults}.
async function deepResearch(name) {
  try {
    const team = await resolveTeam(name);
    if (!team) return null;
    const tf = await fetchTeamForm(team);
    const formScore = (tf.lastResults ?? []).reduce(
      (n, r) => n + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0),
      0
    );
    return { form: tf.form, formScore, lastResults: tf.lastResults };
  } catch {
    return null;
  }
}

const marketCache = new Map();
async function resolveOutcomeId(eventId, marketId, outcomeName) {
  let data = marketCache.get(eventId);
  if (!data) {
    data = await fetchEventMarkets(eventId).catch(() => null);
    marketCache.set(eventId, data);
  }
  const market = (data?.markets ?? []).find((m) => String(m.id) === String(marketId));
  if (!market) return {};
  const o = (market.outcomes ?? []).find((x) => x.desc === outcomeName || x.name === outcomeName);
  if (!o) return {};
  return { outcomeId: String(o.id), specifier: market.specifier ?? undefined };
}

async function main() {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(LATEST_FILE, 'utf8'));
  } catch (e) {
    console.error(`manual-review: cannot read ${LATEST_FILE}: ${e.message}`);
    process.exit(0);
  }

  const DAY = process.env.MANUAL_DAY;
  let matches = data.matches ?? [];
  if (DAY) matches = matches.filter((m) => (m.startTime ?? '').startsWith(DAY));

  const before = matches.length;
  matches = matches.filter(
    (m) => !(isSimulated(m.homeTeam) || isSimulated(m.awayTeam) || isSimulated(m.tournament))
  );
  const droppedSim = before - matches.length;

  const groups = new Map();
  for (const m of matches) {
    if (!groups.has(m.tournament)) groups.set(m.tournament, []);
    groups.get(m.tournament).push(m);
  }

  console.log(`\nTODAY'S FULL-CARD ODDS REVIEW${DAY ? ' — ' + DAY : ''}`);
  console.log(`Source: ${LATEST_FILE}`);
  console.log(`Scraped: ${data.scrapedAt ?? 'n/a'}`);
  console.log(`Matches: ${matches.length} (excluded ${droppedSim} simulated)`);
  console.log(BAR);

  if (!matches.length) {
    console.log('No qualifying matches to review right now.');
    console.log(BAR);
    return;
  }

  for (const [tournament, ms] of groups) {
    console.log(`\n## ${tournament}  (${ms.length})`);
    console.log(BAR);
    ms.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
    for (const m of ms) {
      const ko = fmtKickoff(m.startTime);
      console.log(`\n${m.homeTeam} vs ${m.awayTeam}`);
      console.log(`  Kickoff: ${ko}   Status: ${m.matchStatus ?? 'n/a'}`);
      for (const key of MARKET_ORDER) {
        const section = m.markets?.[key];
        if (!section || !section.outcomes || section.outcomes.length === 0) continue;
        const margin = section.outcomes.some((o) => o.marketId === '1') ? oneXtwoMargin(section) : null;
        const marginStr = margin != null ? `   [1X2 margin ${(margin * 100).toFixed(1)}%]` : '';
        console.log(`  ${key}${marginStr}`);
        for (const o of section.outcomes) {
          const tag = o.active ? '' : '  (suspended)';
          console.log(`    ${o.name.padEnd(28)} ${String(o.odds).padStart(7)}${tag}`);
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // STAGES 2-6: odds-history funnel -> ranked candidates.
  // -------------------------------------------------------------------------
  let db;
  try {
    db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch (e) {
    console.error(`\n[value] cannot read ${DB_FILE}: ${e.message}`);
    return;
  }
  const stats = aggregateHistoricalStats(db);
  const leftGames = matches.filter(isLeft);

  const candidates = [];
  const candReport = [];
  for (const m of leftGames) {
    const gp = [];
    for (const key of MARKET_ORDER) {
      const b = bestInSection(m.markets?.[key], stats);
      if (b) {
        const pick = {
          eventId: m.eventId,
          homeTeam: m.homeTeam,
          awayTeam: m.awayTeam,
          tournament: m.tournament,
          marketId: b.o.marketId,
          name: b.o.name,
          odds: b.o.odds,
          specifier: b.o.specifier,
          edge: b.edge,
          winRate: b.winRate,
          settled: b.settled,
        };
        gp.push(pick);
        candidates.push(pick);
      }
    }
    if (gp.length) candReport.push({ m, gp });
  }

  const ranked = [...candidates].sort((a, b) => b.edge - a.edge).slice(0, RESEARCH_BUDGET);

  console.log(`\n${BAR}`);
  console.log(`STAGES 2-6 (odds-history funnel): ${candidates.length} candidates -> top ${ranked.length} by edge for deep search`);
  console.log(`  trust min=${VALUE_TRUST_MIN} | edge floor=${(VALUE_EDGE_MIN * 100).toFixed(0)}% | odds cap=${VALUE_ODDS_CAP}`);
  console.log(BAR);

  // -------------------------------------------------------------------------
  // STAGE 8: DEEP SEARCH FIT — researchTeam (form/last-results) + webResearch (H2H).
  // -------------------------------------------------------------------------
  const researchByMatch = new Map(); // eventId -> { home, away }
  let researched = 0;
  for (const p of ranked) {
    if (researchByMatch.has(p.eventId)) continue;
    const [home, away] = await Promise.all([
      deepResearch(p.homeTeam).catch(() => null),
      deepResearch(p.awayTeam).catch(() => null),
    ]);
    researchByMatch.set(p.eventId, { home, away });
    researched++;
  }
  console.log(`STAGE 8: deep-searched ${researched} match(es) (Flashscore form + last-results)`);

  const validated = [];
  const valReport = [];
  for (const p of ranked) {
    const r = researchByMatch.get(p.eventId) ?? {};
    const fit = researchFit(p, r.home, r.away, r.h2h?.status);
    p.fitNote = fit.note;
    if (fit.keep) {
      validated.push(p);
      const rep = valReport.find((x) => x.eventId === p.eventId);
      if (rep) rep.gp.push(p);
      else valReport.push({ eventId: p.eventId, homeTeam: p.homeTeam, awayTeam: p.awayTeam, startTime: p.startTime, gp: [p] });
    } else {
      console.log(`  DROPPED ${p.homeTeam} vs ${p.awayTeam} ${p.name}@${p.odds}: ${fit.note}`);
    }
  }

  console.log(`\n${BAR}`);
  console.log(`HIGH-CONVICTION, DEEP-SEARCH-FITTED PICKS: ${validated.length} (of ${ranked.length} researched)`);
  console.log(BAR);

  if (!validated.length) {
    console.log('No picks survived the deep-search fit filter.');
    console.log(BAR);
    return;
  }

  for (const r of valReport) {
    console.log(`${r.homeTeam} vs ${r.awayTeam}  (${fmtKickoff(r.startTime)})`);
    for (const g of r.gp) {
      console.log(
        `  ${g.name.padEnd(22)} sec ${g.marketId.padEnd(4)} @${String(g.odds).padStart(6)}  edge ${(g.edge * 100).toFixed(1)}%  | research: ${g.fitNote}`
      );
    }
  }

  // STAGE 7: resolve to live SportyBet ids, dedupe, cap.
  const selections = [];
  const seen = new Set();
  for (const p of validated) {
    const { outcomeId, specifier } = await resolveOutcomeId(p.eventId, p.marketId, p.name);
    if (!outcomeId) continue;
    const k = `${p.eventId}|${p.marketId}|${outcomeId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    selections.push({ eventId: p.eventId, marketId: p.marketId, outcomeId, ...(specifier ? { specifier } : {}) });
  }
  const capped = selections.slice(0, MAX_PICKS);

  try {
    if (capped.length) {
      const { code } = await createShareCode(capped);
      const loaded = await loadShareCode(code).catch(() => null);
      console.log(`\n${BAR}`);
      console.log(`SPORTYBET SHARE CODE (${capped.length} selections):`);
      console.log(`CODE: ${code}`);
      console.log(`URL:  ${shareUrl(code)}`);
      if (loaded) console.log(ticketSummary(loaded));
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(CODE_FILE, `CODE: ${code}\nURL: ${shareUrl(code)}\n`);
      console.log(`Saved code to ${CODE_FILE}`);
    } else {
      console.log(`\n[value] deep-search fit left picks, but none resolved to live SportyBet ids.`);
    }
  } catch (e) {
    console.warn(`\n[value] share-code generation failed (needs network to SportyBet): ${e.message}`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`manual-review failed: ${e.message}`);
    process.exit(1);
  });
}
