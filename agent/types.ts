// Shared types for the TypeScript decision agent.

// A Flashscore match-feed player contribution: goals/assists/cards counted
// over a team's recent finished matches.
export interface PlayerStat {
  player: string;
  count: number;
}

// Match officials + venue pulled from the Flashscore match feed.
export interface MatchOfficials {
  referee: string | null;
  venue: string | null;
  town: string | null;
  capacity: string | null;
  attendance: string | null;
}

// Explicit outcome of a web-research call. A blocked search (challenge/rate
// limit) is reported distinctly from "no information found" so the betting
// pipeline never mistakes an unavailable search for a genuine no-result.
export type SearchStatus =
  | 'SEARCH_SUCCESS'
  | 'SEARCH_NO_RESULTS'
  | 'SEARCH_BLOCKED'
  | 'SEARCH_ERROR';

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
  research: string[]; // web-search snippets for this team
  researchAt: string | null; // ISO timestamp of when research was fetched
  researchStatus?: SearchStatus; // SEARCH_SUCCESS | SEARCH_NO_RESULTS | SEARCH_BLOCKED | SEARCH_ERROR
  scorers: PlayerStat[]; // goals scored in the team's last-5 finished matches
  assists: PlayerStat[]; // assists recorded in the team's last-5 finished matches
  cards: PlayerStat[]; // cards picked up in the team's last-5 finished matches
  league?: { id: string; url: string; name: string } | null;
  error?: string;
}

export interface MatchResearch {
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  tournament: string;
  startTime: string;
  home: TeamInfo;
  away: TeamInfo;
  officials: MatchOfficials | null;
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
  oddsDrift: number | null; // last seen odds - first seen odds today (negative = steamed)
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