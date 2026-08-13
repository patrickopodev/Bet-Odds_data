# SportyBet Scrape Workflow (Single API Method)

How the scraper finds today's football and scrapes the 4 target markets
(1X2/O-U, Correct Score [0:0], Multiscores, Multigoals) from SportyBet.
This is the **only** scraping method. No login, no Playwright, no UI.

## Endpoints

1. **Find matches** — full pre-match catalog:
   `POST /api/gh/factsCenter/wapConfigurableEventsByOrder`
   body `{"productId": 3, "pageNum": N, "pageSize": 200}`.
   Paginate (`data.moreEvents`) to walk the whole catalog; keep events whose
   `sport.id === "sr:sport:1"`, that have not kicked off, and whose
   `estimateStartTime` falls in today's UTC day.
2. **Scrape markets** — per-match detail:
   `GET /api/gh/factsCenter/event?productId=3&eventId=sr:match:XXXX`.
   Filter `data.markets` to the target ids: 1 (1X2), 18 (Over/Under),
   41 (Correct Score [0:0]), 548 (Multigoals), 551 (Multiscores).

Both work unauthenticated. They need a mobile `User-Agent` and
`Referer: https://www.sportybet.com/gh/m/` (POST also needs `Content-Type`
and `Origin`). The list endpoint rate-limits rapid page requests, so pages are
paced (~600ms).

## Flow

1. `node scraper.js` — paginates the catalog, filters today's not-started
   football, fetches each match's markets, and writes `data/snapshot-*.json`
   + `data/latest.json` + `data/report-*.md`.
2. `node build-db.mjs` — merges snapshots into the persistent `data/odds-db.json`.
3. `node resolve-results.mjs` — settles finished matches against Flashscore.
4. `node analyze-odds.mjs --db` — good/bad odds report.
5. `node compare-coverage.mjs` — verifies today's matches vs Flashscore.

## Rules

- Cover all matches for the day; never skip one.
- Only record markets that actually exist for a match (1-4 of the targets).
- If a market's status is not active, mark it suspended; do not invent data.