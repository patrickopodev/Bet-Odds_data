import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { UA, decodeFeedBlock, extractFeedEvents, normTeam, resolveTeam } from '../lib/common.mjs';
import type { PlayerStat, TeamInfo } from './types.js';

export { resolveTeam };

export interface FsTeam {
  id: string;
  url: string;
  name: string;
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

export interface LeagueRef {
  id: string;
  url: string;
  name: string;
}

export interface TeamForm {
  form: string;
  lastResults: { opp: string; score: string; result: 'W' | 'D' | 'L'; eventId?: string; side?: 'home' | 'away' }[];
  league: LeagueRef | null;
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
  const results = extractFeedEvents(html, 'summary-results');
  const fixtures = extractFeedEvents(html, 'summary-fixtures');

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
    lastResults.push({ opp, score: `${myGoals}-${oppGoals}`, result, eventId: e.AA, side: my ? 'home' : 'away' });
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

// ---------------------------------------------------------------------------
// Per-match "summary events" feed (df_sui_1_<id>): goal scorers, assists,
// cards and substitutions for one finished match, plus the match-officials
// block (referee, venue, attendance, capacity). This is the data source for
// the last-5 scorers/assists per team and the referee of today's fixture.
// Like the standings feed it is only emitted by the browser, so the same
// Playwright response-capture pattern is used.
// ---------------------------------------------------------------------------

export interface FsFeedEvent {
  minute: string;
  type: 'goal' | 'assist' | 'card' | 'sub' | 'penalty' | 'other';
  player: string;
  side: 'home' | 'away';
  detail: string;
}

export interface FsFeedOfficials {
  referee: string | null;
  venue: string | null;
  town: string | null;
  capacity: string | null;
  attendance: string | null;
}

export interface FsMatchFeed {
  officials: FsFeedOfficials;
  events: FsFeedEvent[];
}

// Parse the df_sui match feed into officials + player events. The feed mixes
// event blocks (goal/card/sub) and a trailing officials block of repeated
// MIT/MIV pairs (e.g. MIT÷REF¬MIV÷Scott C. for referee, MIT÷VEN¬MIV÷Tynecastle
// Park for venue). The MIT/MIV pairs must be consumed as an ordered stream
// (decodeFeedBlock would collapse them to the last pair). Event blocks are
// walked field-by-field too: a goal and its assist share one block, so each
// `IK÷<type>` marker completes the event whose fields preceded it.
export function parseMatchFeed(text: string): FsMatchFeed {
  const officials: FsFeedOfficials = { referee: null, venue: null, town: null, capacity: null, attendance: null };
  const events: FsFeedEvent[] = [];
  for (const block of text.split('~')) {
    const parts = block.split('¬');
    // Officials block: ordered MIT (label) / MIV (value) pairs.
    if (block.includes('MIT÷')) {
      let mit: string | null = null;
      for (const p of parts) {
        const x = p.indexOf('÷');
        if (x <= 0) continue;
        const k = p.slice(0, x);
        const v = p.slice(x + 1);
        if (k === 'MIT') mit = v;
        else if (k === 'MIV' && mit) {
          switch (mit) {
            case 'REF':
              officials.referee = v;
              break;
            case 'VEN':
              officials.venue = v;
              break;
            case 'TWN':
              officials.town = v;
              break;
            case 'CAP':
              officials.capacity = v;
              break;
            case 'ATT':
              officials.attendance = v;
              break;
          }
          mit = null;
        }
      }
      continue;
    }
    // Event block: walk fields in order; `IK÷<type>` completes the current
    // event (its fields were accumulated before it, e.g. IF÷name, IA÷side).
    // IA/IB sit at the block level and apply to every sub-event in the block
    // (a goal and its assist share one block), so carry them forward.
    let cur: Record<string, string> = {};
    let blockSide: 'home' | 'away' = 'home';
    let blockMinute = '';
    for (const p of parts) {
      const x = p.indexOf('÷');
      if (x <= 0) continue;
      const k = p.slice(0, x);
      const v = p.slice(x + 1);
      if (k === 'IK') {
        cur.ik = v;
        if (cur.ik && cur.IF) {
          const side = cur.IA === '2' ? 'away' : blockSide;
          const minute = cur.IB || blockMinute;
          const ik = cur.ik.toLowerCase();
          const type: FsFeedEvent['type'] = /goal/.test(ik)
            ? 'goal'
            : /assist/.test(ik)
              ? 'assist'
              : /card/.test(ik)
                ? 'card'
                : /substitution/.test(ik)
                  ? 'sub'
                  : /penalty/.test(ik)
                    ? 'penalty'
                    : 'other';
          events.push({ minute, type, player: cur.IF, side, detail: cur.ik });
        }
        cur = {};
      } else {
        if (k === 'IA') blockSide = v === '2' ? 'away' : 'home';
        if (k === 'IB') blockMinute = v;
        cur[k] = v;
      }
    }
  }
  return { officials, events };
}

const FEED_CACHE_FILE = path.join(process.env.DATA_DIR ?? 'data', 'flashscore-feed-cache.json');

// Persist captured feeds keyed by event id so a 30-minute workflow does not
// re-fetch the same finished matches' feeds every run. Refreshed on write.
export function loadFeedCache(): Map<string, FsMatchFeed> {
  const cache = new Map<string, FsMatchFeed>();
  try {
    const raw = JSON.parse(fs.readFileSync(FEED_CACHE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) cache.set(k, v as FsMatchFeed);
  } catch {
    /* no cache yet */
  }
  return cache;
}

function saveFeedCache(cache: Map<string, FsMatchFeed>) {
  try {
    fs.mkdirSync(path.dirname(FEED_CACHE_FILE), { recursive: true });
    fs.writeFileSync(FEED_CACHE_FILE, JSON.stringify(Object.fromEntries(cache)));
  } catch {
    /* non-fatal */
  }
}

// Capture the df_sui summary feed for one or more match ids in a single
// browser session. `onDone` lets the caller pull per-id feeds out of the run
// cache as they arrive (matches can repeat across teams/matches).
export async function captureMatchFeeds(
  eventIds: string[],
  runCache: Map<string, FsMatchFeed>,
  onDone?: (eventId: string) => void
): Promise<Map<string, FsMatchFeed>> {
  const ids = [...new Set(eventIds)].filter((id) => !runCache.has(id));
  if (ids.length === 0) return runCache;
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });
  try {
    for (const id of ids) {
      const page = await browser.newPage({ userAgent: UA });
      let feed = '';
      page.on('response', async (res) => {
        const u = res.url();
        if (new RegExp(`/feed/df_sui_1_${id}`).test(u)) {
          try {
            feed = await res.text();
          } catch {
            /* ignore */
          }
        }
      });
      try {
        await page.goto(`https://www.flashscore.com/match/${id}/`, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
        await page.waitForTimeout(8000);
        if (!feed) {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
          await page.waitForTimeout(8000);
        }
        if (feed) {
          runCache.set(id, parseMatchFeed(feed));
          onDone?.(id);
        }
      } catch {
        /* skip unresponsive match pages */
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await browser.close();
  }
  return runCache;
}

export interface TeamPlayerStats {
  scorers: PlayerStat[];
  assists: PlayerStat[];
  cards: PlayerStat[];
}

// Capture the last-5 finished matches' feeds for a team (from researchTeam's
// lastResults, which now carry eventId+side) and aggregate its scorer/assist/
// card stats. Returns null when nothing could be captured.
export async function fetchTeamPlayerStats(
  team: TeamInfo,
  runCache: Map<string, FsMatchFeed>
): Promise<TeamPlayerStats | null> {
  const ids = ((team.lastResults ?? []) as TeamForm['lastResults'])
    .map((r) => r.eventId)
    .filter((id): id is string => Boolean(id));
  if (ids.length === 0) return null;
  await captureMatchFeeds(ids, runCache);
  const stats = aggregatePlayerStats(runCache, team.lastResults as TeamForm['lastResults']);
  if (stats.scorers.length === 0 && stats.assists.length === 0 && stats.cards.length === 0) return null;
  return stats;
}

// Fetch the match-officials block (referee, venue, attendance, capacity) for a
// fixture, resolved via findMatchWithTeams then the df_sui feed of that match.
export async function fetchMatchOfficials(
  home: FsTeam,
  away: FsTeam,
  kickoffMs: number,
  runCache: Map<string, FsMatchFeed>
): Promise<FsFeedOfficials | null> {
  try {
    const fm = await findMatchWithTeams(home, away, kickoffMs, { requireFinished: false });
    if (fm.status !== 'upcoming' || !fm.flashscoreId) return null;
    await captureMatchFeeds([fm.flashscoreId], runCache);
    const feed = runCache.get(fm.flashscoreId);
    if (!feed) return null;
    const { referee, venue, town, capacity, attendance } = feed.officials;
    if (!referee && !venue && !attendance) return null;
    return { referee, venue, town, capacity, attendance };
  } catch {
    return null;
  }
}

// Save the run feed cache to disk (idempotent; the workflow runs every 30 min
// and finished matches' feeds barely change, so reusing them is a big win).
export function persistFeedCache(runCache: Map<string, FsMatchFeed>) {
  saveFeedCache(runCache);
}

// Aggregate a team's goal scorers / assist providers / card offenders across
// the last-5 finished matches (by event id). Attribution is side-aware: each
// feed event says home/away, and a team only takes credit for its own side in
// that finished match (captured at fetchTeamForm time as lastResults[].side).
export function aggregatePlayerStats(
  feeds: Map<string, FsMatchFeed>,
  lastResults: TeamForm['lastResults']
): TeamPlayerStats {
  const goals = new Map<string, number>();
  const assists = new Map<string, number>();
  const cards = new Map<string, number>();
  const bump = (m: Map<string, number>, p: string) => m.set(p, (m.get(p) ?? 0) + 1);
  for (const r of lastResults) {
    if (!r.eventId) continue;
    const feed = feeds.get(r.eventId);
    if (!feed) continue;
    for (const ev of feed.events) {
      if (ev.side !== r.side) continue;
      if (ev.type === 'goal') bump(goals, ev.player);
      else if (ev.type === 'assist') bump(assists, ev.player);
      else if (ev.type === 'card') bump(cards, ev.player);
    }
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([player, count]) => ({ player, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  return { scorers: top(goals), assists: top(assists), cards: top(cards) };
}

// Deep research for one team: form + league position (via standings) + web
// research snippets.
export async function researchTeam(
  name: string,
  standingsCache: Map<string, StandingsRow[]>
): Promise<TeamInfo> {
  const info: TeamInfo = { name, flashscoreId: null, flashscoreUrl: null, position: null, played: null, points: null, form: '', formScore: 0, lastResults: [], research: [], researchAt: null, injuries: [], keyPlayers: [], scorers: [], assists: [], cards: [] };
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
  return findMatchWithTeams(home, away, kickoffMs, opts);
}

// Same lookup with both teams already resolved (spares the search-API calls
// when the caller already ran researchTeam on both sides).
export async function findMatchWithTeams(
  home: FsTeam,
  away: FsTeam,
  kickoffMs: number,
  opts: { requireFinished: boolean }
): Promise<MatchFindResult> {
  const html = await fetchText(`https://www.flashscore.com/team/${home.url}/${home.id}/`, {
    Accept: 'text/html,application/xhtml+xml',
    Referer: 'https://www.flashscore.com/',
  });
  const kickoff = Math.floor(kickoffMs / 1000);
  const homeToken = normTeam(home.name);
  const awayToken = normTeam(away.name);

  const isPair = (e: Record<string, string>): boolean => {
    const ad = Number(e.AD);
    if (!ad || Math.abs(ad - kickoff) > 3600) return false;
    if (String(e.PX) === String(home.id) && String(e.PY) === String(away.id)) return true;
    return normTeam(e.CX).includes(homeToken) && normTeam(e.AF).includes(awayToken);
  };

  if (opts.requireFinished) {
    const finished = extractFeedEvents(html, 'summary-results').filter(
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

  const upcoming = extractFeedEvents(html, 'summary-fixtures').filter(isPair);
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