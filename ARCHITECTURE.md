# EnvoraSports — Architecture Review

This document answers the review questions in §60 of the specification. It
records the decisions taken in the first build, the risks found while taking
them, and what is deliberately still open.

---

## 1. Data source strategy

The specification assumes one football provider and one odds provider. In
practice the three available sources have very different shapes, and the design
follows that rather than pretending they are interchangeable.

| Source | Role | Cost | Why |
|---|---|---|---|
| **API-Football** (`v3.football.api-sports.io`) | Today's fixtures, live status, final results, match statistics, lineups, injuries | **100 requests / day** (Free) | The only source with live status and post-match statistics |
| **The Odds API** (`api.the-odds-api.com/v4`) | Today's bulletin — which markets are actually priced right now | **500 credits / month** (Free); a call costs `markets × regions` | §41: only markets present in the bulletin may be recommended |
| **football-data.co.uk** (CSV archive) | Years of historical results, statistics, and **opening + closing prices** | Unmetered | Backtesting needs closing lines; no free API provides them |

The quotas are small enough that they are architecture, not a footnote:

- `provider_request_logs` is the shared, persisted quota counter. It records
  **credits**, not row counts, because one Odds API call with 3 markets costs 3.
- `assertQuotaAvailable()` runs *before* every outbound call. A runaway loop
  cannot burn a day of football data in seconds.
- Each provider reserves a slice of its budget (`reserveRatio`) so that result
  sync and settlement can always get through even when a bulk backfill is
  running.
- `x-requests-remaining` from the provider is recorded when present; the
  provider's own count beats our arithmetic.

**Consequence to be aware of:** on the Free tier The Odds API returns only
`h2h`, `totals` and `spreads` for soccer. So today's live bulletin can support
Match Result, Over/Under and Asian Handicap. BTTS, HT/FT, Correct Score and the
rest are modelled and settled, but will only appear in coupons once a plan that
prices them is enabled. Per §40 the system does not fabricate a market the
bulletin does not contain.

### Identity reconciliation

The three sources use different ids *and* different team names ("Manchester
United" / "Man United" / "Manchester United FC"). `team_aliases` resolves a
source-specific name to a canonical team, with a `normalized` lookup column and
a `confidence` score. Matching on raw names alone silently drops fixtures, which
would quietly shrink the bulletin without any error.

---

## 2. Schema relationships

**Football core.** `leagues → seasons → matches`, with `matches` also pointing at
two `teams` (named relations `HomeTeam` / `AwayTeam`). `team_seasons` is the
many-to-many between teams and seasons, uniquely constrained on
`(team_id, season_id)`.

**Betting vocabulary.** `betting_markets → betting_selections → odds`. There are
deliberately **no** `ms1` / `over25` / `btts` columns on `matches` (§20). A new
market is a row, not a migration. Selection-specific detail lives in a JSON
`parameters` column (`{ "line": 2.5, "side": "OVER" }`, `{ "goals": 6 }`).

**Model output.** `model_versions → predictions`, with every prediction also
pinned to `match`, `market` and `selection`. `predictions` additionally stores
`odds_used` — a *snapshot* of the price, so later line movement cannot rewrite
what the model was actually offered.

**Coupons.** `coupon_generation_runs → coupons → coupon_selections →
predictions`. A system coupon extends a coupon 1:1 via `system_coupons`, which
owns `system_coupon_columns`, which own
`system_coupon_column_selections`.

**Membership.** `users → subscriptions → subscription_plans →
subscription_plan_features`. `subscription_events` is the webhook inbox with a
unique `(provider, external_event_id)` — that uniqueness *is* the idempotency
guarantee.

---

## 3. Indexes

95 indexes are generated from the schema. The ones that were reasoned about
rather than defaulted:

- `matches_awaiting_result_idx` — partial index on
  `(scheduled_kickoff_utc, result_last_synced_at)` `WHERE status IN
  (SCHEDULED, LIVE, HALF_TIME, SUSPENDED)`. This is the result-sync job's main
  query, and the partial predicate keeps it small forever while the `matches`
  table grows without bound.
- `odds_match_id_selection_id_captured_at_idx` — the append-only price history's
  read path. A separate `DESC` variant was created and then dropped: Postgres
  scans a b-tree backwards just as cheaply, and the duplicate only cost write
  throughput on the largest table.
- `odds_closing_idx` — partial, `WHERE is_closing = true`. Closing-line value is
  the primary model-evaluation metric and needs its own cheap path.
- `predictions_candidates_idx` — partial on
  `(prediction_timestamp, expected_value DESC) WHERE recommended AND PENDING`.
  This is the coupon generator's candidate pool.
- `coupons_pending_settlement_idx` / `system_columns_pending_idx` — partial on
  the unsettled rows only.
- `subscriptions_one_active_per_user_idx` — **unique** partial index enforcing
  at most one live subscription per user per provider. Without it, a duplicated
  webhook can create a second active subscription and a user ends up with two
  plans.
- `subscription_events_unprocessed_idx` — partial, drains the webhook inbox.

---

## 4. Constraints beyond Prisma

Prisma has no first-class `CHECK`, so the invariants that must never be violated
are hand-written SQL in the initial migration. The notable ones:

- `matches_distinct_teams` — a team cannot play itself.
- `matches_halftime_not_above_fulltime` — catches a whole class of provider
  parsing bugs.
- `odds_price_valid` — decimal odds are strictly `> 1`. Anything else is a parse
  error, and `1/odds` for a price of 1.0 would produce a 100% implied
  probability.
- `system_coupons_total_stake_consistent` — enforces
  `total_stake = column_count × stake_per_column` in the database, not just in
  application code (§18).
- `ccs_odds_range_ordered`, `ccs_selections_ordered` — an impossible
  configuration cannot be persisted at all (§17), independently of the Zod layer.
- `team_form_counts_consistent` — `wins + draws + losses = matches_played`.

---

## 5. Data leakage risks (§57)

This was the highest-risk area found, and the schema is shaped around it.

**The boundary.** `predictions.prediction_timestamp` is the moment the model was
allowed to see data. Every feature query filters `<= prediction_timestamp`.

**Risks identified and how each is handled:**

1. **Form snapshots.** If form were stored as a single mutable row per team,
   a backtest of a 2023 match would read 2026 form. `team_form_snapshots` is
   therefore append-only and dated, keyed
   `(team_id, snapshot_date, window, venue_scope)`.
2. **Elo.** Same failure mode. `elo_ratings` is append-only with
   `(team_id, rating_date)` unique — old ratings are never overwritten.
3. **Odds.** Overwriting a price destroys line-movement history and lets a
   backtest bet into a price that did not exist yet. `odds` is append-only; an
   "update" is a new row.
4. **Lineups.** A confirmed lineup published at 18:00 must not inform a 10:00
   prediction. `lineups.published_at` exists specifically so backtests can
   exclude rows published after the cutoff, and `lineup_type` distinguishes
   confirmed / predicted / unavailable.
5. **Injuries.** `injuries.source_updated_at` is the provider's publication
   time, kept separate from our `fetched_at`.
6. **Settlement writing back onto predictions.** Settlement appends
   `status`, `settled_at` and `settlement_snapshot`; it never touches
   `probability`, `odds_used`, `edge` or `expected_value` (§41).
7. **Kickoff timezones.** football-data.co.uk publishes UK local time with no
   offset. Storing that as UTC shifts every summer fixture by an hour, which
   corrupts "which matches finished before time T". `ukLocalToUtc()` converts
   via the real `Europe/London` offset, and this is covered by a DST test.
8. **Backtest train/test splits.** `backtests.walk_forward_plan` stores explicit
   chronological folds; `backtest_predictions.knowledge_cutoff` records the
   cutoff each row was produced under. Random splits are not representable.

---

## 6. Duplication review

Deliberate denormalisation, with the reason:

- `coupon_selections` copies `market_code`, `selection_code`, `odds`,
  `probability`, `edge`, `expected_value` from the prediction. This is
  intentional: a historical coupon must render exactly as generated even if a
  market is later renamed or deactivated (§41).
- `daily_statistics` is a reporting rollup, fully rebuildable from source tables.
- `head_to_head` duplicates data derivable from `matches`. It is kept as a
  materialised helper with `UNIQUE(match_id)` so it cannot drift into
  double-counting.

Rejected duplication: derived values such as `total_goals`, `result` and `btts`
are **not** stored on `matches` (§11). They are cheap to compute and a stored
copy is one more thing that can disagree with the score.

---

## 7. Entities added beyond the specification's list

| Table | Why it was needed |
|---|---|
| `team_aliases` | Three sources, three naming conventions (§1 above) |
| `match_result_snapshots` | §37 audit trail of what the provider actually said |
| `coupon_generation_runs` | §30.7 requires recording *why* a category produced fewer coupons than requested |
| `settings_snapshots` | §41 reproducibility: a coupon points at the exact configuration that produced it |
| `settings_audit_logs` | §24 requires configuration changes to be audited |
| `market_correlations` | §33's rule-based matrix, replaceable by a fitted model |
| `job_runs`, `job_locks` | §38 idempotent, retryable, singly-executed jobs |
| `provider_request_logs` | Quota enforcement and the §39 admin monitor |
| `translations` | Localized overrides for provider-sourced names |
| `sessions` | Auth was implied by §16 but had no table |
| `daily_statistics` | §40 reporting |
| `invoices` | §16 optional billing history |

---

## 8. Bilingual design (EN source, TR secondary)

English is the source language and the product default, served **without** a
prefix (`/matches`); Turkish is prefixed (`/tr/matches`). `next-intl` with
`localePrefix: 'as-needed'` implements this, and `/en` 307-redirects to `/`.

The split that matters:

- **Static vocabulary** — UI copy, market names, selection names, statuses,
  plan descriptions — lives in `src/i18n/messages/{en,tr}.json`, keyed by the
  same codes the database uses. `selections.OVER` takes a `{line}` parameter, so
  "Over 2.5" / "2.5 üstü" comes from one entry rather than 12.
- **Provider-sourced text** — league, team and venue names — is stored as the
  provider gives it, with optional overrides in the `translations` table.

Number and date formatting is locale-aware (`tr-TR` uses a comma decimal
separator, which matters for odds: `2,45` vs `2.45`).

A missing translation logs a warning and falls back to the key rather than
blanking the page.

---

## 9. Where Gemini fits

Narration only. `predictions.breakdown` holds the real, computed features; the
narration layer turns that JSON into readable EN/TR prose. It is never allowed
to produce a probability, a price or a reason of its own — §48 says explanations
must be derived, not fabricated. `NARRATION_PROVIDER=none` falls back to
deterministic template sentences, and nothing downstream depends on the LLM.

---

## 10. Proposed improvements to the specification

1. **§45 vs §29 route conflict.** §45 specifies `/coupons`; §29 says
   customer-facing copy should say "Predictions", not "Coupons". URLs are
   customer-facing. Routes use `/predictions` and `/systems`; category is a
   query parameter rather than a separate path, so a new category needs no new
   route.
2. **"Banko" (§2) vs §28.** §28 removes gambling-centric wording. `HIGH_CONFIDENCE`
   is the internal enum and "High Confidence" / "Yüksek Güven" the label; "Banko"
   appears nowhere in the UI.
3. **Fixed 5+5+5 (§28) vs fully dynamic counts (§30).** §30 supersedes. There is
   no hard-coded count anywhere; `coupon_category_settings.coupon_count` is read
   at generation time.
4. **Asian handicap quarter lines.** Not mentioned in the market list, but The
   Odds API returns them. Settling `-0.75` as a plain win/loss misprices real
   money, so half-win/half-loss is implemented and tested.
5. **Void handling in accumulators.** §33 says "normally remove/neutralize".
   This is an explicit setting (`settlement.voidHandling`) rather than an
   implicit rule, and settlement is versioned so history is never silently
   re-graded.

---

---

## 12. Publication schedule and coverage windows

The system does not run daily. It runs on **publication days** and prepares a
forward window of match days:

- Monday → Tuesday, Wednesday, Thursday
- Thursday → Friday, Saturday, Sunday

Both follow one rule: a publication covers the next `coverageDays` days starting
`coverageOffsetDays` later. Weekday, offset, length, publish time, timezone and
grouping are all stored in `bulletin_schedule_settings` and editable from
`/admin/settings/schedule`.

**Timezone matters here.** "Thursday" is a local weekday; a 01:00 Monday kickoff
in Istanbul is 22:00 Sunday UTC. Bucketing by UTC date would file that match
under the wrong day and drop it from coverage. Every schedule decision goes
through `Europe/Istanbul` (configurable), and `zonedTimeToUtc` does a two-pass
offset resolution so DST boundaries do not shift a publication by an hour.

**Known gap in the configured schedule:** publishing Monday and Thursday with a
3-day forward window never covers **Monday's own matches** — Monday's window
starts Tuesday and Thursday's ends Sunday. `uncoveredWeekdays()` detects this,
it is tested, and the admin dashboard shows it as a warning. Setting the offset
to 0 with a 4-day window closes it.

Reporting is weekly (Monday–Sunday), because a Monday and a Thursday publication
together cover one week of football.

---

## 13. Ingestion and settlement

Five jobs, all through one `runJob` path that supplies a database lock, a
`JobRun` record and an idempotency key:

| Job | When | Cost |
|---|---|---|
| `bulletin-publication` | publication days only | ~4 football requests + 3 credits per competition |
| `fixture-topup` | daily | up to 4 football requests |
| `result-sync` | frequently; self-throttles per match | 1 request per 20 matches, only when due |
| `settlement` | frequently | none |
| `historical-import` | on demand | none (unmetered) |

`POST /api/jobs/<name>` triggers any of them, bearer-authenticated with
`JOB_TRIGGER_SECRET`, so Vercel Cron, GitHub Actions or an external scheduler
all work. A non-publication day returns `SKIPPED` with a reason and spends
nothing.

**Result polling follows the match, not the clock.** Rare far from kickoff
(180 min), tighter approaching it (30), frequent in play (15), and persistent
after full time (20) until the provider confirms `FINISHED`. A match is never
settled because time passed — only because the provider said so.

**Settlement chain:** confirmed result → `settleMatchPredictions` →
`settleCoupons` → `settleSystemCoupons`. It only moves rows out of `PENDING`, so
running it twice is a no-op. Accumulator legs use a settlement multiplier rather
than a binary win/loss, because a quarter-line Asian handicap really does half
win: `HALF_WON` returns `(odds + 1) / 2`, a void leg returns `1` (neutralised),
and any loss zeroes the coupon.

---

## 14. Access model

Four states, all decided server-side:

| Viewer | Sees |
|---|---|
| Admin | every category, unlocked |
| Member | every category their plan covers |
| Visitor | the first 2 coupons of High Confidence, in full |
| Visitor, other categories | count, odds band and best possible return only |

The free preview count and category are settings (`access.freePreviewCount`,
`access.freePreviewCategory`), not constants.

The locked panel's blurred rows are **placeholders, not hidden content**. The
query for a locked category selects `totalOdds` and `selectionCount` and nothing
else — no selections, no per-leg odds, no match identities ever enter the
payload. There is nothing in the HTML for a reader to recover, which is what
§23 requires and what a CSS blur over real data would not give.

---

## 15. Provider limitations found in practice

These were discovered by running the pipeline against the live APIs, not
assumed:

1. **API-Football Free restricts the fixture date range** to roughly ±1 day of
   today ("try from 2026-09-03 to 2026-09-05"). A Thursday publication therefore
   cannot see Sunday's fixtures yet. The publication run defers days it cannot
   fetch instead of failing, and `fixture-topup` fills them in as they come into
   range. **A paid plan removes this**; on Free the far end of every window
   arrives late.
2. **The Odds API Free serves only `h2h`, `totals` and `spreads`** for soccer.
   So live bulletins support Match Result, Over/Under and Asian Handicap. BTTS,
   HT/FT, Correct Score and the rest are modelled, seeded and settled, but will
   not appear in a coupon until a plan that prices them is enabled — §40
   forbids fabricating a market the bulletin does not contain.
3. **Cross-provider name matching has a residual gap.** "Sporting Lisbon" vs
   "Sporting CP" scores 0.67 against a 0.80 threshold, so the event is left
   unmatched rather than merged. This is deliberate: a wrong merge corrupts a
   team's entire history, and the `team_aliases` table exists so an operator can
   resolve these cases once.
4. **Custom non-partial indexes do not survive `prisma migrate diff`.** Prisma
   proposes dropping any plain index it does not own. Partial indexes (with a
   `WHERE`) are ignored and are safe; that is why the hand-written ones are all
   partial.

---

## 16. Live verification

Run against the real providers and database on 2026-09-04:

- League mapping: 16/16 resolved to API-Football ids (Süper Lig 203, Super
  League 197, La Liga 2 141 needed explicit name/country overrides)
- Publication run: 1994 fixtures seen, 59 matches ingested into tracked leagues,
  0 unresolved teams; 6 competitions priced, 1595 prices stored, 18 credits
  spent — exactly `6 × 3 markets × 1 region`
- Historical import: **5,966 matches, 228,730 price rows** across 16 divisions
  and 2 seasons, with opening and closing lines
- Result sync: 60 candidates, 0 requests spent — the throttle correctly declined
  to poll matches that are not due
- Idempotency: a repeated job returned `SKIPPED: already_completed`
- Auth: `/admin` is 404 for anonymous, 200 for the admin session
- Both locales render every page

The batched rewrite of the historical importer took a season from minutes to
~8 seconds; the original issued about six round trips per fixture.


---

## 18. Prediction engine

Four models, one blended output. Every model emits the same shape — a
probability per selection code — so adding one is additive.

| Model | Basis | Unavailable when |
|---|---|---|
| **Elo** | rating gap + home advantage; draw share shrinks as the gap widens | neither side has a rated history |
| **Poisson** | attack/defence strengths vs the league baseline, shrunk toward 1 on small samples | no finished matches |
| **Form** | weighted points-per-game over 5/10/20-match windows, split by venue | fewer than 3 recent matches |
| **xG** | expected goals for and against | **no xG in the source** — which is most of the archive |

Two properties are load-bearing:

**Unavailable models do not vote.** When xG is missing its weight is
redistributed across the models that ran. Treating absence as 0.5, or as a zero
vote, would bias every market. A test asserts that removing an agreeing model
does not move the answer.

**Markets are derived from one joint score distribution, not guessed
separately.** Over 2.5 can never come out below Over 3.5, 1X2 always sums to 1,
and double chance is literally the union of its outcomes — because they are all
marginals of the same matrix. HT/FT is a real joint calculation over two half
distributions, so "1/2" is the actual probability of leading at the break and
losing.

The ensemble reports **model agreement**, which feeds confidence upward and risk
downward.

---

## 19. What the first backtest found

The walk-forward runner grades the model against the opening prices it could
have taken, using only features dated before a cutoff two hours prior to
kickoff. On 500 matches of the 2025/26 second half:

| minProbability | bets | hit rate | avg odds | ROI |
|---:|---:|---:|---:|---:|
| 0.05 | 681 | 32.4% | 4.35 | **−3.75%** |
| 0.15 | 666 | 33.0% | 4.07 | −5.48% |
| 0.25 | 536 | 38.3% | 3.06 | −0.92% |
| 0.35 | 378 | 45.4% | 2.33 | **+1.90%** |
| 0.55 | 165 | 55.1% | 1.90 | +5.10% |

The calibration curve explains it: at a predicted 17% the model observed 7.6%;
at a predicted 64% it observed 53%. **It is systematically overconfident, and
worst on longshots** — which is exactly where it was betting hardest.

Two changes came out of this, both recorded rather than quietly tuned:

1. **A market prior.** Model probabilities are blended toward the vig-free
   market price before edge and EV are computed. It improved calibration
   (Brier 0.2112 → 0.1995) but *worsened* ROI at the low end, because it removes
   the disagreements that generate edge. It is configurable
   (`marketPriorWeight`, default 0.35) and the trade-off is real, not settled.
2. **A probability floor.** `prediction.minProbability` defaults to 0.25 and
   High Value's per-leg floor moved from 0.05 to 0.25. The threshold sits where
   the calibration error stops dominating — a mechanism-based reason — not at
   the best-looking ROI bucket, which would be fitting to one sample.

**Caveat, stated plainly:** 500 matches and a few hundred bets is a small
sample. The +5.10% at the top is well inside noise. What is trustworthy is the
*direction*, consistent across four consecutive thresholds, and the calibration
gap, which is large and structural.

---

## 20. Narration, and why a prompt is not a guarantee

Gemini writes the match analysis. It is given a structured payload of
already-computed figures and nothing else, and it fills a schema rather than
writing free prose.

The specification says never to invent a statistic. A system prompt asking
nicely is not a control, so there are three mechanical ones:

1. **Schema validation.** A response that does not parse is discarded.
2. **Grounding check.** Every number in the output is compared against every
   number the payload contained (including percentage and Turkish-comma forms,
   and the `OVER_2_5` line encoding). A figure that is not there is an
   invention, and the narration is rejected. *This fired on the first live
   call.*
3. **Banned-language check**, which understands negation — "predictions are not
   guarantees of outcome" is the disclaimer §29 mandates, and a naive substring
   match would have banned the required sentence.

Anything that fails falls back to a deterministic template that is itself
tested against all three guards. `NARRATION_PROVIDER=none` disables the model
entirely and the product still reads sensibly.

**Provider reality:** `gemini-2.5-flash` appears in the model list but returns
404 for new accounts; `gemini-3.6-flash` works. The free tier rate-limits per
minute, so narration is generated by a paced background job into a cache rather
than on page render.

---

## 21. Status

**Done and verified**

- 48 tables, 4 migrations, hand-written CHECK constraints
- Publication schedule with coverage windows, weekly reporting, gap detection
- Seven jobs: locked, idempotent, quota-aware, retryable
- Three provider adapters plus offline mocks, behind one set of interfaces
- **22,602 matches and ~980,000 price rows** ingested across 16 divisions and
  5 seasons, with opening and closing lines
- Feature engineering: append-only Elo (33,444 dated ratings) and windowed,
  venue-split form
- Four models plus a weighted ensemble with unavailability handling and a
  model-agreement score
- Market-prior calibration, applied identically in the live engine and backtest
- Coupon generator: candidate filtering, six diversification strategies,
  correlation-aware assembly, shortfall reporting, system coupons
- Walk-forward backtest with ROI, drawdown, Brier, log loss and calibration
- Settlement evaluators for all 13 markets, quarter-line handicaps included
- Entitlement engine: admin / member / free preview / locked, enforced in the query
- Auth with scrypt passwords and hashed sessions; admin panel with settings
  forms, validation, audit logging, quota meters and manual triggers
- Grounded narration with three mechanical anti-hallucination guards
- Match analysis page with per-model breakdown, in both locales
- 231 tests passing; typecheck and lint clean

**Not yet built**

- The Football Context Engine layer (injuries, lineups, squad strength,
  fatigue, motivation, tactical matchup)
- Stripe billing (the abstraction and schema exist; `BILLING_PROVIDER=none`)
- Team pages and the public backtest detail view
- Model recalibration from backtest output (currently a manual threshold)
