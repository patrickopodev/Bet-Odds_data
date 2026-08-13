# Playwright Scrape Workflow (TODAY'S FOOTBALL)

How to scrape all 4 target markets (O/U, Correct Score [0:0], Multiscores,
Multigoals) from the SportyBet mobile site as a logged-in user.

## Flow (dictated by project owner)

1. **Log in** successfully (phone + password via the login form).
2. Navigate to **TODAY'S FOOTBALL** (main tab).
3. Wait for the match list to **finish loading**.
4. The list shows all matches for the day. **View each match, one at a time:**
   - Click into the match to open its detail page.
   - Scrape the 4 target markets **within that match** — whatever of the 4 is
     available. If a market is missing, skip it (do not invent data).
5. **The trick:** after scraping one match, **move back to TODAY'S FOOTBALL**,
   then select the next match. Do not skip any match.
6. Do not stop until **every match for that day** has been covered.

## Rules

- Cover all matches in the list; never skip one.
- Only record markets that actually exist for a match; the match may have 1-4
  of the target markets present.
- Always return to the TODAY'S FOOTBALL list between matches (back navigation).
- Keep going until the full day's list is exhausted.

## Data recorded per match

- eventId / gameId
- homeTeam / awayTeam / startTime / tournament / category
- markets: O/U (18), Correct Score [0:0] (41), Multiscores (551), Multigoals (548)
