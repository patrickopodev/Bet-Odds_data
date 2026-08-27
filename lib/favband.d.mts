export interface FavRow {
  id: string;
  eventId: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  favName: string;
  favLast: number;
  pnl: number;
  won: boolean;
  resolved: boolean;
  score: { home: number; away: number } | null;
}

export function buildFavRows(db: { events?: Record<string, unknown> }): FavRow[];

export function selectFavBand1X2Picks(
  rows: FavRow[],
  lo: number | string,
  hi: number | string
): FavRow[];
