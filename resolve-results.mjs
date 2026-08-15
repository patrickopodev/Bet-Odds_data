import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DB_FILE, decodeFeedBlock, fetchJson, fetchText, loadDb, mapWithConcurrency, normTeam, queryTeam, saveDb } from './lib/common.mjs';

const CONCURRENCY = 3;

// Allow a small tolerance when matching a scraped kickoff (unix seconds) to the
// Flashscore feed's AD field, in case the fixture time shifted slightly.
const KICKOFF_TOLERANCE_SECONDS = 60 * 60;

// Pull the embedded feed string (e.g. cjs.initialFeeds["summary-results"]) out of
// a Flashscore team page HTML. Returns decoded events as field maps.
export function extractFeedEvents(html, feedName) {
  const marker = `cjs.initialFeeds["${feedName}"]`;
  const i = html.indexOf(marker);
  if (i === -1) return [];
  const start = html.indexOf('data: `', i);
  if (start === -1) return [];
  const end = html.indexOf('`', start + 8);
  if (end === -1) return [];
  const feed = html.slice(start + 7, end);
  const events = [];
  for (const block of feed.split('~')) {
    const fields = decodeFeedBlock(block);
    if (fields.AA) events.push(fields);
  }
  return events;
}

// Resolve a team's Flashscore page URL + id via the Livesport search API.
// Returns { id, url, name } or null.
async function resolveTeam(name) {
  const q = encodeURIComponent(queryTeam(name));
  const data = await fetchJson(`https://s.livesport.services/api/v2/search?q=${q}&sport=football&lang=en`, {
    headers: { 'Accept': 'application/json' },
  });
  const teams = (data ?? []).filter(
    (r) => r.type?.name === 'Team' && r.sport?.name === 'Soccer'
  );
  const target = normTeam(name);
  // Require a core-name match: guessing `teams[0]` risks attaching the wrong
  // fixture's final score. The length>=4 guard avoids trivial short matches.
  // Return null so the event is skipped (and stays unsettled) if no match.
  const exact = teams.find((t) => {
    const n = normTeam(t.name);
    return (
      n === target ||
      (n.length >= 4 && target.length >= 4 && (n.includes(target) || target.includes(n)))
    );
  });
  return exact ?? null;
}

// Fetch a team's fixtures + results feeds and return all events, tagged with
// the feed they came from. Only `summary-results` holds genuinely finished
// (FT) fixtures; the fixtures/upcoming feed can show interrupted or abandoned
// matches with AB=3 and a note (e.g. "Interrupted due to rain.") that must NOT
// be settled as a final score.
async function getTeamEvents(team) {
  const base = `https://www.flashscore.com/team/${team.url}/${team.id}`;
  let all = [];
  for (const [pathname, feedName, isResults] of [
    ['results', 'summary-results', true],
    ['fixtures', 'summary-fixtures', false],
  ]) {
    try {
      const html = await fetchText(`${base}/${pathname}/`, {
        headers: {
          'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Referer': 'https://www.flashscore.com/',
        },
      });
      const events = extractFeedEvents(html, feedName);
      for (const e of events) e._isResults = isResults;
      all = all.concat(events);
    } catch {
      // skip this feed; the other one may still have the match
    }
  }
  return all;
}

async function run() {
  const db = await loadDb();
  const events = Object.values(db.events);
  const pending = events.filter((ev) => !ev.finalScore);
  console.log(`Resolving ${pending.length} unsettled event(s) via Flashscore...`);

  const teamCache = new Map();
  const settled = await mapWithConcurrency(pending, async (ev) => {
    if (!ev.homeTeam || !ev.awayTeam || !ev.startTime) {
      return { eventId: ev.eventId, skipped: 'missing team/start' };
    }
    const homeName = ev.homeTeam;
    const awayName = ev.awayTeam;

    const cachedResolve = async (name) => {
      let t = teamCache.get(name);
      if (!t) {
        t = await resolveTeam(name);
        teamCache.set(name, t);
      }
      return t;
    };
    // Resolve BOTH teams: their Flashscore ids (feed fields PX/PY) confirm the
    // fixture exactly, instead of guessing from name tokens alone.
    const [home, away] = await Promise.all([cachedResolve(homeName), cachedResolve(awayName)]);
    if (!home) return { eventId: ev.eventId, skipped: `home team not found (${homeName})` };
    if (!away) return { eventId: ev.eventId, skipped: `away team not found (${awayName})` };

    const events = await getTeamEvents(home);
    // Kickoff we are looking for, in unix seconds.
    const kickoff = Math.floor(new Date(ev.startTime).getTime() / 1000);

    const norm = (s) => normTeam(s);
    const homeToken = norm(homeName);
    const awayToken = norm(awayName);

    // A genuinely finished fixture must come from the results feed (AB=3) with a
    // score, a kickoff (AD) near our startTime, and no interruption/abandonment
    // note. Interrupted matches can also show AB=3 but belong in fixtures.
    const isCandidate = (e) => {
      if (!e._isResults) return false;
      if (String(e.AB) !== '3' || !e.AG || !e.AH) return false;
      const ad = Number(e.AD);
      if (ad === 0 || Math.abs(ad - kickoff) > KICKOFF_TOLERANCE_SECONDS) return false;
      if (/interrupted|abandon|postponed|cancel(led)?/i.test(e.AM ?? '')) return false;
      return true;
    };

    let match = null;
    // Prefer the exact team-id pairing: our home id on the left, away id on the right.
    for (const e of events) {
      if (!isCandidate(e)) continue;
      if (String(e.PX) === String(home.id) && String(e.PY) === String(away.id)) {
        match = e;
        break;
      }
    }
    // Fallback: confirm by team names on the expected sides.
    if (!match) {
      for (const e of events) {
        if (!isCandidate(e)) continue;
        if (norm(e.CX).includes(homeToken) && norm(e.AF).includes(awayToken)) {
          match = e;
          break;
        }
      }
    }

    if (!match) {
      return { eventId: ev.eventId, skipped: `no finished Flashscore match near ${ev.startTime}` };
    }

    ev.finalScore = `${match.AG}:${match.AH}`;
    ev.settledAt = new Date().toISOString();
    ev.finalStatus = 'FT';
    ev.flashscoreId = match.AA;
    ev.flashscoreStart = match.AD;
    return {
      eventId: ev.eventId,
      score: ev.finalScore,
      home: ev.homeTeam,
      away: ev.awayTeam,
      flashscoreId: match.AA,
      verifiedStart: new Date(Number(match.AD) * 1000).toISOString(),
      expectedStart: ev.startTime,
    };
  }, CONCURRENCY);

  const ok = settled.filter((r) => r.score);
  const skipped = settled.filter((r) => r.skipped);
  for (const r of ok) {
    console.log(`  ${r.home} ${r.score} ${r.away} (${r.flashscoreId}) start ${r.verifiedStart} == expected ${r.expectedStart}`);
  }
  if (skipped.length) {
    const tally = {};
    for (const r of skipped) tally[r.skipped] = (tally[r.skipped] || 0) + 1;
    for (const [k, v] of Object.entries(tally)) console.log(`  skipped ${v}: ${k}`);
  }

  if (ok.length) await saveDb(db);
  console.log(`Settled ${ok.length} event(s). DB: ${DB_FILE}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  run().catch((e) => {
    console.error(`resolve-results failed: ${e.message}`);
    process.exit(1);
  });
}
