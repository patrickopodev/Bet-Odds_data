# Feature Research Plan — testing new signals without disturbing the live path

> Status: RESEARCH ONLY. Nothing here is auto-LIVE. Every candidate stays `TRAINING`
> (or `REJECTED`) until it clears the gates in §6. The frozen `STRAT-1X2-BAND-v1`
> and `STRAT-OU-H1-v1` (Paper-B) are NOT touched by any of this.

## Context — what the harness currently shows

`engine/backtest-harness.mjs` runs a chronological 70/30 train/holdout split and a
`normalCI` NO-SIGNAL gate. On the real DB (2808 events / 560 settled) it reports,
for every section, **NO SIGNAL**:

| Section | base (favourite) ROI | + DB-history ROI | enriched |
|---|---|---|---|
| 1X2 | +17.9% | +2.8% | +2% (n=8) |
| O/U | −2% | −12% | 0 |
| Multigoals | −6.9% | −45.8% | 0 |
| CorrectScore | −30% | +3.4% | +510% (n=1) |
| Multiscores | −22.3% | −50.1% | 0 |

**Critical caveat:** the 1X2 "NO SIGNAL" is most likely a *methodology artifact*, not a
refutation of the validated strategy. `train-model-v5b.mjs` reported +16.8% ROI with a
CI **excluding** zero using k-fold over the whole settled set; the harness's single
70/30 split leaves only **56** 1X2 holdout bets, so its CI spans zero. The other
sections' negatives (especially O/U / Multigoals / Multiscores DB-history) look real.

The five suggestions below, in priority order.

---

## Suggestion 1 — Reconcile the harness with the validated k-fold method

**Goal:** make the harness's verdicts comparable to `train-model-v5b.mjs` so a NO-SIGNAL
(or SIGNAL) reading is trustworthy.

**Why now:** until the harness uses the same evaluation rigor as the validated backtest,
we cannot honestly say "feature X doesn't work" — we can only say "feature X didn't show
edge on 56 bets." The live 1X2_BAND already passed k-fold; the research harness must too.

**Concrete changes — `engine/backtest-harness.mjs`:**
- Add an expanding-window (or k-fold) evaluator that reuses the existing `runFeatureSet`
  building blocks. Sketch:
  - `runExpandingWindow(db, { flags, folds = 5, features, minBets })` — sort by
    `startTime`, walk a growing train window, score each fold's holdout, pool the bets,
    then compute one `roi` + `normalCI` over the pooled bets.
  - Or `runKfold(db, { flags, k = 5, ... })` with non-overlapping holdouts.
  - Both must call `buildTrainStats(train)` per fold (already leakage-safe) — **never**
    aggregate history over the whole DB.
- Refactor `runFeatureSet` so the train/holdout split is injectable (it already takes
  `trainFrac`; add a `train`/`holdout` override or a `splits` array) so the k-fold driver
  can call it per fold.
- `compareAllMarkets` / `compareMarketEnrichment` gain a `method: 'split' | 'kfold'`
  option; CLI `--method=kfold`.
- Keep the deterministic `normalCI` (no bootstrap) so tests stay stable.

**Acceptance:**
- `npm run feature-backtest` with `--method=kfold` reproduces a 1X2 favourite ROI/CI in
  the same ballpark as `train-model-v5b` (+~16%, CI excluding zero). If it does, the
  harness is trusted; if not, debug the divergence (odds-band width, VOID handling,
  `MIN_HISTORY_SAMPLE`).
- Unit test: synthetic DB (the one in `test/engine/backtest-harness.test.mjs`) yields the
  same pooled verdict under k-fold as under the single split.

---

## Suggestion 2 — Grow the sample (data volume is the real bottleneck)

**Goal:** get enough settled bets that a 30-bet gate produces a tight CI.

**Why now:** 560 settled events total; the 1X2 holdout is 56. No section can clear any
gate at this volume. More history > more features.

**Concrete changes:**
- `.github/workflows/collector.yml` (and the `odds-data` artifact restore in
  `scripts/restore-artifact.sh`): extend artifact **retention** (already 90d for
  `feature-backtest`; raise the `odds-data` artifact retention to ≥180–365d) and ensure
  settled results are appended, not overwritten.
- Confirm `data/` is gitignored (it is) — history lives only in the `odds-data` GitHub
  Artifact, nothing commits to `main`.
- Add a `prune`/vacuum step if the JSON grows unwieldy (currently ~55 MB; fine for now).
- Consider increasing collection cadence (more matches scraped per day) only if it
  doesn't breach SportyBet ToS — out of scope for code review, flag to owner.

**Acceptance:** after ~1–2 months, `feature-backtest --method=kfold` reports 1X2
holdout `n` in the hundreds and a CI that excludes zero, or conclusively shows the
band is dead. Either way, the verdict is now statistically meaningful.

---

## Suggestion 3 — Retire the DB-odds-history + drift candidate

**Goal:** stop spending attention on a signal the data has rejected.

**Why now:** across O/U, Multigoals and Multiscores the DB-history signal is strongly
**negative**; in 1X2/CorrectScore it's weakly positive with CIs spanning zero. The
`STRAT-1X2-ODDSHIST-v1` candidate has no path to promotion.

**Concrete changes — `engine/strategy-registry.json`:**
- Change `STRAT-1X2-ODDSHIST-v1` `status` from `"TRAINING"` to `"REJECTED_CANDIDATE"`
  (or `"ARCHIVED"` — pick one and document it in the registry's top-level enum note), and
  update `validationStatus` to `"BACKTESTED_NEGATIVE"` with a one-line note pointing at
  the per-section table above.
- Keep the entry (don't delete — "never delete first", and it preserves the audit trail
  of what was tested and rejected).
- `STRAT-1X2-H2HFORM-v1` stays `TRAINING` but `BLOCKED` on data (see Suggestion 5).

**Acceptance:** `getLiveStrategies()` (in `engine/strategies.mjs`) still returns only the
two frozen strategies; the rejected entry is excluded. No test references it as live.

---

## Suggestion 4 — Persist + ablate the signals the agent already trusts

**Goal:** backtest, out-of-sample, the features that *already* reach `confidence` in
`agent/analysis.ts` — Flashscore form/position (1X2) and recent goal totals (O/U) — which
the harness has never tested because that history isn't in the DB.

**Why now:** this is the highest-expected-value research. The audit (see prior notes)
confirmed `formScore`/`position` drive 1X2 confidence and `lastResults` goal totals drive
O/U confidence in `agent/analysis.ts:analyzeCandidate` / `buildRecommendations`. If those
hold up out-of-sample, they're the natural next LIVE candidate after 1X2_BAND.

**Concrete changes:**
- **Collect the history.** Add a small transform (new `lib/team-form.mjs` or extend
  `flashscore.ts`) that, per settled match, appends a record to `data/team-form.json`:
  `{ team, asOf, position, formScore, lastResults:[...], avgGoalsFor, avgGoalsAgainst }`
  keyed by team. Restore/persist via the `odds-data` artifact (same pattern as
  `odds-db.json`).
- **Feature module** `engine/team-features.mjs` (mirror `engine/features.mjs` purity):
  - `extractTeamForm(formDb, team, asOf)` → recent form/position/goal-totals.
  - `teamStrengthEdge(home, away, asOf)` → e.g. position diff + form diff, normalized.
- **Harness gate** (placeholder, like `h2hPasses`/`competitionPasses`):
  - `formPasses(features, ev)` → true if the favourite's side has the stronger
    form/position (hypothesis, validated only by the harness).
- **Ablation** in `runAblation` / `compareAllMarkets`: add `form` to `FEATURE_FLAGS`.
  Test `1X2_BAND + form` (1X2) and `goal-total model` (O/U) the same way
  `STRAT-1X2-ODDSHIST-v1` was tested — favourite refined by the form gate.
- **Registry:** add `STRAT-1X2-FORM-v1` and `STRAT-OU-GOALTOTAL-v1` as `TRAINING`,
  `source` pointing at the harness.

**Acceptance:**
- New unit tests in `test/engine/team-features.test.mjs` (pure extraction on synthetic
  form records).
- `feature-backtest --method=kfold` reports a `form` row per relevant section; if
  `1X2_BAND + form` clears the gate (n≥30, ROI > HOUSE_MARGIN, CI excludes zero) on the
  **holdout folds**, it becomes eligible for human review (§6), not auto-LIVE.

---

## Suggestion 5 — Wire structured H2H for real

**Goal:** make the `h2h` gate actually testable (today it's permanently `NO DATA` because
no structured H2H is collected — only free-text web snippets in `agent/research.ts`).

**Why now:** `engine/features.mjs` (`extractH2HFeatures`, `filterMeetingsByPair`) is done
and unit-tested, but `runFeatureSet` can never exercise it without a feed. Structured H2H
is a weaker prior than form (Suggestion 4), so do it after 4.

**Concrete changes:**
- **Collect** a structured H2H JSON (new `lib/h2h.mjs` or a `flashscore` H2H endpoint):
  per pair, an array of `{ date, home, away, homeScore, awayScore }`. Persist via
  `odds-data` artifact alongside `odds-db.json`.
- `loadFeatureData` in `engine/features.mjs` already loads `{ meetings, contexts }`; map
  H2H meetings into `buildFeaturesById` so `h2hPasses` gets real input.
- Add a `--features=h2h.json` CLI path (already stubbed in `backtest-harness.mjs` main:
  it imports `loadFeatureData` and calls `buildFeaturesById`). Wire the workflow
  `feature-backtest.yml` to restore an `h2h-data` artifact when available.
- `STRAT-1X2-H2HFORM-v1` moves from `BLOCKED` to `TRAINING` once data exists; ablate
  `1X2_BAND + h2h`.

**Acceptance:** `feature-backtest --features=h2h.json` shows a non-`NO DATA` `h2h` row;
if it clears the gate, eligible for review. If it doesn't, mark `REJECTED_CANDIDATE`.

---

## §6 Governance — promotion gates (unchanged, restated)

No candidate (Suggestions 3–5) is ever auto-LIVE. The path is:

1. **Train** — k-fold on history (Suggestion 1). Must show `n ≥ 30`, `ROI > HOUSE_MARGIN`
   (−7.7%), and a `normalCI` lower bound **> 0**.
2. **Frozen chronological holdout** — same gate on the most recent holdout fold.
3. **Paper** — run as `TRAINING` in `paper-B.yml` style for ≥30 resolved picks with
   positive paper ROI.
4. **Human review** — a person promotes `status` to `VALIDATED` in
   `engine/strategy-registry.json` (the single source of truth).
5. **Cutover** — only then, and only via the existing engine→money-path cutover plan in
   `AGENTS.md` ("Engine cutover plan"): parity proven (`engine/equivalence.mjs`
   `equivalenceWithStakePipeline === true`) for ≥14 days, then flip `betting.yml` to
   `approved-picks.json` behind `STAKE_AUTOPLACE_ENABLED`.

Violations: any code that promotes a strategy without steps 1–4 is a bug.

---

## §7 Sequencing / milestones

| Milestone | Suggestions | Exit criterion |
|---|---|---|
| M1 Harness trust | 1 | k-fold 1X2 ROI matches v5b; CI excludes zero |
| M2 Volume | 2 (background) | 1X2 holdout n ≥ ~200 |
| M3 Prune dead end | 3 | `STRAT-1X2-ODDSHIST-v1` → REJECTED in registry |
| M4 Real signals | 4 | `form` / `goal-total` rows exist; best clears gate → human review |
| M5 H2H | 5 | `h2h` row non-NO-DATA; clears or rejected |

Do **M1 + M3 first** (cheap, unblocks honest verdicts), then **M4** (highest value),
**M5** last. **M2** runs continuously in the background.

## Open questions for the owner
- Retention limit for the `odds-data` artifact (ToS / storage).
- Is `flashscore.ts` form/position stable enough to persist historically, or only live?
- Naming enum for rejected candidates in `strategy-registry.json` (pick `REJECTED_CANDIDATE`
  vs `ARCHIVED` and document it once).
