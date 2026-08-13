import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, loadDb, MARKET_ORDER } from './lib/common.mjs';
import { evaluateOutcome } from './analyze-odds.mjs';

// Section name per market id. 1X2 (1) and O/U (18) merge into one section, and
// the multiscores/multigoals ids map to their display names.
const SECTION_BY_MARKET = {
  '1': '1X2 / O/U',
  '18': '1X2 / O/U',
  '41': 'Correct Score [0:0]',
  '548': 'Multigoals',
  '551': 'Multiscores',
};

// Group sibling outcome names per market so combo-aware evaluators (e.g.
// Multiscores "Other Homewin") can see whether a final score is covered.
function siblingNamesByMarket(ev) {
  const byMarket = new Map();
  for (const o of Object.values(ev.outcomes ?? {})) {
    if (!byMarket.has(o.marketId)) byMarket.set(o.marketId, []);
    byMarket.get(o.marketId).push(o.name);
  }
  return byMarket;
}

// Evaluate a settled event and return every outcome that WON, tagged with its
// section and the odds range it was seen at (best/lowest first).
export function winningOutcomes(ev) {
  if (!ev.finalScore) return [];
  const [home, away] = ev.finalScore.split(':').map(Number);
  const score = { home, away };
  const byMarket = siblingNamesByMarket(ev);
  const seen = new Set();
  const won = [];
  for (const o of Object.values(ev.outcomes ?? {})) {
    const result = evaluateOutcome(o.marketId, o.name, score, byMarket.get(o.marketId));
    if (result !== 'WON' || seen.has(o.name)) continue;
    seen.add(o.name);
    const odds = (o.plays ?? []).map((p) => p.odds);
    won.push({
      section: SECTION_BY_MARKET[String(o.marketId)] ?? String(o.marketId),
      name: o.name,
      best: odds.length ? Math.min(...odds) : null,
      odds,
    });
  }
  return won;
}

// Sort a match's winners into the canonical 4-section display order.
export function groupBySection(winners) {
  const groups = new Map();
  for (const w of winners) {
    if (!groups.has(w.section)) groups.set(w.section, []);
    groups.get(w.section).push(w);
  }
  return [...MARKET_ORDER].filter((s) => groups.has(s)).map((s) => [s, groups.get(s)]);
}

function oddsText(w) {
  if (w.odds.length <= 1) return `@ ${w.odds[0]}`;
  return `@ ${w.best} (seen at ${w.odds.join(', ')})`;
}

function formatMarkdown(events) {
  const lines = ['# Winning Odds by Section', '', `_Generated ${new Date().toISOString()} UTC_`, ''];
  let total = 0;
  for (const ev of events) {
    const won = winningOutcomes(ev);
    if (!won.length) continue;
    total += won.length;
    lines.push(`## ${ev.homeTeam} ${ev.finalScore} ${ev.awayTeam}`, '');
    for (const [section, winners] of groupBySection(won)) {
      lines.push(`**${section}**`, '');
      for (const w of winners) lines.push(`- ${w.name} ${oddsText(w)}`);
      lines.push('');
    }
  }
  lines.push(`Total winning outcomes: ${total}`, '');
  return lines.join('\n');
}

function printConsole(events) {
  let total = 0;
  for (const ev of events) {
    const won = winningOutcomes(ev);
    if (!won.length) continue;
    total += won.length;
    console.log(`\n${ev.homeTeam} ${ev.finalScore} ${ev.awayTeam}`);
    for (const [section, winners] of groupBySection(won)) {
      console.log(`  [${section}]`);
      for (const w of winners) console.log(`     ${w.name}  ${oddsText(w)}`);
    }
  }
  console.log(`\nTotal winning outcomes across ${events.length} settled match(es): ${total}`);
}

async function runCli() {
  const arg = process.argv[2];
  let events;
  const db = await loadDb();
  const all = Object.values(db.events).filter((e) => e.finalScore);
  if (arg === '--all') {
    events = all;
  } else {
    const day = arg ?? new Date().toISOString().slice(0, 10);
    events = all.filter((e) => (e.startTime ?? '').startsWith(day));
  }
  if (!events.length) {
    console.log('No settled matches' + (arg && arg !== '--all' ? ` on ${arg}` : ' for today') + '.');
    return;
  }

  const date = arg && arg !== '--all' ? arg : new Date().toISOString().slice(0, 10);
  const outFile = path.join(DATA_DIR, `winners-${date}.md`);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(outFile, formatMarkdown(events), 'utf8');

  printConsole(events);
  console.log(`Wrote: ${outFile}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((e) => {
    console.error(`winners failed: ${e.message}`);
    process.exit(1);
  });
}