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

export function queryTeam(s: string): string;

export function decodeFeedBlock(block: string): Record<string, string>;