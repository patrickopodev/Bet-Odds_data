// ---------------------------------------------------------------------------
// MARKET ABSTRACTION (spec #3).
//
// A generic Market interface so that adding a 6th market later means adding a
// market definition, NOT redesigning the engine. The engine, strategies, and
// executors only ever talk to Market objects — never to hardcoded market ids
// scattered across the codebase.
//
// NOTE (review action #3): SportyBet's scraper may fetch 1X2 and O/U from a
// single combined feed section ("1X2 / O/U"), but the engine ALWAYS models them
// as two DISTINCT logical markets (ids '1' and '18'). There are exactly five
// logical markets below; the unified engine's five-market summary and every
// strategy reference them by id. 1X2 and O/U must never be collapsed into one.
//
// Each market knows:
//   - id / name / kind
//   - whether it needs a line specifier (O/U "2.5")
//   - how to parse an outcome display name (e.g. "Over 2.5" -> {side,line})
//   - how to resolve a result (delegates to lib/common.mjs evaluateOutcome)
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateOutcome } from '../lib/common.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSIONS_FILE = path.join(__dirname, 'market-extensions.json');

export const MARKETS = {
  '1': { id: '1', name: '1X2', kind: 'match-result', needsSpecifier: false },
  '18': { id: '18', name: 'O/U', kind: 'totals', needsSpecifier: true },
  '41': { id: '41', name: 'Correct Score', kind: 'correct-score', needsSpecifier: false },
  '548': { id: '548', name: 'Multigoals', kind: 'multigoals', needsSpecifier: false },
  '551': { id: '551', name: 'Multiscores', kind: 'multiscores', needsSpecifier: false },
};

export function getMarket(marketId) {
  return MARKETS[String(marketId)] ?? null;
}

export function listMarketIds() {
  return Object.keys(MARKETS);
}

export function listMarkets() {
  return Object.values(MARKETS);
}

// Register a NEW market (spec #22: add a 6th market by adding a definition, not
// by redesigning the engine). Returns the registered market. The execution and
// selection layers need no changes — only a strategy + (later) a selector.
export function registerMarket(def) {
  if (!def || def.id == null || !def.name) {
    throw new Error('registerMarket requires { id, name, ... }');
  }
  MARKETS[String(def.id)] = { needsSpecifier: false, ...def };
  return MARKETS[String(def.id)];
}

// Register all Phase 5 candidate markets from market-extensions.json. Opt-in so
// the default engine (and its tests) stays on the 5 validated markets; enable
// via ENGINE_ENABLE_EXTENSION_MARKETS=1 to surface Corners/BTTS/Asian HC as
// "market exists, no validated strategy" in the five-market output.
export function registerExtensionMarkets(file = EXTENSIONS_FILE) {
  let defs = [];
  try {
    defs = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return defs.map(registerMarket);
}

// Parse a line-market outcome name ("Over 2.5") into { side, line }.
// Returns null for non-line markets or unparsable names.
export function parseLineOutcome(name) {
  const m = String(name).match(/^(Over|Under)\s+(\d+(?:\.\d+)?)$/);
  return m ? { side: m[1], line: parseFloat(m[2]) } : null;
}

// Generic result resolver. Delegates to the single shared evaluator in
// lib/common.mjs so every path (live, paper, training) agrees on the result.
export function resolveOutcome(marketId, outcomeName, score, siblingNames) {
  return evaluateOutcome(String(marketId), outcomeName, score, siblingNames);
}
