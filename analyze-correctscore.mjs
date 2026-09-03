import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, DB_FILE, loadDb, aggregateHistoricalStats } from './lib/common.mjs';

// ---------------------------------------------------------------------------
// Correct-score (market 41) relation analyzer.
//
// Builds, per scoreline, an odds-band -> actual-frequency table from the
// persistent odds database, and flags "value" bands where the observed win
// rate beats the bookmaker's implied probability (1/odds). This is the explicit,
// human-readable surface of the same repeated-odds -> outcome relation the agent
// already consumes via aggregateHistoricalStats() for market 41 (see
// agent/analysis.ts RELEVANT_MARKETS + outcomeHistory). Keeping this script on
// the shared aggregateHistoricalStats means the report and the live recommender
// can never drift on how history is built.
// ---------------------------------------------------------------------------

const MARKET = '41';
const TARGET_SCORES = ['2:1', '1:2', '2:2', '2:3', '3:2', '3:3'];
// Below this many settled matches a band is noise, not signal.
const MIN_SETTLED = 5;
// Minimum positive edge (actual - implied) to call a band "value".
const VALUE_EDGE = 0.0;

const binOdds = (o) => Math.round(o * 2) / 2;

function buildReport(db) {
  const stats = aggregateHistoricalStats(db).filter((s) => s.marketId === MARKET);
  const byName = new Map();
  for (const s of stats) {
    const b = binOdds(s.odds);
    if (!byName.has(s.name)) byName.set(s.name, new Map());
    const m = byName.get(s.name);
    if (!m.has(b)) {
      m.set(b, { odds: b, plays: 0, won: 0, lost: 0, void: 0, settled: 0 });
    }
    const r = m.get(b);
    r.plays += s.plays;
    r.won += s.won;
    r.lost += s.lost;
    r.void += s.void;
    r.settled += s.settled;
  }

  const scores = [];
  for (const name of [...byName.keys()].sort()) {
    const bins = [...byName.get(name).values()].sort((a, b) => a.odds - b.odds);
    const tot = bins.reduce((a, b) => ({ settled: a.settled + b.settled, won: a.won + b.won }), {
      settled: 0,
      won: 0,
    });
    const rows = bins.map((b) => {
      const winRate = b.settled ? b.won / b.settled : null;
      const implied = 1 / b.odds;
      const edge = winRate != null ? winRate - implied : null;
      return {
        odds: b.odds,
        settled: b.settled,
        won: b.won,
        winRate,
        implied,
        edge,
        value: b.settled >= MIN_SETTLED && edge != null && edge > VALUE_EDGE,
      };
    });
    scores.push({
      name,
      totalSettled: tot.settled,
      totalWon: tot.won,
      baseWinRate: tot.settled ? tot.won / tot.settled : null,
      strategyBand: (() => { const v = rows.filter((b) => b.value); return v.length > 0 ? { lo: v[0].odds, hi: v[v.length - 1].odds + 0.5 } : null; })(),
      bands: rows,
    });
  }
  return scores;
}

function renderMarkdown(scores) {
  const lines = [
    '# Correct-Score (market 41) — Repeated-Odds → Outcome Relations',
    '',
    `_Generated ${new Date().toISOString()} UTC. Odds binned to 0.5. "Value" = observed win rate > implied (1/odds) with >= ${MIN_SETTLED} settled._`,
    '',
  ];
  const targets = scores.filter((s) => TARGET_SCORES.includes(s.name));
  const others = scores.filter((s) => !TARGET_SCORES.includes(s.name));
  for (const group of [['Target scores (user-specified)', targets], ['Other captured scorelines', others]]) {
    const [title, list] = group;
    if (!list.length) continue;
    lines.push(`## ${title}`, '');
    for (const s of list) {
      lines.push(`### ${s.name}  —  ${s.totalSettled} settled, base hit-rate ${( (s.baseWinRate ?? 0) * 100).toFixed(1)}%`, '');
      if (!s.bands.length) {
        lines.push('_No odds-band history yet (need settled matches with this line offered)._', '');
        continue;
      }
      lines.push('| Odds band | Settled | Won | Win% | Implied% | Edge | Value |', '| ---: | ---: | ---: | ---: | ---: | ---: | --- |');
      for (const b of s.bands) {
        const wr = b.winRate != null ? (b.winRate * 100).toFixed(0) + '%' : '—';
        const im = (b.implied * 100).toFixed(0) + '%';
        const ed = b.edge != null ? (b.edge >= 0 ? '+' : '') + (b.edge * 100).toFixed(0) + '%' : '—';
        lines.push(`| ${b.odds.toFixed(1)} | ${b.settled} | ${b.won} | ${wr} | ${im} | ${ed} | ${b.value ? '**YES**' : ''} |`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main() {
  const db = await loadDb(DB_FILE);
  const scores = buildReport(db);
  await fs.mkdir(DATA_DIR, { recursive: true });

  const jsonPath = path.join(DATA_DIR, 'correctscore-relations.json');
  const mdPath = path.join(DATA_DIR, 'correctscore-report.md');
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), market: MARKET, targetScores: TARGET_SCORES, minSettled: MIN_SETTLED, scores }, null, 2), 'utf8');
  await fs.writeFile(mdPath, renderMarkdown(scores), 'utf8');

  const withValue = scores.flatMap((s) => s.bands.filter((b) => b.value).map((b) => ({ score: s.name, ...b })));
  console.log(`Correct-score analyzer: ${scores.length} scoreline(s) with history.`);
  console.log(`Value bands flagged (win% > implied, >=${MIN_SETTLED} settled): ${withValue.length}`);
  for (const v of withValue) {
    console.log(`  ${v.score} @ ${v.odds.toFixed(1)} — ${(v.winRate * 100).toFixed(0)}% actual vs ${(v.implied * 100).toFixed(0)}% implied (edge ${(v.edge * 100).toFixed(0)}%+, ${v.settled} settled)`);
  }
  console.log(`Wrote ${jsonPath} and ${mdPath}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((e) => {
    console.error(`analyze-correctscore failed: ${e.message}`);
    process.exit(1);
  });
}
