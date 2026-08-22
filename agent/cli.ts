import fs from 'node:fs';
import path from 'node:path';
import { isSimulated } from '../lib/common.mjs';
import {
  researchTeam,
  findMatchWithTeams,
  captureMatchFeeds,
  aggregatePlayerStats,
  loadFeedCache,
  persistFeedCache,
  closeSharedBrowser,
} from './flashscore.js';
import { webResearch } from './research.js';
import { buildRecommendations } from './analysis.js';
import { loadDb, loadLatest, type LatestMatch } from './db.js';
import type { AgentReport, MatchResearch, Recommendation, TeamInfo } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const OUT_FILE = process.env.AGENT_OUT ?? path.join(DATA_DIR, 'agent-recommendations.json');
const HISTORY_FILE = path.join(DATA_DIR, 'agent-history.json');
const STANDINGS_CACHE_FILE = path.join(DATA_DIR, 'standings-cache.json');

const MARKET_NAMES: Record<string, string> = {
  '1': '1X2',
  '18': 'Over/Under',
  '548': 'Total Goals',
  '41': 'Correct Score',
  '551': 'Multiscores',
};

// Max NEW match feeds captured per run for player stats (last-5 results of
// recommended matches' teams). Feeds persist in data/flashscore-feed-cache.json,
// so steady-state runs mostly hit the cache and the budget rarely binds.
const FEED_BUDGET = Number(process.env.AGENT_FEED_BUDGET ?? 30);

async function mapWithConcurrency<T, R>(items: T[], worker: (item: T) => Promise<R>, limit = 4): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await worker(items[i]);
    }
  });
  await Promise.all(runners);
  return results;
}

function loadStandingsCache(): Map<string, any[]> {
  const cache = new Map<string, any[]>();
  try {
    const raw = JSON.parse(fs.readFileSync(STANDINGS_CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) cache.set(k, v as any[]);
  } catch {
    /* no cache yet */
  }
  return cache;
}

function saveStandingsCache(cache: Map<string, any[]>) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STANDINGS_CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    /* non-fatal */
  }
}

// Append-only audit trail of what the agent recommended each run, so past picks
// can be scored against resolved results later (see backtest.mjs --score-history).
// Kept deliberately separate from odds-db.json (which holds outcomes/results) so
// it never feeds back into the decision as if it were ground truth. Capped to the
// most recent 1000 runs to bound growth.
function appendHistory(report: AgentReport) {
  try {
    const slim = {
      generatedAt: report.generatedAt,
      matches: report.matches
        .map((r) => ({
          eventId: r.match.eventId,
          home: r.match.homeTeam,
          away: r.match.awayTeam,
          startTime: r.match.startTime,
          recommended: r.candidates
            .filter((c) => c.recommended)
            .map((c) => ({
              market: c.market,
              outcome: c.outcome,
              odds: c.odds,
              confidence: c.confidence,
              minOdds: c.recommendedMinOdds,
              edge: c.edge,
            })),
        }))
        .filter((m) => m.recommended.length > 0),
    };
    let arr: any[] = [];
    try {
      const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      if (Array.isArray(raw)) arr = raw;
    } catch {
      /* no history yet */
    }
    arr.push(slim);
    if (arr.length > 1000) arr = arr.slice(arr.length - 1000);
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.warn('[agent] failed to append history (non-fatal):', (e as Error).message);
  }
}

// How far ahead of kickoff matches are deep-researched. The 12h default had
// the agent grinding through the whole day's card every run (the main reason
// runs outgrew the 30-min cron); closer to kickoff is also fresher form.
const RESEARCH_HOURS = Number(process.env.AGENT_RESEARCH_HOURS ?? 6);

async function research(matches: LatestMatch[]): Promise<{ recs: Recommendation[]; researched: number }> {
  const standingsCache = loadStandingsCache();
  const out: MatchResearch[] = [];
  let researched = 0;
  // Timing buckets so the workflow log shows where the run spent its time.
  let msFlashscore = 0;
  let msWeb = 0;

  const worker = async (m: LatestMatch) => {
    if (m.matchStatus && /^H|^FT/i.test(m.matchStatus)) return null; // skip live/finished
    // SRL (Simulated Reality) leagues are virtual — never research or back them.
    if (isSimulated(m.tournament) || isSimulated(m.homeTeam) || isSimulated(m.awayTeam)) return null;
    const started = Date.parse(m.startTime);
    if (Number.isNaN(started)) return null;
    const inWindow = started - Date.now();
    if (inWindow < -3600_000 || inWindow > RESEARCH_HOURS * 3600_000) return null; // 1h ago .. RESEARCH_HOURS ahead

    let home: TeamInfo;
    let away: TeamInfo;
    const t0 = Date.now();
    try {
      [home, away] = await Promise.all([
        researchTeam(m.homeTeam, standingsCache),
        researchTeam(m.awayTeam, standingsCache),
      ]);
    } catch {
      return null;
    }
    msFlashscore += Date.now() - t0;
    researched++;

    // Web research is fetched once and shared by both sides so each team gets
    // a symmetric signal. researchAt lets downstream consumers see how fresh it
    // is; it stays null when no web search was needed (no form/position).
    if (home.form || away.form || home.position || away.position) {
      const nowIso = new Date().toISOString();
      const t1 = Date.now();
      const r = await webResearch(m.homeTeam, m.awayTeam, m.tournament).catch(() => []);
      msWeb += Date.now() - t1;
      home.research = r;
      away.research = r;
      home.researchAt = nowIso;
      away.researchAt = nowIso;
    }

    return {
      eventId: m.eventId,
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      tournament: m.tournament,
      startTime: m.startTime,
      home,
      away,
      officials: null,
    };
  };

  console.log(
    `[agent] researching ${matches.length} scraped match(es) in a ${RESEARCH_HOURS}h kickoff window (concurrency 2)...`
  );
  let done = 0;
  const researchedMatches = await mapWithConcurrency(matches, async (m: LatestMatch) => {
    const r = await worker(m);
    done++;
    if (done % 20 === 0 || done === matches.length) {
      console.log(`[agent] progress ${done}/${matches.length} matches researched (${((done / matches.length) * 100).toFixed(0)}%)`);
    }
    return r;
  }, 2);
  saveStandingsCache(standingsCache);
  for (const r of researchedMatches) {
    if (r) out.push(r);
  }

  console.log(
    `[agent] timing: flashscore (form+standings) ${(msFlashscore / 1000).toFixed(0)}s, web snippets ${(msWeb / 1000).toFixed(0)}s`
  );

  const db = loadDb();
  const recs = buildRecommendations(out, matches, db, (mid) => MARKET_NAMES[mid] ?? mid);
  return { recs, researched };
}

// Enrich recommended matches with player stats (last-5 scorers/assists/cards)
// and the fixture's officials — the data lives in Flashscore's per-match
// df_sui feed, which only a real browser emits. Budgeted: feeds are shared via
// the on-disk cache and new captures are capped at FEED_BUDGET so enrichment
// adds minutes only on first sight of a match, not every run. Data lands in
// agent-recommendations.json for the staking guide; it deliberately does NOT
// move confidence (that signal was reverted before — see analysis.ts history).
async function enrichRecommended(recs: Recommendation[]) {
  const withRecs = recs.filter((r) => r.candidates.some((c) => c.recommended));
  if (!withRecs.length) return;

  const runCache = loadFeedCache();
  const wanted: string[] = [];
  for (const r of withRecs) {
    for (const t of [r.match.home, r.match.away]) {
      wanted.push(...((t.lastResults ?? []) as { eventId?: string }[]).map((x) => x.eventId).filter(Boolean) as string[]);
    }
  }
  const fresh = [...new Set(wanted)].filter((id) => !runCache.has(id)).slice(0, FEED_BUDGET);
  const t0 = Date.now();
  await captureMatchFeeds(fresh, runCache);

  for (const r of withRecs) {
    for (const t of [r.match.home, r.match.away]) {
      const stats = aggregatePlayerStats(runCache, (t.lastResults ?? []) as never);
      t.scorers = stats.scorers;
      t.assists = stats.assists;
      t.cards = stats.cards;
    }
    // Officials (referee/venue) come from today's fixture feed — one extra
    // page per recommended match, cached like the rest.
    try {
      const { home, away } = r.match;
      if (home.flashscoreId && away.flashscoreId) {
        const fm = await findMatchWithTeams(
          { id: home.flashscoreId, url: home.flashscoreUrl ?? '', name: home.name },
          { id: away.flashscoreId, url: away.flashscoreUrl ?? '', name: away.name },
          Date.parse(r.match.startTime),
          { requireFinished: false }
        );
        if (fm.status === 'upcoming' && fm.flashscoreId) {
          await captureMatchFeeds([fm.flashscoreId], runCache);
          const feed = runCache.get(fm.flashscoreId);
          if (feed && (feed.officials.referee || feed.officials.venue)) {
            r.match.officials = feed.officials;
          }
        }
      }
    } catch {
      /* officials are best-effort */
    }
  }

  persistFeedCache(runCache);
  console.log(
    `[agent] enrichment: ${withRecs.length} recommended match(es), ${fresh.length} new feed(s) captured in ${((Date.now() - t0) / 1000).toFixed(0)}s`
  );
}

async function main() {
  const latest = loadLatest();
  const report: AgentReport = {
    generatedAt: new Date().toISOString(),
    source: 'flashscore + web + odds-db',
    totalMatches: latest.matches.length,
    researched: 0,
    recommendedBets: 0,
    matches: [],
  };

  report.totalMatches = latest.matches.length;
  try {
    const { recs, researched } = await research(latest.matches);
    report.researched = researched;
    report.matches = recs;

    await enrichRecommended(recs);

    for (const r of recs) {
      const rec = r.candidates.filter((c) => c.recommended);
      if (rec.length) {
        report.recommendedBets += rec.length;
        console.log(`[agent] ${r.match.homeTeam} vs ${r.match.awayTeam} (${r.match.tournament})`);
        for (const c of rec) {
          console.log(
            `  RECOMMEND ${c.market} ${c.outcome} @${c.odds} (min ${c.recommendedMinOdds}) conf ${(c.confidence * 100).toFixed(0)}% — ${c.reason}`
          );
        }
      }
    }
  } finally {
    await closeSharedBrowser();
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  appendHistory(report);
  console.log(`[agent] wrote ${OUT_FILE} (${report.recommendedBets} recommended bets across ${report.matches.length} researched matches)`);
}

main().catch((e) => {
  console.error('[agent] failed:', e);
  process.exit(1);
});