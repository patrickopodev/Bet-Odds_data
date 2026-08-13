# webscraper-action

Scheduled GitHub Action that scrapes **today's football odds** from SportyBet (Ghana mobile site) via their internal JSON API — no login, no UI scraping for the main path — records every odds move into a persistent database, settles finished matches against Flashscore, and mines the history for good/bad prices.

Runs every 30 minutes via `.github/workflows/scrape.yml` and commits fresh `data/` back to the repo.

---

## Quick start

```bash
npm install          # only dependency is playwright-core (used by compare)
npm test             # run the test suite (node --test)
npm run scrape       # 1. scrape today's SportyBet odds -> data/snapshot-*.json + latest.json + report-*.md
npm run build-db     # 2. merge snapshots into the persistent data/odds-db.json
npm run resolve      # 3. settle finished matches against Flashscore
npm run analyze      # 4. good/bad odds report -> data/performance.md
npm run compare      # 5. verify today's coverage vs Flashscore -> data/comparison.json
npm run winners      # 6. per-match winning odds in the 4 sections -> data/winners-YYYY-MM-DD.md
```

Requirements: **Node >= 20** (uses `fetch`, `node --test`, `AbortController`). No API keys.

---

## The pipeline

```
SportyBet API  ──>  scraper.js  ──>  snapshot-*.json / latest.json
                                          │
                          build-db.mjs  <──┘  (merge -> odds-db.json)
                                          │
                          resolve-results.mjs  (Flashscore -> finalScore)
                                          │
                          analyze-odds.mjs    (good/bad odds -> performance.md)
                          winners.mjs         (per-match winners -> winners-*.md)
                          compare-coverage.mjs (coverage vs Flashscore)
```

| Step | Script | npm run | Writes |
|---|---|---|---|
| Scrape today's odds | `scraper.js` | `scrape` | `data/snapshot-*.json`, `data/latest.json`, `data/report-*.md` |
| Build odds database | `build-db.mjs` | `build-db` | `data/odds-db.json` |
| Settle finished matches | `resolve-results.mjs` | `resolve` | updates `odds-db.json` (`finalScore`) |
| Good/bad odds analysis | `analyze-odds.mjs` | `analyze` | `data/performance.md` |
| Winning odds per match | `winners.mjs` | `winners` | `data/winners-YYYY-MM-DD.md` |
| Coverage verification | `compare-coverage.mjs` | `compare` | `data/comparison.json` |

### 1. Scrape — `node scraper.js`

Paginates SportyBet's full pre-match catalog (`wapConfigurableEventsByOrder`), keeps today's not-started football, and fetches each match's markets. Records the **4 odds sections**:

| Section | SportyBet market ids |
|---|---|
| **1X2 / O/U** | 1 (1X2) + 18 (Over/Under), merged |
| **Correct Score [0:0]** | 41 |
| **Multiscores** | 551 |
| **Multigoals** | 548 |

Each snapshot writes `data/snapshot-<timestamp>.json` (raw), `data/latest.json` (always the newest), and a human-readable `data/report-*.md`. If the API returns **0 matches, it aborts without overwriting `latest.json`** (guards against an API block wiping good data).

### 2. Build DB — `node build-db.mjs`

Idempotently merges **all** snapshots in `data/` into `data/odds-db.json`. Key behaviours:

- One play per **distinct odds value** per outcome (a price that holds across snapshots doesn't inflate history; re-running is safe).
- Matches lacking a join key (both teams + kickoff) are excluded — they can never be settled against Flashscore.
- Compacted play histories from pre-fix databases (identical-odds repeats collapsed to one play).
- Logs: `Merged N snapshot(s) -> M event(s), K distinct-odds play(s)`.

### 3. Resolve — `node resolve-results.mjs`

Settles every unsettled event by matching it to Flashscore:

1. Resolves **both** team names through the Livesport search API (normalized core-name match, with `FC`/`AC`/`(Por)`-style tokens stripped).
2. Scrapes each team's Flashscore page for the embedded `summary-results` feed.
3. Confirms the fixture by **team-id pairing** (feed fields `PX`/`PY`), a kickoff within ±1h tolerance, `AB=3` (finished), and rejects interrupted/abandoned matches.

Only genuinely finished fixtures get a `finalScore`. Anything unverifiable is skipped and stays pending for a later run. Teams Flashscore doesn't index (reserves, U19, many friendlies) will stay unresolved.

### 4. Analyze — `node analyze-odds.mjs --db`

Evaluates every recorded price against its match's final score (WON / LOST / VOID) and groups by outcome + odds:

- **Good odds** (settled ≥3, always won), **Bad odds** (always lost), **Mixed**, **Unsettled**.
- Writes `data/performance.md`; prints a summary to stdout.
- Covers all 4 sections — including **1X2** (`Home`/`Draw`/`Away`), O/U (with whole-line VOID pushes), Correct Score, Multiscores (incl. `Other Homewin`/`Other Awaywin` vs listed combos), and Multigoals (`No goal`, ranges, `7+`).

Interactive extras (no `--db`):
```bash
node analyze-odds.mjs "Multigoals"           # repeated odds across matches in a section
node analyze-odds.mjs Multigoals "1-4" 1.12  # exact lookup: which matches offer a price
```

### 5. Winners — `node winners.mjs`

The per-match view of **which odds played (won)** in each of the 4 sections for today's settled matches. For each finished match it lists every outcome that won, with the best odds seen:

```bash
node winners.mjs             # today's settled matches (console + data/winners-YYYY-MM-DD.md)
node winners.mjs 2026-08-13  # a specific day
node winners.mjs --all       # every settled match in the DB
```

```
Los Angeles FC 2:1 Queretaro FC
  [1X2 / O/U]
     Over 2.5  @ 1.42
     ...
  [Correct Score [0:0]]
     2:1  @ 7.8
  [Multiscores]
     2:1, 3:1 or 4:1  @ 3.53
  [Multigoals]
     2-3  @ 1.72
```

### 6. Compare — `node compare-coverage.mjs`

Cross-checks SportyBet's today list against Flashscore's full today list (captured via headless Chromium + the site's feed endpoint). Reports `matched / missing` and flags matches present on one site but not the other. Uses `CHROMIUM_PATH` env if provided (CI installs Chromium via `npx playwright-core install chromium --with-deps`). Writes `data/comparison.json`; exits non-zero if the check itself fails.

---

## The database schema

`data/odds-db.json`:

```jsonc
{
  "version": 1,
  "updatedAt": "2026-08-13T14:24:48.114Z",
  "events": {
    "sr:match:123456": {
      "eventId": "sr:match:123456",
      "homeTeam": "Hearts",
      "awayTeam": "Benfica",
      "tournament": "Europa League",
      "category": "Club Friendly",
      "startTime": "2026-08-13T18:45:00.000Z",
      "firstSeen": "2026-08-13T14:00:00.000Z",
      "lastSeen": "2026-08-13T14:24:48.114Z",
      "finalScore": "1:1",          // null until resolved
      "settledAt": "2026-08-13T19:10:00.000Z",
      "finalStatus": "FT",
      "flashscoreId": "abc123",     // set by the resolver
      "outcomes": {
        "18|Over 2.5": {
          "marketId": "18",
          "name": "Over 2.5",
          "plays": [
            { "odds": 1.42, "active": true, "seenAt": "2026-08-13T14:00:00.000Z", "lastSeen": "2026-08-13T14:24:48.114Z" }
          ]
        }
      }
    }
  }
}
```

---

## Shared utilities — `lib/common.mjs`

The single source of truth both modules rely on:

| Export | Purpose |
|---|---|
| `DATA_DIR`, `DB_FILE` | paths (env-overridable: `DATA_DIR`, `DB_FILE`) |
| `MARKET_ORDER`, `TARGET_MARKET_IDS` | the 4 sections and SportyBet id → section mapping |
| `UA` | mobile user-agent (env-overridable: `USER_AGENT`) |
| `fetchJson`, `fetchText`, `fetchWithTimeout` | HTTP helpers with abort timeouts |
| `mapWithConcurrency` | parallel worker pool with error capture |
| `fetchTodayFootballEvents`, `fetchEventMarkets`, `fetchAllFootballEvents` | SportyBet API clients |
| `loadDb`, `saveDb` | DB read/write |
| `decodeFeedBlock`, `normTeam`, `queryTeam`, `sameTeam`, `kickoffDeltaMs` | Flashscore feed decoding + team-name normalization shared by `resolve-results` and `compare-coverage` |

---

## Testing

```bash
npm test        # node --test test/
```

19 tests covering: market evaluators (1X2, O/U VOID edge, Correct Score, Multiscores `Other Homewin`, Multigoals), team-name normalization + feed decoding, `build-db` play dedup/compaction, and the winners view.

---

## GitHub Action schedule

`.github/workflows/scrape.yml` runs `*/30 * * * *` UTC. Every run executes the full pipeline and, if `data/` changed, commits it back as `chore(webscraper): update scraped data`. Scraped artifacts are also uploaded as a 90-day workflow artifact (`scraped-data`). Run it manually via **Actions → Scheduled Web Scraper → Run workflow**.

---

## Environment variables

| Var | Default | Used by |
|---|---|---|
| `DATA_DIR` | `data` | all scripts |
| `DB_FILE` | `data/odds-db.json` | build-db, resolve, analyze, winners |
| `USER_AGENT` | mobile UA string | all scrapers |
| `CHROMIUM_PATH` | auto | compare-coverage |
| `OUT` | `data/comparison.json` | compare-coverage |

---

## Project layout

```
.
├── .github/workflows/scrape.yml   # 30-min scheduled pipeline
├── lib/common.mjs                 # shared HTTP, API clients, normalization, DB IO
├── scraper.js                     # SportyBet API scrape -> snapshots + report
├── build-db.mjs                   # snapshots -> persistent odds-db.json
├── resolve-results.mjs            # Flashscore settlement of finished matches
├── analyze-odds.mjs               # good/bad odds analysis (--db) + interactive lookups
├── winners.mjs                    # per-match winning odds in the 4 sections
├── compare-coverage.mjs           # SportyBet vs Flashscore coverage check
├── test/                          # node --test suite
├── SCRAPING-WORKFLOW.md           # endpoint/flow notes for the single API method
└── data/                          # snapshots, odds-db.json, reports (committed)
```

## Notes & limitations

- **Coverage guarantee**: the scraper walks the full pre-match catalog (`moreEvents` pagination), not the curated feed, so no today match is skipped by design.
- **Resolution ceiling**: only matches Flashscore indexes settle. Reserve/youth/friendly fixtures typically stay pending forever.
- **Data growth**: plays are per distinct odds value; the DB grows with new prices, not new snapshots. Snapshots themselves are gitignored from being cleaned — old ones accumulate in `data/`.