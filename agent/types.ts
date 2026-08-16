// Shared types for the TypeScript decision agent.

export interface TeamInfo {
  name: string;
  flashscoreId: string | null;
  flashscoreUrl: string | null;
  position: number | null;
  played: number | null;
  points: number | null;
  form: string; // last 5 results as "WDDLW"
  formScore: number; // W=3, D=1, L=0 summed over form
  lastResults: { opp: string; score: string; result: 'W' | 'D' | 'L' }[];
  venue: string | null;
  research: string[]; // web-search snippets
  league?: { id: string; url: string; name: string } | null;
  error?: string;
}

export interface MatchResearch {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  tournament: string;
  startTime: string;
  venue: string | null;
  h2h: string | null;
  home: TeamInfo;
  away: TeamInfo;
}

export interface Candidate {
  market?: string; // display section (filled by caller)
  marketId: string;
  outcome: string;
  odds: number;
  impliedProb: number; // 1/odds
  historicalWinRate: number | null; // from odds-db at this outcome (any odds band)
  historicalSettled: number;
  edge: number | null; // historicalWinRate - impliedProb
  confidence: number; // 0..1 blended research score
  recommendedMinOdds: number; // odds threshold the JS staker must respect
  recommended: boolean;
  reason: string;
}

export interface Recommendation {
  match: MatchResearch;
  candidates: Candidate[];
}

export interface AgentReport {
  generatedAt: string;
  source: string;
  totalMatches: number;
  researched: number;
  recommendedBets: number;
  matches: Recommendation[];
}