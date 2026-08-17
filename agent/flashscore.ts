import { chromium } from 'playwright-core';
import { normTeam, queryTeam, decodeFeedBlock } from '../lib/common.mjs';
import type { TeamInfo } from './types.js';

const UA =
  process.env.USER_AGENT ??
  'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

export interface FsTeam {
  id: string;
  url: string;
  name: string;
}

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

// Resolve a team to its Flashscore id + url via the Livesport search API.
export async function resolveTeam(name: string): Promise<FsTeam | null> {
  const q = encodeURIComponent(queryTeam(name));
  const data = await fetchJson(`https://s.livesport.services/api/v2/search?q=${q}&sport=football&lang=en`, {
    Accept: 'application/json',
  });
  const teams: any[] = (data ?? []).filter(
    (r: any) => r.type?.name === 'Team' && r.sport?.name === 'Soccer'
  );
  const target = normTeam(name);
  const exact = teams.find((t) => {
    const n = normTeam(t.name);
    return n === target || (n.length >= 4 && target.length >= 4 && (n.includes(target) || target.includes(n)));
  });
  return exact ? { id: exact.id, url: exact.url, name: exact.name } : null;
}

export interface LeagueRef {
  id: string;
  url: string;
  name: string;
}

export interface TeamForm {
  form: string;
  lastResults: { opp: string; score: string; result: 'W' | 'D' | 'L' }[];
  league: LeagueRef | null;
}

function extractFeed(html: string, feedName: string): Record<string, string>[] {
  const marker = `cjs.initialFeeds["${feedName}"]`;
  const i = html.indexOf(marker);
  if (i === -1) return [];
  const start = html.indexOf('data: `', i);
  if (start === -1) return [];
  const end = html.indexOf('`', start + 8);
  if (end === -1) return [];
  const feed = html.slice(start + 7, end);
  const events: Record<string, string>[] = [];
  for (const block of feed.split('~')) {
    const fields = decodeFeedBlock(block);
    if (fields.AA) events.push(fields);
  }
  return events;
}

// Decode every block in a feed, including tournament-header blocks that carry
// the league name/id/url but no event id.
function extractAllBlocks(html: string, feedName: string): Record<string, string>[] {
  const marker = `cjs.initialFeeds["${feedName}"]`;
  const i = html.indexOf(marker);
  if (i === -1) return [];
  const start = html.indexOf('data: `', i);
  if (start === -1) return [];
  const end = html.indexOf('`', start + 8);
  if (end === -1) return [];
  const feed = html.slice(start + 7, end);
  const blocks: Record<string, string>[] = [];
  for (const block of feed.split('~')) {
    const fields = decodeFeedBlock(block);
    if (Object.keys(fields).length) blocks.push(fields);
  }
  return blocks;
}

// Fetch a team page and derive: recent form (last 5 finished results) and the
// team's primary (most common) league.
export async function fetchTeamForm(team: FsTeam): Promise<TeamForm> {
  const html = await fetchText(`https://www.flashscore.com/team/${team.url}/${team.id}/`, {
    Accept: 'text/html,application/xhtml+xml',
    Referer: 'https://www.flashscore.com/',
  });
  const results = extractFeed(html, 'summary-results');
  const fixtures = extractFeed(html, 'summary-fixtures');

  // Primary league = most frequent league NAME across both feeds. Tournament
  // ids (ZC) can differ between the results and fixtures feeds for the same
  // league, so count by name and prefer the fixtures feed's id/url (current
  // competition).
  const leagueCounts = new Map<string, { id: string; url: string; name: string; count: number }>();
  const addBlocks = (blocks: Record<string, string>[], preferFixtures: boolean) => {
    for (const block of blocks) {
      if (block.ZA && block.ZC) {
        const key = block.ZA;
        const cur = leagueCounts.get(key) ?? { id: block.ZC, url: block.ZL ?? '', name: block.ZA, count: 0 };
        cur.count++;
        if (preferFixtures || !cur.id) {
          cur.id = block.ZC;
          cur.url = block.ZL ?? cur.url;
        }
        leagueCounts.set(key, cur);
      }
    }
  };
  addBlocks(extractAllBlocks(html, 'summary-results'), false);
  addBlocks(extractAllBlocks(html, 'summary-fixtures'), true);
  let league: LeagueRef | null = null;
  let bestCount = 0;
  for (const l of leagueCounts.values()) {
    if (l.count > bestCount && !/cup/i.test(l.name)) {
      bestCount = l.count;
      league = { id: l.id, url: l.url, name: l.name };
    }
  }

  const finished = results
    .filter((e) => String(e.AB) === '3' && e.AG && e.AH && (e.PX === team.id || e.PY === team.id))
    .sort((a, b) => Number(b.AD) - Number(a.AD))
    .slice(0, 5);

  const lastResults: TeamForm['lastResults'] = [];
  for (const e of finished) {
    const my = e.PX === team.id;
    const myGoals = Number(my ? e.AG : e.AH);
    const oppGoals = Number(my ? e.AH : e.AG);
    const opp = my ? e.AF : e.CX;
    const result = myGoals > oppGoals ? 'W' : myGoals === oppGoals ? 'D' : 'L';
    lastResults.push({ opp, score: `${myGoals}-${oppGoals}`, result });
  }
  const form = lastResults.map((r) => r.result).join('');
  return { form, lastResults, league };
}

export interface StandingsRow {
  teamId: string;
  teamName: string;
  rank: number;
}

// Fetch a league's standings table via Playwright and return every row.
export async function fetchStandings(leagueUrl: string): Promise<StandingsRow[]> {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    const page = await browser.newPage({ userAgent: UA });
    let table = '';
    page.on('response', async (res) => {
      const u = res.url();
      if (/\/feed\/to_.+_1/.test(u)) {
        try {
          table = await res.text();
        } catch {
          /* ignore */
        }
      }
    });
    await page.goto(`https://www.flashscore.com${leagueUrl}standings/`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(10000);
    if (!table) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(10000);
    }
    const rows: StandingsRow[] = [];
    for (const b of table.split('~')) {
      const f = decodeFeedBlock(b);
      if (f.TR && f.TN && f.TI) {
        rows.push({ teamId: f.TI, teamName: f.TN, rank: Number(f.TR) });
      }
    }
    return rows;
  } finally {
    await browser.close();
  }
}

// Deep research for one team: form + league position (via standings) + web
// research snippets.
export async function researchTeam(
  name: string,
  standingsCache: Map<string, StandingsRow[]>
): Promise<TeamInfo> {
  const info: TeamInfo = { name, flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null, form: '', formScore: 0, lastResults: [], venue: null, research: [] };
  try {
    const team = await resolveTeam(name);
    if (!team) {
      info.error = 'team not found on Flashscore';
      return info;
    }
    info.flashscoreId = team.id;
    info.flashscoreUrl = team.url;

    const tf = await fetchTeamForm(team);
    info.form = tf.form;
    info.lastResults = tf.lastResults;
    info.formScore = tf.lastResults.reduce((n, r) => n + (r.result === 'W' ? 3 : r.result === 'D' ? 1 : 0), 0);

    if (tf.league && tf.league.url && !/friendly/i.test(tf.league.name)) {
      let rows = standingsCache.get(tf.league.url);
      if (!rows) {
        try {
          rows = await fetchStandings(tf.league.url);
        } catch {
          rows = [];
        }
        standingsCache.set(tf.league.url, rows);
      }
      const mine = rows.find((r) => r.teamId === team.id);
      if (mine) {
        info.position = mine.rank;
        info.played = rows.length; // fallback: league size
      }
      info.league = tf.league;
    }
  } catch (e) {
    info.error = (e as Error).message;
  }
  return info;
}

export interface MatchFindResult {
  status: 'finished' | 'upcoming' | 'notfound';
  score?: string;
  flashscoreId?: string;
  startTime?: string;
}

// Locate a fixture on Flashscore by resolving both teams and matching the
// fixture's team ids + kickoff. `requireFinished` only accepts the finished
// results feed (AB=3, has score, no interruption note); otherwise it looks for
// the scheduled fixture in the fixtures feed.
export async function findMatch(
  homeName: string,
  awayName: string,
  kickoffMs: number,
  opts: { requireFinished: boolean }
): Promise<MatchFindResult> {
  const [home, away] = await Promise.all([resolveTeam(homeName), resolveTeam(awayName)]);
  if (!home || !away) return { status: 'notfound' };

  const html = await fetchText(`https://www.flashscore.com/team/${home.url}/${home.id}/`, {
    Accept: 'text/html,application/xhtml+xml',
    Referer: 'https://www.flashscore.com/',
  });
  const kickoff = Math.floor(kickoffMs / 1000);
  const homeToken = normTeam(homeName);
  const awayToken = normTeam(awayName);

  const isPair = (e: Record<string, string>): boolean => {
    const ad = Number(e.AD);
    if (!ad || Math.abs(ad - kickoff) > 3600) return false;
    if (String(e.PX) === String(home.id) && String(e.PY) === String(away.id)) return true;
    return normTeam(e.CX).includes(homeToken) && normTeam(e.AF).includes(awayToken);
  };

  if (opts.requireFinished) {
    const finished = extractFeed(html, 'summary-results').filter(
      (e) =>
        String(e.AB) === '3' &&
        e.AG &&
        e.AH &&
        !/interrupted|abandon|postponed|cancel(led)?/i.test(e.AM ?? '') &&
        isPair(e)
    );
    const m = finished.sort((a, b) => Number(b.AD) - Number(a.AD))[0];
    if (m) {
      return {
        status: 'finished',
        score: `${m.AG}:${m.AH}`,
        flashscoreId: m.AA,
        startTime: new Date(Number(m.AD) * 1000).toISOString(),
      };
    }
    return { status: 'notfound' };
  }

  const upcoming = extractFeed(html, 'summary-fixtures').filter(isPair);
  const m = upcoming.sort(
    (a, b) => Math.abs(Number(a.AD) - kickoff) - Math.abs(Number(b.AD) - kickoff)
  )[0];
  if (m) {
    return {
      status: 'upcoming',
      flashscoreId: m.AA,
      startTime: new Date(Number(m.AD) * 1000).toISOString(),
    };
  }
  return { status: 'notfound' };
}