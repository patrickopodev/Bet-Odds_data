// Type shim for lib/common.mjs so the TypeScript decision agent can import the
// shared runtime without reimplementing it. Keep this in sync with the .mjs
// implementation — it declares the subset the agent consumes.

export function parseScore(s: string): { home: number; away: number } | null;

export function totalGoals(score: { home: number; away: number }): number;

export type OutcomeResult = 'WON' | 'LOST' | 'VOID' | null;

export function evaluateOutcome(
  marketId: string,
  name: string,
  score: { home: number; away: number },
  siblingNames?: string[]
): OutcomeResult;

export function normTeam(s: string | null | undefined): string;

export function isSimulated(name: string | null | undefined): boolean;

export function queryTeam(s: string): string;

export function decodeFeedBlock(block: string): Record<string, string>;

export const UA: string;

export function extractFeedEvents(html: string, feedName: string): Record<string, string>[];

export function resolveTeam(
  name: string
): Promise<{ id: string; url: string; name: string } | null>;

export interface OddsStats {
  marketId: string;
  name: string;
  odds: number;
  plays: number;
  won: number;
  lost: number;
  void: number;
  settled: number;
  winRate: number | null;
  matchedEvents: number;
}

export function aggregateHistoricalStats(db: { events: Record<string, any> }): OddsStats[];