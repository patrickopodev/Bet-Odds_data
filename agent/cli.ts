import fs from 'node:fs';
import path from 'node:path';
import { researchTeam } from './flashscore.js';
import { webResearch } from './research.js';
import { buildRecommendations } from './analysis.js';
import { loadDb, loadLatest, type LatestMatch } from './db.js';
import type { AgentReport, MatchResearch, Recommendation, TeamInfo } from './types.js';

const DATA_DIR = process.env.DATA_DIR ?? 'data';
const OUT_FILE = process.env.AGENT_OUT ?? path.join(DATA_DIR, 'agent-recommendations.json');
const STANDINGS_CACHE_FILE = path.join(DATA_DIR, 'standings-cache.json');

const MARKET_NAMES: Record<string, string> = {
  '1': '1X2',
  '18': 'Over/Under',
  '548': 'Total Goals',
  '41': 'Correct Score',
};

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

async function research(matches: LatestMatch[]): Promise<{ recs: Recommendation[]; researched: number }> {
  const standingsCache = loadStandingsCache();
  const out: MatchResearch[] = [];
  let researched = 0;

  const worker = async (m: LatestMatch) => {
    if (m.matchStatus && /^H|^FT/i.test(m.matchStatus)) return null; // skip live/finished
    const started = Date.parse(m.startTime);
    if (Number.isNaN(started)) return null;
    const inWindow = started - Date.now();
    if (inWindow < -3600_000 || inWindow > 12 * 3600_000) return null; // 1h ago .. 12h ahead

    let home: TeamInfo;
    let away: TeamInfo;
    try {
      [home, away] = await Promise.all([
        researchTeam(m.homeTeam, standingsCache),
        researchTeam(m.awayTeam, standingsCache),
      ]);
    } catch {
      return null;
    }
    researched++;

    // Web research is fetched once and shared by both sides so each team gets
    // a symmetric signal. researchAt lets downstream consumers see how fresh it
    // is; it stays null when no web search was needed (no form/position).
    if (home.form || away.form || home.position || away.position) {
      const nowIso = new Date().toISOString();
      const r = await webResearch(m.homeTeam, m.awayTeam, m.tournament).catch(() => []);
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

  const researchedMatches = await mapWithConcurrency(matches, worker, 2);
  saveStandingsCache(standingsCache);
  for (const r of researchedMatches) {
    if (r) out.push(r);
  }

  const db = loadDb();
  const recs = buildRecommendations(out, matches, db, (mid) => MARKET_NAMES[mid] ?? mid);
  return { recs, researched };
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
  const { recs, researched } = await research(latest.matches);
  report.researched = researched;
  report.matches = recs;

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

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  console.log(`[agent] wrote ${OUT_FILE} (${report.recommendedBets} recommended bets across ${report.matches.length} researched matches)`);
}

main().catch((e) => {
  console.error('[agent] failed:', e);
  process.exit(1);
});