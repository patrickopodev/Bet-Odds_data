// ---------------------------------------------------------------------------
// STRUCTURED H2H COLLECTION (research layer, Suggestion 5 of RESEARCH-PLAN.md).
//
// Produces a structured head-to-head meetings file the ablation harness can
// consume via `node engine/backtest-harness.mjs --features=h2h.json`. The
// harness's h2hPasses gate (engine/features.mjs:extractH2HFeatures) already
// exists and is unit-tested, but it could never be exercised because no H2H feed
// was collected — every run reported NO DATA. This module closes that gap.
//
// Source of truth here is the odds-db itself: every settled match IS a meeting
// between its two teams, so we can derive structured H2H from history we already
// have (history lives only in the odds-data artifact — never committed to main).
// A Flashscore H2H endpoint could later replace/augment this; the file shape is
// identical (engine/features.mjs:Meeting).
//
// File shape (data/h2h.json): { meetings: Meeting[] }
//   Meeting = { date, home, away, homeScore, awayScore, competition? }
// ---------------------------------------------------------------------------
import fs from 'node:fs';

// One structured meeting from a settled odds-db event, or null if unusable.
export function meetingFromEvent(ev) {
  if (!ev.finalScore || !ev.homeTeam || !ev.awayTeam) return null;
  const [hg, ag] = String(ev.finalScore).split(':').map(Number);
  if (Number.isNaN(hg) || Number.isNaN(ag)) return null;
  return {
    date: ev.startTime,
    home: ev.homeTeam,
    away: ev.awayTeam,
    homeScore: hg,
    awayScore: ag,
    competition: ev.tournament ?? null,
  };
}

export function loadH2H(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { meetings: Array.isArray(raw.meetings) ? raw.meetings : [] };
  } catch {
    return { meetings: [] };
  }
}

export function saveH2H(data, file) {
  fs.mkdirSync(file.replace(/[^/]*$/, ''), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return data;
}

// Build the structured H2H store from every settled event in the odds-db,
// chronological (oldest first), de-duplicated on (date, home, away).
export function buildH2HFromDb(db) {
  const seen = new Set();
  const meetings = [];
  for (const ev of Object.values(db.events ?? {})
    .filter((e) => e.finalScore && e.homeTeam && e.awayTeam)
    .sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))) {
    const m = meetingFromEvent(ev);
    if (!m) continue;
    const key = `${m.date}|${m.home}|${m.away}`;
    if (seen.has(key)) continue;
    seen.add(key);
    meetings.push(m);
  }
  return { meetings };
}
