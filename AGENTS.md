# AGENTS.md

## 1X2_BAND tuning (value-bet rule)

The agent's only validated, out-of-sample-profitable signal is the **1X2 favorite
value rule**: bet the match favorite when its (near-kickoff) odds sit in a band.
It is wired into `agent/analysis.ts` (`buildRecommendations`) and force-recommends
the favorite in-band, overriding the heuristic confidence.

It is defined once in the frozen strategy registry (`engine/strategy-registry.json`,
`STRAT-1X2-BAND-v1`, `[1.8, 2.2)`). The legacy selector, the unified engine,
the manual slip, and the auto executor ALL source it from there via
`lib/1x2.mjs:frozen1X2()` — no `1X2_BAND_*` env variable exists anymore,
so a validated strategy can never be silently widened by a deployment variable
(review action #1).

- `BAND_LO` — fixed at `1.8` (lower bound, inclusive); read from the registry.
- `BAND_HI` — fixed at `2.2` (upper bound, exclusive); read from the registry.

> **Historical note:** agent.yml + betting.yml formerly deployed `BAND_LO=1.5`
> (a widened, lower-edge override). That override has been removed; the only
> authoritative band is the validated `[1.8, 2.2)`. The v5b backtest still
> reports `[1.8, 2.2)` as its fixed reference.
- `FAV_CONFIDENCE` (default `0.92`) — confidence stamped on the pick (must clear
  `MIN_CONFIDENCE` in `betting.yml`, default `0.6`).

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

## Unified engine (architecture migration)

The system is being migrated to one unified betting engine + two execution
adapters (see `engine/`). Migration follows the strict rule: **build beside,
never delete first** — the existing 9 workflows remain; the new engine runs as
an additive, read-only shadow (`engine-daily.yml` → `approved-picks` artifact).

- `engine/strategy-registry.json` — **frozen single source of truth** for
  strategy status/params. `STRAT-1X2-BAND-v1` (VALIDATED) and `STRAT-OU-H1-v1`
  (PAPER) only. One source of truth per state; params must not change mid-run.
- `engine/markets.mjs` — generic Market abstraction (1X2 / O/U / Correct Score /
  Multigoals / Multiscores). Add a 6th market by adding a definition, not by
  redesigning the engine.
- `engine/strategies.mjs` — strategy registry + lifecycle + **wrappers around the
  existing validated selectors** (`lib/1x2.mjs`, `paper-B.mjs`). The validated
  math is preserved verbatim.
- `engine/validation.mjs` — shared validation gates (simulated, kickoff buffer,
  confidence, strategy status, stake limits, live-odds band re-check).
- `engine/pick.mjs` — the single `ApprovedPick` object + audit trail, consumed by
  both executors.
- `engine/executors.mjs` — `ManualExecutor` (share code, never stakes) is the
  engine's ONLY live execution adapter; it maps an `ApprovedPick` to a share-code
  selection via `buildSelections` and is asserted to never drop/alter a pick
  (`assertSelectionFidelity`). The engine has **no** `AutoExecutor`: the single
  real-money auto-stake implementation is `stake-autoplace.mjs` behind the opt-in
  `STAKE_AUTOPLACE_ENABLED` gate. Keeping one auto-stake path avoids two divergent
  implementations.
- `engine/training.mjs` — virtual bankroll only; forbidden from the real staking
  adapter.
- `engine/daily-engine.mjs` — the unified selector: upcoming + non-simulated
  matches, all markets, LIVE strategies only, five-market output.

### 1X2_BAND discrepancy resolution (spec #6)
The **validated** Strategy A band is **[1.8, 2.2)**, per `train-model-v5b.mjs`
(k-fold OOS +16.8%, CI excludes zero). The previously-deployed `BAND_LO=1.5`
widening in `agent.yml`/`betting.yml` was an **experimental override** (more
volume, lower edge) and was **excluded** from the frozen `STRAT-1X2-BAND-v1`
spec. It has now been **removed** (review action #1): no `1X2_BAND_*` env variable
exists anywhere in the production path, and every consumer reads the band from the
frozen registry via `lib/1x2.mjs:frozen1X2()`. The new engine always used
the registry values; the legacy selector/manual-slip/auto-executor now do too, so
legacy and unified selections are provably identical (see `engine/equivalence-harness.mjs`).

### Engine cutover plan (when the shadow becomes the source of truth)
The unified engine is currently a **read-only shadow**: `betting.yml` still runs
the legacy chain (`agent.yml → agent-recommendations.json → stake.mjs →
stake-placement.mjs → stake-autoplace.mjs`). The engine's `approved-picks.json`
is NOT consumed by the money path yet. Cutover is gated, not automatic:

1. **Parity proven end-to-end.** `engine/equivalence.mjs` must report
   `equivalenceWithStakePipeline === true` AND `enginePicksPassStakeGates === true`
   for `minDays` (≥14) consecutive daily cycles, with the readiness gate in
   `engine/observe.mjs` (`evaluateReadiness`) returning `ready`. This proves the
   engine selects the SAME picks the real `stake.mjs` money path would, including
   confidence/EV/odds-window/slip-composition gates and the friendly gate.
2. **Single manual executor.** Retire `manual-slip.yml` (legacy duplicate) in favor
   of `engine/slip.mjs`, which is the only manual path going forward.
3. **Single auto executor.** Wire `engine/slip.mjs` to the opt-in auto-stake
   (`STAKE_AUTOPLACE_ENABLED` → `stake-autoplace.mjs`) at cutover; do NOT add a
   second `AutoExecutor` to the engine. Keep exactly one auto-stake implementation.
4. **Flip the money path.** Change `betting.yml` to read `approved-picks.json`
   instead of `agent-recommendations.json`, behind the same opt-in autoplace gate.
   Leave the legacy `agent` workflow running in shadow until N days post-cutover,
   then delete it.
5. **Never delete first.** Every step above is additive; the legacy path is removed
   only after the engine has been the live source for ≥30 resolved picks with
   matching P&L.

### Architecture tests
`test/engine/*.test.mjs` enforce: market isolation, strategy isolation (PAPER
never LIVE), simulation protection, odds boundaries (1.79/1.80/2.19/2.20),
execution parity (manual executor selection fidelity), training isolation,
research BLOCKED ≠ NO_RESULTS, frozen strategy immutability, and a **Strategy A
regression** proving the new engine selects identically to the legacy
`select1X2Picks`. Run with `npm test`.

