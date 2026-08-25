# AGENTS.md

## FAV_BAND tuning (value-bet rule)

The agent's only validated, out-of-sample-profitable signal is the **1X2 favorite
value rule**: bet the match favorite when its (near-kickoff) odds sit in a band.
It is wired into `agent/analysis.ts` (`buildRecommendations`) and force-recommends
the favorite in-band, overriding the heuristic confidence.

It is tuned via environment variables (no code change needed):

- `FAV_BAND_LO` (default `1.8`) — band lower bound (inclusive).
- `FAV_BAND_HI` (default `2.2`) — band upper bound (exclusive).

> **Currently deployed** via workflow env: `FAV_BAND_LO=1.5`, `FAV_BAND_HI=2.2`
> (agent.yml + betting.yml). Widened from the validated `[1.8, 2.2)` for faster
> paper-track sample accumulation — expect more volume but lower edge. The
> v5b backtest still reports `[1.8, 2.2)` as its fixed reference.
- `FAV_CONFIDENCE` (default `0.92`) — confidence stamped on the pick (must clear
  `MIN_CONFIDENCE` in `scrape.yml`, default `0.6`).

### Why these values
Backtested in `train-model-v5b.mjs` (k-fold, band re-selected on train only):
favorites priced **[1.8, 2.2)** returned **+16.8% ROI**, 95% CI **[+2.1%, +32.6%]**
— the only configuration that beats the ~7.7% house margin with a CI excluding
zero. Other bands lose: very short favorites (<1.3) and longshots (2.2–3.0) are
negative, and steam-following (price movement) does not predict winners here.

### Tuning guidance
- Widen the band (e.g. `1.5`–`2.2`) for more volume but lower edge; narrow it
  (e.g. `1.9`–`2.1`) for fewer, higher-conviction bets.
- Re-validate any change with `node train-model-v5b.mjs` (validation mode) and
  confirm the k-fold ROI CI still excludes zero before trusting it live.
- Do NOT enable auto-staking (`STAKE_AUTOPLACE_ENABLED`) until the paper-trade
  track in `data/paper-picks.json` shows positive ROI over ≥30 resolved picks.
