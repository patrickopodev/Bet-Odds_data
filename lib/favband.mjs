import { parseScore, evaluateOutcome } from './common.mjs';

// ---------------------------------------------------------------------------
// SHARED FAV_BAND 1X2 SELECTOR.
//
// Used by BOTH the paper track (train-model-v5b.mjs --paper) and the manual
// betslip generator (manual-slip.mjs). Centralizing it guarantees the two
// tracks select the exact same set of picks — the whole point of the manual
// track is to test the SAME strategy the paper track validates.
//
// Source of truth is odds-db.json. Per event, the 1X2 side with the LOWEST
// last odds is the favorite; a pick qualifies when that favorite's last odds
// fall in [lo, hi). Only 1X2 is ever considered, so O/U, correct-score,
// totals, etc. can never be selected — by construction.
// ---------------------------------------------------------------------------

export function buildFavRows(db) {
  const rows = [];
  for (const ev of Object.values(db.events ?? {})) {
    const score = ev.finalScore ? parseScore(ev.finalScore) : null;
    const sides = ['Home', 'Draw', 'Away'].map((name) => {
      const p = ev.outcomes?.[`1|${name}`]?.plays ?? [];
      return p.length ? { name, last: p.at(-1).odds } : null;
    }).filter(Boolean);
    if (sides.length < 3) continue;
    sides.sort((a, b) => a.last - b.last);
    const fav = sides[0];
    let pnl = 0;
    let won = false;
    let resolved = false;
    if (score) {
      const r = evaluateOutcome('1', fav.name, score);
      pnl = r === 'VOID' ? 0 : r === 'WON' ? fav.last - 1 : -1;
      won = pnl > 0;
      resolved = true;
    }
    rows.push({
      id: ev.eventId,
      eventId: ev.eventId,
      homeTeam: ev.homeTeam,
      awayTeam: ev.awayTeam,
      league: String(ev.tournament ?? '').trim(),
      favName: fav.name,
      favLast: fav.last,
      pnl,
      won,
      resolved,
      score,
    });
  }
  return rows;
}

export function selectFavBand1X2Picks(rows, lo, hi) {
  const LO = Number(lo);
  const HI = Number(hi);
  return rows.filter((r) => !r.resolved && r.favLast >= LO && r.favLast < HI);
}
