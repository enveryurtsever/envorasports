# ENVORAIBET — Football Betting Analytics & Coupon Engine

## 1. PROJECT OVERVIEW

Project name: **EnvoraSports**

EnvoraSports is a football betting analytics platform built with Next.js, TypeScript and PostgreSQL.

The primary purpose is NOT to build a generic football statistics website.

The primary purpose is:

> Take the available football bulletin/matches and betting markets, analyze them using historical and current football data, calculate probabilities and expected value, rank selections, and automatically generate 15 statistical coupon recommendations.

Every day the system should automatically generate:

- 5 High Confidence coupons
- 5 Medium Odds coupons
- 5 High Odds coupons

Total: **15 coupons**

The system should analyze as many available betting markets as the selected providers support, including:

- Match Result
- Double Chance
- Over/Under
- BTTS
- Half Time Result
- Half Time / Full Time
- Goal Ranges
- 6+ Goals
- Correct Score
- Asian Handicap
- Team Goals
- Corners
- Cards
- Other supported markets

The architecture must allow new markets to be added without redesigning the database.

---

## 2. PRODUCT PRINCIPLE

EnvoraSports is a **probability and analytics system**.

It must NEVER claim that a bet is guaranteed.

Never use:

- Guaranteed
- 100% guaranteed
- Certain win
- Sure bet
- Guaranteed coupon

Use:

- High Confidence
- Model Probability
- Statistical Edge
- Positive EV
- Value Selection
- Risk Score

"Banko" may be used internally/user-facing as a category, but the system must never imply certainty.

---

## 3. TECHNOLOGY STACK

Use:

- Next.js
- TypeScript
- React
- Tailwind CSS
- PostgreSQL
- Prisma ORM
- Zod
- ESLint
- Prettier

Use **Next.js App Router**.

Use Server Components where appropriate.

Use Route Handlers and/or Server Actions for backend functionality.

Do not put business logic inside React components.

Prediction logic must be independent from UI.

External APIs must be accessed through provider abstractions.

---

## 4. DATABASE

The developer will manually create the PostgreSQL database.

Claude must NOT create the PostgreSQL server/database itself.

Recommended database name:

`envoraibet`

Claude is responsible for:

- Prisma schema
- migrations
- indexes
- foreign keys
- unique constraints
- check constraints where appropriate
- seed scripts
- database access layer
- database queries

The system must support:

- several years of historical data
- millions of odds records
- millions of prediction records
- large backtesting datasets

Do not design the schema only for today's matches.

---

## 5. DATABASE DESIGN PRINCIPLES

Historical data should be preserved.

Do not overwrite:

- historical odds
- historical predictions
- historical Elo ratings
- historical team-form snapshots
- model versions

Every externally sourced record should preserve:

- external ID
- source
- fetched_at
- updated_at

Use proper indexes because odds and prediction tables can become very large.

Use foreign keys and appropriate cascading rules.

Avoid unnecessary duplication.

---

## 6. REQUIRED DATABASE TABLES

At minimum create:

- leagues
- seasons
- teams
- team_seasons
- matches
- match_statistics
- team_form_snapshots
- elo_ratings
- head_to_head
- players
- injuries
- lineups
- bookmakers
- betting_markets
- betting_selections
- odds
- model_versions
- predictions
- coupons
- coupon_selections
- backtests
- backtest_predictions

Additional tables may be added when technically justified.

---

## 7. LEAGUES

Table: `leagues`

Fields should include:

- id
- external_id
- name
- country
- type
- logo
- active
- created_at
- updated_at

Add unique constraints where appropriate.

---

## 8. SEASONS

Table: `seasons`

Fields:

- id
- league_id
- external_id
- name
- start_date
- end_date
- current
- created_at
- updated_at

Relationship:

`league -> seasons`

---

## 9. TEAMS

Table: `teams`

Fields:

- id
- external_id
- name
- short_name
- country
- logo
- active
- created_at
- updated_at

Do not assume team names are globally unique unless the provider guarantees this.

External IDs should be preferred for synchronization.

---

## 10. TEAM SEASONS

Table: `team_seasons`

Relationship:

`team <-> season`

Fields:

- id
- team_id
- season_id
- created_at

Use a unique constraint on:

`team_id + season_id`

---

## 11. MATCHES

Table: `matches`

Required fields:

- id
- external_id
- league_id
- season_id
- home_team_id
- away_team_id
- match_date
- status
- venue
- referee
- home_score
- away_score
- home_half_score
- away_half_score
- created_at
- updated_at

Match status must support at least:

- SCHEDULED
- LIVE
- FINISHED
- POSTPONED
- CANCELLED
- SUSPENDED

Derived values such as total_goals, result, BTTS and goal ranges should generally be calculated rather than duplicated unless there is a strong performance reason.

---

## 12. MATCH STATISTICS

Table: `match_statistics`

Fields may include:

- id
- match_id
- team_id
- possession
- shots
- shots_on_target
- shots_off_target
- blocked_shots
- corners
- fouls
- offsides
- yellow_cards
- red_cards
- saves
- passes
- pass_accuracy
- expected_goals
- expected_goals_against
- created_at
- updated_at

The architecture must support additional provider statistics later.

Do not assume every league provides xG.

Missing data must be handled gracefully.

---

## 13. TEAM FORM

Table: `team_form_snapshots`

Store historical team form as of a particular date.

Fields:

- id
- team_id
- snapshot_date
- matches_played
- wins
- draws
- losses
- goals_for
- goals_against
- average_goals_for
- average_goals_against
- average_xg
- average_xga
- clean_sheet_rate
- btts_rate
- over_1_5_rate
- over_2_5_rate
- over_3_5_rate
- home_wins
- home_draws
- home_losses
- away_wins
- away_draws
- away_losses
- created_at

The system should calculate:

- last 5
- last 10
- last 20
- season-to-date
- home-only
- away-only

Do not hard-code only "last 5".

---

## 14. ELO

Table: `elo_ratings`

Fields:

- id
- team_id
- league_id
- rating
- rating_date
- matches_played
- home_rating
- away_rating
- created_at

Historical ratings must be preserved.

Do not overwrite old Elo values.

---

## 15. H2H

Table: `head_to_head`

Fields:

- id
- home_team_id
- away_team_id
- match_id
- match_date
- home_score
- away_score
- result

H2H statistics should preferably be derived from historical matches.

---

## 16. PLAYERS

Table: `players`

Fields:

- id
- external_id
- team_id
- name
- position
- nationality
- active
- created_at
- updated_at

---

## 17. INJURIES

Table: `injuries`

Fields:

- id
- player_id
- team_id
- status
- reason
- start_date
- expected_return
- source_updated_at
- created_at
- updated_at

Predictions can use injury information when available.

Never assume injury data is complete.

---

## 18. LINEUPS

Table: `lineups`

Fields:

- id
- match_id
- team_id
- player_id
- starter
- position
- shirt_number
- created_at

The system must distinguish when possible between:

- confirmed lineup
- predicted lineup
- unavailable lineup information

Do not use future confirmed information in historical backtesting if it would not have been available at prediction time.

---

## 19. BOOKMAKERS

Table: `bookmakers`

Fields:

- id
- external_id
- name
- country
- active
- created_at
- updated_at

The system must support multiple bookmakers.

---

## 20. BETTING MARKETS

This is one of the most important parts of the database.

DO NOT create fixed columns in `matches` such as:

- ms1
- msx
- ms2
- over25
- btts

Instead use:

- `betting_markets`
- `betting_selections`

Table: `betting_markets`

Fields:

- id
- code
- name
- category
- description
- active
- created_at
- updated_at

Examples:

- MATCH_RESULT
- DOUBLE_CHANCE
- OVER_UNDER
- BTTS
- HALF_TIME_RESULT
- HALF_TIME_FULL_TIME
- TEAM_TOTAL
- GOAL_RANGE
- CORRECT_SCORE
- ASIAN_HANDICAP
- CORNERS
- CARDS

---

## 21. BETTING SELECTIONS

Table: `betting_selections`

Fields:

- id
- market_id
- code
- name
- description
- parameters
- active
- created_at
- updated_at

Examples:

- MS_1
- MS_X
- MS_2
- DOUBLE_CHANCE_1X
- DOUBLE_CHANCE_X2
- DOUBLE_CHANCE_12
- OVER_1_5
- OVER_2_5
- OVER_3_5
- OVER_4_5
- OVER_5_5
- UNDER_1_5
- UNDER_2_5
- UNDER_3_5
- UNDER_4_5
- GOAL_6_PLUS
- BTTS_YES
- BTTS_NO
- HT_1
- HT_X
- HT_2
- HTFT_1_1
- HTFT_1_X
- HTFT_1_2
- HTFT_X_1
- HTFT_X_X
- HTFT_X_2
- HTFT_2_1
- HTFT_2_X
- HTFT_2_2

Use JSON parameters for flexible markets.

Example:

```json
{
  "goals": 6
}
```

for 6+ Goals.

---

## 22. ODDS

Table: `odds`

Fields:

- id
- match_id
- bookmaker_id
- market_id
- selection_id
- odds
- handicap
- captured_at
- source
- is_opening
- is_closing
- created_at

IMPORTANT:

Never overwrite historical odds.

Every meaningful odds update should create a historical record.

This is required for:

- line movement analysis
- backtesting
- closing line comparison
- model evaluation

---

## 23. MODEL VERSIONS

Table: `model_versions`

Fields:

- id
- name
- version
- description
- configuration
- active
- created_at

Every prediction must reference the model version used.

Examples:

- ensemble-v1
- ensemble-v2
- poisson-v1
- xg-v1

---

## 24. PREDICTIONS

Table: `predictions`

Fields:

- id
- match_id
- market_id
- selection_id
- model_version_id
- probability
- implied_probability
- edge
- expected_value
- confidence_score
- risk_score
- data_quality_score
- recommended
- prediction_timestamp
- created_at

Probability values must be between 0 and 1.

---

## 25. PROBABILITY CALCULATIONS

For decimal odds:

`implied_probability = 1 / odds`

Example:

Odds = 2.00

Implied probability = 0.50

Edge:

`edge = model_probability - implied_probability`

Expected value:

`EV = (model_probability * odds) - 1`

Example:

Model probability = 0.57

Odds = 2.00

EV = 0.14

Positive EV does not automatically mean a selection should be included.

Also consider:

- model confidence
- sample size
- data quality
- market reliability
- bookmaker quality
- correlation
- volatility

---

## 26. PREDICTION ENGINE

Implement multiple models.

### Elo Model

Use:

- home Elo
- away Elo
- home advantage

### Poisson Model

Use:

- attack strength
- defense strength
- home advantage
- goals
- xG where available

Generate probabilities for:

- 1X2
- total goals
- goal ranges
- BTTS
- selected score ranges
- HT/FT where mathematically appropriate

### Form Model

Use:

- last 5
- last 10
- last 20
- home form
- away form
- goals
- xG
- xGA
- clean sheets
- BTTS

### Ensemble

Combine multiple model outputs.

Initial configurable weighting:

- Elo: 20%
- Poisson: 40%
- Form: 20%
- xG: 20%

These are initial defaults only.

Do not hard-code weights throughout the application.

---

## 27. HIGH-ODDS MARKETS

The system must support high-risk/high-odds markets such as:

- HT/FT 1/2
- HT/FT 2/1
- 6+ Goals
- 7+ Goals
- Correct Score
- High Goal Range
- Aggressive Asian Handicap

High odds alone does NOT make a selection good.

The model must evaluate:

- probability
- odds
- implied probability
- edge
- EV
- confidence
- risk

Example:

Odds = 18.00

Implied probability = 5.56%

Model probability = 7.10%

This can be a value candidate.

If model probability is 2.1% against 5.56% implied probability, it is normally negative value and should be rejected.

---

## 28. COUPON GENERATOR

The main feature of EnvoraSports.

Automatically generate:

- 5 HIGH CONFIDENCE coupons
- 5 MEDIUM ODDS coupons
- 5 HIGH ODDS coupons

Total: **15 coupons**

Every generated coupon must be stored.

---

## 29. HIGH CONFIDENCE COUPONS

Generate 5 coupons.

Prioritize:

- high probability
- lower variance
- good data quality
- reasonable odds
- statistical consistency

Potential markets:

- Double Chance
- Over 1.5
- Under 4.5
- Conservative Team Goals
- High Probability BTTS

Do not force every market into coupons.

---

## 30. MEDIUM ODDS COUPONS

Generate 5 coupons.

Default target:

`2.50 - 6.00`

This range must be configurable.

Balance:

`probability + EV + total odds - risk - correlation`

Do not simply select the highest odds.

---

## 31. HIGH ODDS COUPONS

Generate 5 coupons.

Default target:

`8.00+`

This threshold must be configurable.

Potential markets:

- HT/FT
- 1/2
- 2/1
- 6+ Goals
- Correct Score
- High Goal Totals
- Aggressive Handicap

High odds coupons should still prioritize positive statistical value.

Do not create completely random lottery coupons.

---

## 32. COUPON DIVERSIFICATION

The 5 coupons in each category must be meaningfully different.

Do not generate five copies of the same coupon.

Possible strategies:

- Coupon 1: highest EV
- Coupon 2: highest confidence
- Coupon 3: balanced risk
- Coupon 4: alternative match combinations
- Coupon 5: alternative market combinations

Default rule:

`maximum 1 selection per match`

This prevents artificially inflating coupons using multiple highly correlated markets from the same match.

Make this configurable.

---

## 33. CORRELATION

The coupon engine must recognize correlated selections.

Examples:

- Team Win + Team -1 Handicap
- Over 2.5 + 6+ Goals

Do not assume selections are independent.

Initially implement a configurable rule-based correlation matrix.

Later this can be replaced with a statistical correlation model.

---

## 34. COUPON SCORE

Each coupon should receive a score.

Conceptually:

`coupon_score = probability_score + value_score + confidence_score + diversification_score - correlation_penalty - risk_penalty`

Exact weights must be configurable.

Do not scatter magic numbers throughout the codebase.

---

## 35. COUPON TABLES

Create:

- `coupons`
- `coupon_selections`

Coupons should store:

- type
- name
- total_odds
- estimated_probability
- expected_value
- confidence_score
- risk_score
- score
- generation_timestamp
- model_version_id

Coupon selections should store:

- coupon_id
- prediction_id
- match_id
- market
- selection
- odds
- probability
- EV
- order

Historical generated coupons must remain available.

---

## 36. BACKTESTING

Backtesting is a core feature.

The system must answer:

> If EnvoraSports had generated these predictions and coupons in the past using only information available at that time, how would they have performed?

Track:

- Total Bets
- Winning Bets
- Losing Bets
- Hit Rate
- Accuracy
- Average Odds
- Average Probability
- Average Edge
- ROI
- Profit
- Maximum Drawdown
- Brier Score
- Log Loss

---

## 37. WALK-FORWARD BACKTESTING

Do NOT use random train/test splits for time-series betting data.

Use chronological walk-forward evaluation.

Example:

Train 2022 -> Test 2023

Train 2022-2023 -> Test 2024

Train 2022-2024 -> Test 2025

Never allow future information into past predictions.

---

## 38. BACKTEST SNAPSHOTS

When running a backtest, record the exact information available at prediction time.

A historical prediction must not use:

- final match result
- post-match statistics
- future odds
- future injuries
- future lineups
- future matches
- future model information

This rule is mandatory.

---

## 39. API ARCHITECTURE

Do not tightly couple EnvoraSports to one external provider.

Create interfaces.

Example:

```typescript
interface FootballDataProvider {
  getLeagues(): Promise<League[]>
  getSeasons(leagueId: string): Promise<Season[]>
  getTeams(leagueId: string, season: string): Promise<Team[]>
  getFixtures(date: Date): Promise<Fixture[]>
  getTeamStatistics(teamId: string, season: string): Promise<TeamStatistics>
  getMatchStatistics(matchId: string): Promise<MatchStatistics>
  getHeadToHead(homeId: string, awayId: string): Promise<Match[]>
  getLineups(matchId: string): Promise<Lineup[]>
  getInjuries(matchId: string): Promise<Injury[]>
}
```

Odds provider:

```typescript
interface OddsProvider {
  getOdds(matchId: string): Promise<Odds[]>
}
```

This allows providers to be replaced later.

---

## 40. API DATA REQUIREMENTS

Football provider should ideally provide:

- fixtures
- historical matches
- teams
- leagues
- seasons
- standings
- team statistics
- match statistics
- H2H
- xG
- lineups
- injuries

Odds provider should ideally provide:

- bookmaker
- market
- selection
- odds
- handicap
- timestamp
- opening odds
- current odds
- closing odds where available

If a provider does not support a required market, do not fake the market.

---

## 41. BULLETIN SUPPORT

The core objective is to analyze the available betting bulletin.

Separate:

- football data
- available betting markets/odds

The football provider tells us match and statistics.

The odds/bulletin provider tells us what markets and prices are actually available.

Only markets actually available in the current bulletin should be eligible for coupon generation.

Do not generate a recommendation for an unavailable market.

---

## 42. DATA INGESTION JOBS

Create a job/service architecture.

Potential schedules:

- Daily: fetch fixtures
- Every 15-30 minutes: update upcoming odds
- After matches: fetch final results
- After matches: fetch statistics
- Daily: update team form
- Daily: update Elo
- Daily: generate predictions
- Daily: generate coupons

Do not hard-code scheduling to a single hosting provider.

The architecture should work with:

- Vercel Cron
- external cron
- GitHub Actions
- queue systems
- other schedulers

---

## 43. ERROR HANDLING

External API requests must support:

- timeout
- retry
- rate-limit handling
- logging
- graceful failure

One API failure must not crash the entire application.

Handle:

- postponed matches
- cancelled matches
- missing statistics
- missing odds
- duplicate fixtures
- changed fixture times
- invalid odds
- API outages
- rate limits

---

## 44. DATA QUALITY

Every prediction should have a data-quality assessment.

Possible factors:

- historical sample size
- xG availability
- injury availability
- lineup availability
- odds availability
- recent match count
- league data quality
- data freshness

A prediction based on poor data should receive a lower confidence score.

Do not pretend missing data exists.

---

## 45. MAIN APPLICATION ROUTES

Create:

`/` — Dashboard

`/matches` — Today's matches

`/matches/[id]` — Detailed match analysis

`/coupons` — 15 generated coupons

`/coupons/[id]` — Coupon details

`/teams` — Teams

`/teams/[id]` — Team analysis

`/predictions` — All model predictions

`/backtest` — Backtesting dashboard

`/settings` — System/model configuration

---

## 46. DASHBOARD

Main dashboard should show:

- EnvoraSports
- Today's Bulletin
- Matches
- Markets analyzed
- Value opportunities
- High Confidence: 5 coupons
- Medium Odds: 5 coupons
- High Odds: 5 coupons

Each selection should display:

- Match
- Market
- Selection
- Odds
- Model Probability
- Implied Probability
- Edge
- EV
- Confidence
- Risk

---

## 47. MATCH ANALYSIS PAGE

Example structure:

```text
Barcelona
vs
Real Madrid

MATCH PROBABILITY

Barcelona       48%
Draw            27%
Real Madrid     25%

GOALS

Over 1.5        82%
Over 2.5        61%
Over 3.5        39%
Over 4.5        22%
5+              12%
6+               7%

BTTS

Yes             59%
No              41%

HALF TIME / FULL TIME

1/1              28%
1/X               8%
1/2               4%
X/1              17%
X/X               9%
X/2               7%
2/1               5%
2/X               6%
2/2              16%
```

These are examples only.

Never hard-code them.

All values must come from the prediction engine.

---

## 48. SELECTION DETAIL

When a user opens a selection, show:

- Selection
- Odds
- Model Probability
- Implied Probability
- Edge
- Expected Value
- Confidence
- Risk

Also show a model explanation based on actual features.

Example:

- recent form
- home/away performance
- xG trend
- injury impact
- H2H
- odds value

Do not fabricate reasons.

---

## 49. UI DESIGN

Create a modern sports analytics interface.

Requirements:

- mobile-first
- responsive
- fast
- clean
- readable
- modern
- light/dark compatible
- cards for recommendations
- tables for detailed statistics
- clear probability/risk indicators

Avoid excessive animations.

The interface should feel like a professional sports analytics product rather than a casino website.

---

## 50. SECURITY

Never expose:

- database credentials
- API keys
- secrets

Use environment variables.

Example:

```env
DATABASE_URL=

FOOTBALL_API_KEY=
FOOTBALL_API_BASE_URL=

ODDS_API_KEY=
ODDS_API_BASE_URL=

NEXT_PUBLIC_APP_URL=
```

Only variables explicitly prefixed with `NEXT_PUBLIC_` may be exposed to the browser.

Never commit secrets.

---

## 51. VALIDATION

Use Zod for:

- API responses where practical
- user input
- configuration
- coupon generation parameters
- backtest parameters

Do not trust external API responses blindly.

---

## 52. TYPESCRIPT RULES

Use strict TypeScript.

Avoid `any` unless absolutely necessary.

Use:

- explicit types
- interfaces
- enums where appropriate
- discriminated unions where useful
- reusable services
- clear domain models

Business logic must not be duplicated.

---

## 53. PROJECT STRUCTURE

Use a clean structure similar to:

```text
src/
  app/
    page.tsx
    matches/
    coupons/
    teams/
    predictions/
    backtest/
    settings/
    api/

  components/
    dashboard/
    matches/
    coupons/
    teams/
    charts/
    ui/

  lib/
    db/
    providers/
    football/
    odds/
    predictions/
    models/
    value/
    coupons/
    backtest/
    validation/
    logging/

  services/
    data-ingestion/
    prediction/
    coupon-generation/
    backtesting/

  types/

prisma/
  schema.prisma
  migrations/
  seed.ts
```

Adjust if a better architecture is justified.

---

## 54. CONFIGURATION

Centralize:

- model weights
- minimum EV
- minimum probability
- confidence thresholds
- coupon target odds
- correlation penalties
- maximum selections
- data freshness requirements

Do not scatter configuration values throughout the codebase.

---

## 55. PERFORMANCE

The application may eventually contain:

- millions of odds records
- millions of predictions
- many years of match data

Design accordingly.

Use:

- proper indexes
- pagination
- selective queries
- aggregation queries
- caching where appropriate
- batch inserts
- transactions where appropriate

Do not load entire historical datasets into memory unnecessarily.

---

## 56. CACHING

Cache data that changes infrequently:

- leagues
- teams
- seasons

Use shorter cache durations for:

- fixtures
- odds
- injuries
- lineups

Never serve stale odds as current odds without clearly identifying the timestamp.

---

## 57. CRITICAL: NO DATA LEAKAGE

This rule overrides convenience.

If a match starts at 19:00 and prediction is generated at 10:00, the model may only use information available at or before 10:00.

It must NOT use:

- final result
- post-match statistics
- future match results
- future odds
- future injury updates
- future lineup confirmation if it was not available at 10:00

The same rule must apply to backtesting.

---

## 58. RESPONSIBLE PRODUCT LANGUAGE

Good:

```text
Model Probability: 67%
Positive EV: +4.2%
Confidence: High
```

Bad:

```text
This will win.
Guaranteed.
Banko kesin.
100% sure.
```

The application should make it clear that betting involves risk.

---

## 59. DEVELOPMENT ORDER

Follow this order.

### Phase 1 — Project Setup

Create:

- Next.js
- TypeScript
- Tailwind
- Prisma
- environment configuration
- ESLint
- Prettier

### Phase 2 — Database

Create:

- schema.prisma
- migrations
- indexes
- relations
- constraints
- seed data

### Phase 3 — Provider Architecture

Create:

- FootballDataProvider
- OddsProvider
- provider adapters

Do not lock the application to a provider.

### Phase 4 — Data Ingestion

Implement:

- leagues
- seasons
- teams
- fixtures
- results
- statistics
- H2H
- injuries
- lineups
- odds

### Phase 5 — Feature Engineering

Implement:

- form
- Elo
- home/away
- goals
- xG
- xGA
- H2H
- injuries
- lineup factors

### Phase 6 — Prediction Engine

Implement:

- Elo
- Poisson
- Form
- xG
- Ensemble

### Phase 7 — Value Engine

Implement:

- implied probability
- edge
- EV
- confidence
- risk
- data quality

### Phase 8 — Coupon Engine

Implement:

- 5 High Confidence
- 5 Medium
- 5 High Odds

### Phase 9 — Backtesting

Implement:

- historical predictions
- chronological testing
- ROI
- profit
- drawdown
- calibration

### Phase 10 — UI

Implement:

- dashboard
- matches
- match details
- coupons
- predictions
- teams
- backtest
- settings

### Phase 11 — Optimization

Improve:

- model calibration
- performance
- caching
- database indexes
- coupon diversification
- correlation detection

---

## 60. FIRST TASK FOR CLAUDE

Before writing the complete application:

1. Read this entire CLAUDE.md.
2. Do NOT immediately start building UI.
3. Review the architecture.
4. Design the complete PostgreSQL schema.
5. Create the Prisma schema.
6. Explain all relationships.
7. Identify indexes required for performance.
8. Identify potential data duplication.
9. Identify data leakage risks.
10. Identify missing entities.
11. Propose architectural improvements.
12. Create Prisma migrations.
13. Create development seed data.
14. Create the Next.js project structure.
15. Create provider interfaces.
16. Create domain types.
17. Create initial service architecture.

Do NOT create the PostgreSQL database itself.

Do NOT hard-code a football API provider until the provider is explicitly selected.

Do NOT hard-code an odds provider until the provider is explicitly selected.

Use mock providers/interfaces during initial development if necessary.

---

## 61. FINAL PRODUCT BEHAVIOR

```text
USER OPENS ENVORAIBET
        |
        v
TODAY'S BULLETIN
        |
        v
FETCH MATCHES + AVAILABLE MARKETS + ODDS
        |
        v
FETCH HISTORICAL TEAM DATA
        |
        v
FEATURE ENGINEERING
        |
        v
ELO + POISSON + FORM + XG
        |
        v
ENSEMBLE MODEL
        |
        v
PROBABILITY CALCULATION
        |
        v
VALUE / EV CALCULATION
        |
        v
RISK + CORRELATION ANALYSIS
        |
        v
COUPON OPTIMIZATION
        |
        +-----------------------------+
        |              |              |
        v              v              v
HIGH CONFIDENCE     MEDIUM         HIGH ODDS
     5                 5               5
        |              |              |
        +--------------+--------------+
                       |
                       v
                  15 COUPONS
                       |
                       v
                 USER DASHBOARD
                       |
                       v
                  RESULT TRACKING
                       |
                       v
                   BACKTESTING
                       |
                       v
                 MODEL IMPROVEMENT
```

The ultimate objective is not to maximize the number of predictions.

The objective is to build a **historically validated, probability-based, value-oriented football betting analysis engine** that continuously measures whether its predictions actually perform well.

EnvoraSports must be designed from day one for:

- reproducibility
- historical analysis
- backtesting
- extensibility
- production-scale data
- responsible probabilistic presentation

---

# 16. MEMBERSHIP, MONTHLY SUBSCRIPTIONS & ENTITLEMENTS

EnvoraSports must have a membership system with monthly subscriptions.

## Plans

| Plan | High Confidence / Banko | Medium Odds | High Odds |
|---|---:|---:|---:|
| PLUS | ✅ | ❌ | ❌ |
| PREMIUM | ✅ | ✅ | ❌ |
| ELITE | ✅ | ✅ | ✅ |

Do not hard-code plan checks throughout the application. Use a centralized entitlement system.

Recommended feature keys:
- `COUPON_HIGH_CONFIDENCE`
- `COUPON_MEDIUM_ODDS`
- `COUPON_HIGH_ODDS`

Recommended service methods:
- `canAccessCouponType(userId, couponType)`
- `getUserEntitlements(userId)`
- `requireEntitlement(userId, feature)`
- `getCurrentSubscription(userId)`

The UI may hide or lock unavailable content, but authorization MUST also be enforced server-side/API-side.

## Monthly Billing

Use a provider-agnostic billing abstraction, with Stripe as the recommended implementation.

Required concepts:
- Monthly recurring subscriptions
- Stripe Customer
- Stripe Product
- Stripe Price
- Checkout
- Customer Portal
- Webhooks
- Subscription status synchronization
- Upgrade/downgrade
- Cancel at period end
- Trial support if enabled later

Do not invent monthly prices. Store prices in the database/configuration so they can be changed without code changes.

Recommended environment variables:
- `STRIPE_SECRET_KEY`
- `STRIPE_WEBHOOK_SECRET`
- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`

Never expose secret Stripe credentials to the client.

## Subscription statuses

Support at minimum:
- `trialing`
- `active`
- `past_due`
- `canceled`
- `unpaid`
- `incomplete`
- `incomplete_expired`

If `cancel_at_period_end = true`, the user keeps access until `current_period_end` unless the billing provider reports an earlier termination.

## Subscription database

Add or extend the Prisma schema with:

### users
- `id`
- `email`
- `name`
- `password_hash` or external auth identifier as appropriate
- `stripe_customer_id`
- `created_at`
- `updated_at`

### subscription_plans
- `id`
- `code` (`PLUS`, `PREMIUM`, `ELITE`)
- `name`
- `description`
- `monthly_price`
- `currency`
- `stripe_product_id`
- `stripe_price_id`
- `active`
- `created_at`
- `updated_at`

### subscription_plan_features
- `id`
- `plan_id`
- `feature_code`
- `enabled`

### subscriptions
- `id`
- `user_id`
- `plan_id`
- `provider`
- `external_customer_id`
- `external_subscription_id`
- `status`
- `current_period_start`
- `current_period_end`
- `cancel_at_period_end`
- `canceled_at`
- `trial_end`
- `created_at`
- `updated_at`

Unique:
- `external_subscription_id`
- active provider subscription mapping

### subscription_events
- `id`
- `provider`
- `external_event_id` UNIQUE
- `event_type`
- `payload_json`
- `processed_at`
- `created_at`

Webhook processing MUST be idempotent. Verify webhook signatures before processing.

Optional:
### invoices
Store invoice/billing history if billing history is shown in the account area.

## Required subscription routes

- `/pricing`
- `/account`
- `/account/subscription`
- `/billing/success`
- `/billing/cancel`
- `/api/stripe/webhook`

Use Checkout for new subscriptions and Customer Portal for payment method, invoice and cancellation management where possible.

---

# 17. DYNAMIC COUPON SETTINGS

Coupon generation MUST NOT depend on hard-coded values.

Create an admin/configuration settings layer so the operator can control:
- number of coupons
- minimum total odds
- maximum total odds
- minimum selections
- maximum selections
- minimum confidence
- minimum EV
- minimum edge
- maximum correlation
- allowed markets
- daily generation time
- system coupon settings
- stake settings

All important thresholds must be editable without redeploying the application.

## Coupon category settings

Create configurable settings for:

### HIGH_CONFIDENCE
Example defaults only; all values configurable:
- coupon count: 5
- minimum total odds: configurable
- maximum total odds: configurable
- minimum confidence: configurable
- minimum EV: configurable
- minimum edge: configurable
- min selections: configurable
- max selections: configurable

### MEDIUM_ODDS
Example defaults:
- coupon count: 5
- minimum total odds: 2.50
- maximum total odds: 6.00
- confidence threshold: configurable
- EV threshold: configurable
- edge threshold: configurable
- min/max selections: configurable

### HIGH_ODDS
Example defaults:
- coupon count: 5
- minimum total odds: 8.00
- maximum total odds: configurable
- confidence threshold: configurable
- EV threshold: configurable
- edge threshold: configurable
- min/max selections: configurable

The system must validate:
- `min_odds <= max_odds`
- `min_selections <= max_selections`
- thresholds are within valid ranges
- coupon count is positive
- no impossible configuration is saved

## Suggested settings table

Add a generic configuration table such as:

### app_settings
- `id`
- `key` UNIQUE
- `value`
- `value_type`
- `category`
- `description`
- `updated_at`

Or use strongly typed category-specific settings if that gives better type safety.

Do not scatter magic numbers across services.

---

# 18. SYSTEM COUPON ENGINE

EnvoraSports must support normal coupons AND system coupons.

Normal coupon:
- one complete set of selections
- total odds = multiplication of selection odds

System coupon:
- user/operator chooses N selections
- system chooses K selections per combination
- every K-selection combination becomes one column

Examples:
- 8 selections, System 2 → `C(8,2) = 28` columns
- 8 selections, System 3 → `C(8,3) = 56` columns
- 8 selections, System 4 → `C(8,4) = 70` columns
- 10 selections, System 3 → `C(10,3) = 120` columns

Use a mathematically correct combinations implementation. Never approximate the number of columns.

Formula:

`columns = n! / (k! * (n-k)!)`

Equivalent safe implementation:

`C(n,k)`

with:
- `0 <= k <= n`
- reject impossible combinations
- avoid integer overflow
- use BigInt/decimal-safe arithmetic where appropriate

## System coupon settings

Make these configurable:
- enabled/disabled
- system type (`SYSTEM_2`, `SYSTEM_3`, `SYSTEM_4`, etc.)
- number of base selections
- minimum/maximum base selections
- allowed system types
- stake per column
- maximum total stake
- minimum combined probability
- minimum EV
- maximum correlation
- whether one selection per match is mandatory

## Correct stake calculation

The application MUST distinguish between:
1. stake per column
2. total coupon stake
3. potential return
4. net profit

Formula:

`total_stake = column_count * stake_per_column`

For each system column:

`column_odds = product(selection_odds)`

If a winning column has stake `S`:

`column_return = S * column_odds`

For a completed system coupon:

`total_return = sum(return_of_each_winning_column)`

`net_profit = total_return - total_stake`

`ROI = net_profit / total_stake`

Do not calculate a system coupon's return as if all base selections were one single accumulator. Each generated column is an independent betting combination.

Example:
- 8 base selections
- System 3
- 56 columns
- 1 TL per column
- total stake = 56 TL

If 4 of the 56 columns win, sum the actual returns of those 4 winning columns. Do not multiply the full 56-column accumulator.

## System coupon storage

Recommended tables:

### system_coupons
- `id`
- `coupon_id` or daily generation reference
- `system_type`
- `base_selection_count`
- `system_selection_count`
- `column_count`
- `stake_per_column`
- `total_stake`
- `status`
- `created_at`

### system_coupon_columns
- `id`
- `system_coupon_id`
- `column_index`
- `combined_odds`
- `stake`
- `result_status`
- `return_amount`
- `net_profit`

### system_coupon_column_selections
- `id`
- `column_id`
- `selection_id`

Use foreign keys and unique constraints to prevent duplicate selection assignments.

---

# 19. COUPON GENERATION SETTINGS UI

Create an admin page:

`/admin/settings/coupons`

Use grouped cards:

### Daily Coupon Counts
- Banko count
- Medium Odds count
- High Odds count

### Odds Rules
- Banko min/max odds
- Medium min/max odds
- High min/max odds

### Quality Rules
- minimum confidence
- minimum EV
- minimum edge
- maximum risk
- maximum correlation

### Selection Rules
- min selections
- max selections
- one selection per match
- allowed markets

### System Coupons
- enable systems
- available system types
- default system type
- stake per column
- maximum total stake

Every setting must show:
- current value
- valid range
- short explanation
- save/reset action

Changes must be audited.

---

# 20. PREMIUM UI / VISUAL DESIGN SYSTEM

EnvoraSports should look like a premium sports analytics + betting intelligence product.

## Visual identity

Primary palette:
- Emerald green
- Deep navy
- Near-black
- Gold accents

Suggested palette:
- Primary emerald: `#059669`
- Bright emerald: `#10B981`
- Deep navy: `#07111F`
- Dark navy: `#0B1728`
- Near black: `#05080D`
- Gold: `#D4AF37`
- Light gold: `#F4D77D`
- White: `#F8FAFC`
- Muted text: `#94A3B8`

Do not turn the interface into a rainbow. Gold should be an accent for premium/elite states, badges, highlights and important metrics.

## Design direction

The product should feel:
- premium
- trustworthy
- data-driven
- modern
- dark
- fast
- sophisticated
- sports-focused

Avoid:
- cheap casino aesthetics
- excessive gradients
- flashing animations
- oversized neon elements
- clutter
- misleading "guaranteed win" language

Use:
- dark navy/near-black backgrounds
- emerald primary actions
- gold Elite/Premium accents
- subtle borders
- glass/blur effects sparingly
- compact statistical cards
- clean tables
- strong typography hierarchy
- tasteful micro-interactions

## Main navigation

Desktop:
- Dashboard
- Today's Coupons
- Banko
- Medium Odds
- High Odds
- System Coupons
- Matches
- Analysis
- Backtest
- Pricing
- Account

Mobile:
- Home
- Coupons
- Systems
- Matches
- Account

Admin navigation:
- Dashboard
- Coupon Generator
- Coupon Settings
- System Settings
- Matches
- Odds
- Models
- Backtests
- Users
- Subscriptions
- Plans
- System Logs

## Dashboard

Hero section:
- "Today's Betting Intelligence"
- date
- number of generated coupons
- model version
- last update time

Summary cards:
- Banko
- Medium Odds
- High Odds
- System Coupons

Show:
- total opportunities
- average confidence
- average edge
- average odds
- today's model status

## Coupon cards

Each coupon card should show:
- category badge
- coupon ID
- total odds
- confidence
- estimated probability
- EV
- risk
- number of selections
- selections
- model version
- generated timestamp

Example visual hierarchy:

`BANKO`
`Total Odds 3.42`
`Confidence 87%`
`EV +8.4%`

Selection rows:
- league
- match
- kickoff
- market
- selection
- odds
- model probability
- implied probability
- edge

## Locked premium content

For unavailable plans:
- do not expose sensitive coupon selections through the API
- show a tasteful lock card
- explain which plan unlocks it
- provide CTA to `/pricing`

Examples:
- Plus user viewing Medium Odds → "Upgrade to Premium"
- Premium user viewing High Odds → "Unlock with Elite"

Do not fake-lock data only with CSS. Server-side authorization is mandatory.

## Pricing page

Create premium pricing cards:

PLUS
- Banko coupons
- high-confidence analysis
- monthly membership

PREMIUM
- Everything in Plus
- Medium Odds coupons
- enhanced value analysis

ELITE
- Everything in Premium
- High Odds coupons
- System coupons
- full coupon intelligence

Use gold treatment for Elite.

Prices must come from the database/configuration, never hard-code pricing in UI.

## Account / subscription UI

Show:
- current plan
- subscription status
- next billing date
- current period
- cancel-at-period-end state
- upgrade/downgrade
- payment management
- invoice history if implemented

---

# 21. UX RULES FOR BETTING CONTENT

The product must communicate probabilities and model estimates responsibly.

Never use:
- "guaranteed"
- "100% win"
- "sure bet"
- "certain win"

Prefer:
- "High Confidence"
- "Model Probability"
- "Statistical Edge"
- "Positive EV"
- "Value Selection"
- "Risk Score"

Every coupon should make it clear that model predictions are estimates, not guarantees.

---

# 22. COUPON GENERATION ARCHITECTURE WITH MEMBERSHIP

Coupon generation is independent from membership.

The daily engine should generate/store all configured coupons:
- High Confidence
- Medium Odds
- High Odds
- System Coupons

Membership is an ACCESS layer, not a generation layer.

Example:
- Generate 5 High Odds coupons even if there are currently zero Elite users.
- Store them.
- Plus users cannot access them.
- Premium users cannot access them.
- Elite users can access them.

This prevents subscription-dependent model behavior and makes historical analytics/backtesting consistent.

Recommended flow:

`Match Data`
→ `Odds`
→ `Feature Engineering`
→ `Prediction Engine`
→ `Candidate Selections`
→ `Coupon Scoring`
→ `Diversification`
→ `System Coupon Engine`
→ `Persist Coupons`
→ `Entitlement Filtering`
→ `User UI`

---

# 23. BACKEND ACCESS CONTROL

All coupon API endpoints must enforce entitlement.

Example conceptual rules:

- `GET /api/coupons/high-confidence` → authenticated Plus/Premium/Elite
- `GET /api/coupons/medium-odds` → authenticated Premium/Elite
- `GET /api/coupons/high-odds` → authenticated Elite
- `GET /api/system-coupons` → authenticated Elite unless a future plan explicitly enables it

If unauthorized:
- return HTTP 401 for unauthenticated
- return HTTP 403 for authenticated but insufficient entitlement

Never send locked selections/odds in the JSON response and merely hide them in React.

---

# 24. ADMIN SETTINGS PRINCIPLES

All important product behavior must be configurable.

Admin must be able to change without redeployment:
- daily coupon counts
- odds ranges
- confidence thresholds
- EV/edge thresholds
- risk limits
- correlation limits
- selection limits
- market availability
- system types
- system stake
- plan availability
- plan monthly price
- plan feature entitlements
- coupon generation schedule

Configuration changes must:
- validate input
- be persisted
- be logged/audited
- take effect predictably
- not corrupt already-generated historical coupons

Historical coupons must retain the settings/model version used at generation time.

---

# 25. PREMIUM UI IMPLEMENTATION RULES FOR CLAUDE

Use a reusable design system instead of styling each page independently.

Recommended component families:
- `PremiumCard`
- `MetricCard`
- `CouponCard`
- `SelectionRow`
- `OddsBadge`
- `ConfidenceBadge`
- `RiskBadge`
- `PlanCard`
- `LockedFeatureCard`
- `SystemCouponCard`
- `SystemColumnTable`
- `PricingToggle`
- `SubscriptionStatusCard`
- `AdminSettingCard`
- `SettingsSection`
- `DataTable`
- `FilterBar`
- `EmptyState`
- `LoadingSkeleton`

Use responsive design from the beginning.

Use accessible:
- contrast
- keyboard navigation
- focus states
- semantic buttons/links
- screen-reader labels

Animations should be subtle and performance-friendly.

---

# 26. TESTING REQUIREMENTS FOR MEMBERSHIP & SYSTEM COUPONS

Add automated tests for:

## Membership
- Plus can access Banko
- Plus cannot access Medium
- Plus cannot access High Odds
- Premium can access Banko
- Premium can access Medium
- Premium cannot access High Odds
- Elite can access all
- canceled subscription access behavior
- cancel-at-period-end behavior
- past_due behavior
- webhook idempotency
- invalid webhook signature rejection
- duplicate Stripe event rejection

## Dynamic settings
- changing coupon count changes generation count
- changing min odds changes eligible coupons
- invalid ranges are rejected
- settings are persisted
- historical coupons do not change after settings change

## System calculations
Test:
- C(8,2) = 28
- C(8,3) = 56
- C(8,4) = 70
- C(10,3) = 120
- impossible combinations are rejected
- total stake = columns × stake per column
- winning column returns are summed correctly
- net profit = total return − total stake
- ROI is calculated from total stake
- decimal precision is preserved

Use deterministic fixtures for financial calculations.

Money must use `Decimal`/Prisma Decimal rather than JavaScript floating-point arithmetic.

Odds calculations must use safe decimal arithmetic and explicit rounding rules.

---

# 27. ACCEPTANCE CRITERIA — MEMBERSHIP, SETTINGS & SYSTEM COUPONS

The implementation is not complete until:

1. Plus/Premium/Elite memberships work.
2. Monthly subscription lifecycle is implemented.
3. Stripe webhook processing is secure and idempotent if Stripe is selected.
4. Server-side entitlement checks prevent unauthorized coupon access.
5. Coupon counts are configurable from admin settings.
6. Odds thresholds are configurable from admin settings.
7. Confidence/EV/edge/risk thresholds are configurable.
8. System coupon types are configurable.
9. System coupon column counts are mathematically correct.
10. Stake calculations are mathematically correct.
11. System returns/profit/ROI are calculated per winning column.
12. Historical generated coupons preserve their generation configuration/model version.
13. Pricing UI is premium and responsive.
14. EnvoraSports uses emerald + gold + black/deep-navy visual identity.
15. The interface feels like a serious sports analytics product, not a casino landing page.
16. Locked content is enforced server-side.
17. No "guaranteed win" claims exist anywhere in the UI.
18. Financial calculations use decimal-safe arithmetic.

---

# 28. PRODUCT NAME & COMPLIANCE-FRIENDLY PRODUCT LANGUAGE

The official product/brand name is **EnvoraSports**.

Do not use "Envoraibet" anywhere in the application, documentation, UI, metadata, or generated copy.

EnvoraSports should be positioned primarily as a **football prediction, sports analytics, and market intelligence platform**.

## Preferred customer-facing terminology

Use:
- Prediction
- Pick
- Selection
- High Confidence
- Balanced Picks
- High Value
- Market Analysis
- Match Analysis
- Sports Intelligence
- Model Probability
- Statistical Edge
- Positive EV
- Projected Return
- Stake Simulation
- Combination System
- Prediction History

Avoid unnecessarily gambling-centric wording in general product/UI copy:
- Bet
- Betting App
- Place a Bet
- Guaranteed Bet
- Sure Bet
- Winning Bet
- Gambling

Technical sportsbook terminology may remain in internal schemas/integration code when required by external providers, but customer-facing copy should use EnvoraSports terminology.

## Brand positioning

Primary positioning:

**EnvoraSports — AI-Powered Football Predictions & Sports Intelligence**

Short description:

**Data-driven football predictions, market analysis and intelligent combination systems.**

Never claim guaranteed outcomes. Predictions are statistical/model estimates.

---

# 29. ENVORASPORTS UI NAMING

Customer-facing navigation:

- Dashboard
- Today's Predictions
- High Confidence
- Balanced Picks
- High Value
- Combination Systems
- Matches
- Match Analysis
- Backtest
- Pricing
- Account

Use:
- Predictions instead of Betting Coupons
- Prediction Cards instead of Bet Slips
- Prediction History instead of Betting History
- Combination Systems instead of System Bets

## Membership copy

PLUS:
- High Confidence predictions

PREMIUM:
- High Confidence + Balanced Picks

ELITE:
- Full access including High Value predictions and Combination Systems

Use "membership" and "subscription" for the commercial product.

## Disclaimer

Include a visible, concise disclaimer in appropriate locations:

"EnvoraSports provides statistical predictions and sports analytics for informational purposes. Predictions are not guarantees of outcomes."

Do not use language suggesting guaranteed profit or guaranteed wins.

---

# 30. FULLY DYNAMIC DAILY COUPON COUNTS

Coupon quantities MUST be completely configurable from admin settings.

There must be NO hard-coded requirement such as "5 Banko + 5 Medium + 5 High Odds".

The administrator can configure independently:
- High Confidence coupon count
- Balanced Picks coupon count
- High Value coupon count
- Combination/System coupon count
- Any future coupon category count

Example configuration:
- High Confidence: 7
- Balanced Picks: 4
- High Value: 3
- System Coupons: 2

The generation engine must read these values at runtime.

If a setting is changed from 5 to 10, the next generation cycle must generate 10 eligible coupons for that category without a code change or redeployment.

## Dynamic generation rules

For each category:
1. Load current settings.
2. Generate candidate selections.
3. Score candidates.
4. Apply odds/confidence/EV/edge/risk/correlation filters.
5. Diversify selections.
6. Select up to the configured coupon count.
7. If fewer valid coupons exist than requested, generate only valid coupons and record the reason.
8. Never create fake or low-quality coupons simply to satisfy the requested count.

Store the generation configuration snapshot with each daily generation/coupon so historical results remain reproducible.

---

# 31. AUTOMATIC MATCH RESULT COLLECTION & COUPON SETTLEMENT

EnvoraSports must automatically retrieve football match results and use them to settle previously generated predictions/coupons.

The system must not require an administrator to manually mark coupons as won/lost.

## Match lifecycle

Recommended statuses:

`SCHEDULED`
→ `LIVE`
→ `FINISHED`
→ `POSTPONED`
→ `CANCELED`
→ `ABANDONED`

A match should only be settled when the provider confirms the match is finished and a final result is available.

## Automatic result synchronization

Create a scheduled background job such as:

`MatchResultSyncJob`

The job should:
- find matches whose kickoff time has passed
- query the configured football data provider
- retrieve current/final status
- retrieve final score
- retrieve half-time score where available
- retrieve required match statistics
- update the database
- trigger coupon settlement for affected coupons
- avoid repeatedly processing already-finalized results

Do not assume a match is finished merely because the scheduled kickoff time has passed.

The provider's actual match status must be checked.

## Time-aware result checking

The system must automatically determine which matches need checking based on:
- scheduled kickoff timestamp
- competition timezone / venue timezone where applicable
- provider status
- current UTC time

Store canonical timestamps in UTC.

Recommended fields:
- `scheduled_kickoff_utc`
- `started_at_utc`
- `finished_at_utc`
- `provider_status`
- `last_result_sync_at`
- `result_sync_attempts`

The scheduler should check upcoming/active matches intelligently instead of continuously requesting every historical match.

Suggested logic:
- Before kickoff: low-frequency checks.
- Around kickoff: increase checking frequency.
- During live match: periodic status updates.
- After expected full time: continue checking until provider confirms `FINISHED`.
- After finalization: stop unnecessary polling and retain final snapshot.

Frequency must be configurable.

## Delayed/postponed matches

If a match is postponed:
- do not mark the prediction as lost
- update match status
- pause settlement
- follow the new kickoff time when supplied

If a match is canceled/abandoned:
- apply the configured market settlement rules
- do not incorrectly classify it as a normal loss

---

# 32. PREDICTION SETTLEMENT ENGINE

Create a dedicated service:

`PredictionSettlementService`

Responsibilities:
- determine whether a prediction won/lost/pushed/void
- use the final match result
- evaluate the market-specific settlement rule
- update prediction status
- record settlement timestamp
- preserve the final result used for settlement

Recommended prediction statuses:

- `PENDING`
- `WON`
- `LOST`
- `PUSHED`
- `VOID`
- `CANCELED`

Do not use a generic score-only rule for every market.

Each market must have its own settlement evaluator.

Examples:

### Match Result
- MS 1 → home win
- MS X → draw
- MS 2 → away win

### Double Chance
- 1X → home win or draw
- X2 → draw or away win
- 12 → home win or away win

### Over/Under
Evaluate against the correct total goals.

### BTTS
Evaluate whether both teams scored.

### Half-Time Result
Use half-time score, not full-time score.

### HT/FT
Evaluate both half-time and full-time results.

### Team Goals
Evaluate the selected team's final goals.

### Correct Score
Compare exact final score.

### Goal Range
Evaluate final total goals against the selected range.

### 6+ Goals / 7+ Goals
Evaluate final total goals against the threshold.

### Asian Handicap
Use the correct handicap settlement rules, including:
- win
- loss
- push
- half-win
- half-loss where applicable

### Corners
Use final official corner statistics.

### Cards
Use the provider's official card statistic and configured counting convention.

Market settlement logic must be implemented through a strategy/registry architecture, not a giant `if/else` block.

Recommended:

`MarketSettlementEvaluator`
→ `MatchResultEvaluator`
→ `DoubleChanceEvaluator`
→ `OverUnderEvaluator`
→ `BTTS...`
→ etc.

---

# 33. COUPON SETTLEMENT

Create:

`CouponSettlementService`

A normal coupon is:

`WON` only when all required selections are won.

If any required selection loses:
- coupon = `LOST`

If a selection is void/pushed:
- apply configured coupon rules
- normally remove/neutralize the void selection from the accumulator
- if all selections become void, coupon may become `VOID`

The settlement rules must be explicit and tested.

Store:
- `settled_at`
- `result_status`
- `winning_selection_count`
- `losing_selection_count`
- `void_selection_count`
- `settlement_version`

Never recalculate historical settlement using changed rules without recording a new settlement version.

---

# 34. SYSTEM COUPON SETTLEMENT

System coupons must be settled **column by column**.

For each system column:
- evaluate each included selection
- determine column result
- calculate winning return
- store result

Recommended column statuses:
- `PENDING`
- `WON`
- `LOST`
- `VOID`

Then aggregate:

`winning_columns`
`losing_columns`
`void_columns`
`total_return`
`total_stake`
`net_profit`
`ROI`

A system coupon can therefore be partially successful.

Example:
- System 3
- 56 columns
- 8 winning columns
- 48 losing columns

The system coupon is not simply "won" or "lost". It must show the financial outcome based on the actual winning columns.

---

# 35. COUPON RESULT BADGES

The UI must display clear result badges.

Recommended:

- 🟢 **WON**
- 🔴 **LOST**
- 🟡 **PENDING**
- ⚪ **VOID**
- 🔵 **PUSHED**
- 🟠 **PARTIAL WIN** for system coupons where applicable

For customer-facing UI, use text + icon/status styling so the status is not communicated by color alone.

Coupon card examples:

`HIGH CONFIDENCE`
`WON`
`Total Odds 2.84`

or:

`HIGH VALUE`
`PENDING`
`Match starts 21:00`

or:

`COMBINATION SYSTEM`
`PARTIAL WIN`
`12 / 56 columns won`

Do not change a settled status because a later sync temporarily fails.

---

# 36. LIVE / RESULT UI

Match and coupon pages should show:

### Before match
- kickoff time
- countdown
- prediction
- odds
- model probability
- status: Pending

### Live
- LIVE badge
- current score
- match minute if available
- relevant live statistics where supported

### Finished
- final score
- prediction result
- WON/LOST/VOID/PUSHED badge
- settlement timestamp

### Coupon
Show overall:
- Pending
- Won
- Lost
- Partial Win
- Void

Also show every selection's individual result.

---

# 37. RESULT SYNC DATABASE REQUIREMENTS

Extend `matches` with fields similar to:
- `status`
- `home_score`
- `away_score`
- `half_time_home_score`
- `half_time_away_score`
- `scheduled_kickoff_utc`
- `started_at_utc`
- `finished_at_utc`
- `result_last_synced_at`
- `provider_status`
- `provider_last_updated_at`

Create a result snapshot/history table if required:

### match_result_snapshots
- `id`
- `match_id`
- `provider`
- `provider_status`
- `home_score`
- `away_score`
- `half_time_home_score`
- `half_time_away_score`
- `statistics_json`
- `captured_at`

Do not overwrite the only copy of an important historical provider response if it is needed for audit/reproducibility.

---

# 38. RESULT SYNC JOBS & RELIABILITY

Use the existing background job infrastructure.

Recommended jobs:
- `UpcomingMatchSyncJob`
- `LiveMatchSyncJob`
- `MatchResultSyncJob`
- `CouponSettlementJob`
- `SystemCouponSettlementJob`

Jobs must be:
- idempotent
- retryable
- observable
- provider-rate-limit aware

If a provider API fails:
- retry with backoff
- do not mark predictions as lost
- record the error
- continue processing other matches
- surface persistent failures in admin monitoring

Use distributed locking or equivalent protection so multiple workers do not settle the same coupon simultaneously.

Settlement operations should be transactional where possible.

---

# 39. ADMIN RESULT & SETTLEMENT MONITOR

Add:

`/admin/results`

Show:
- matches awaiting result
- live matches
- recently finished matches
- result sync failures
- coupons awaiting settlement
- recently settled coupons
- provider status
- last sync time

Admin actions:
- force result sync
- retry failed sync
- inspect provider result
- inspect settlement details

Manual override should be restricted to authorized admins and fully audited.

---

# 40. DAILY COUPON RESULT STATISTICS

Once results are available, automatically calculate:

- coupons generated
- coupons settled
- pending coupons
- won coupons
- lost coupons
- void coupons
- win rate
- average odds
- average model probability
- average edge
- average EV
- profit/loss
- ROI
- system winning columns
- system ROI

Break down statistics by:
- High Confidence
- Balanced Picks
- High Value
- Combination Systems
- market
- league
- model version
- date range

Never include pending coupons in final win-rate calculations.

---

# 41. HISTORICAL INTEGRITY

A generated prediction must preserve:
- model version
- settings version/snapshot
- odds at prediction time
- model probability
- implied probability
- edge
- EV
- risk
- data quality
- generation timestamp

A later change to:
- coupon settings
- model weights
- odds
- settlement rules
- membership plans

must not mutate the historical prediction's original analytical state.

Settlement may append the final result, but must preserve the original prediction inputs.

---

# 42. END-TO-END DAILY AUTOMATION

The production pipeline should operate approximately as follows:

1. Import today's fixtures.
2. Import/update odds.
3. Build prediction features.
4. Run prediction models.
5. Generate candidate selections.
6. Apply dynamic admin settings.
7. Generate configured number of High Confidence coupons.
8. Generate configured number of Balanced Picks coupons.
9. Generate configured number of High Value coupons.
10. Generate configured System/Combination coupons.
11. Persist all generated coupons.
12. Publish according to membership entitlements.
13. Monitor matches according to kickoff time.
14. Fetch live/final results from the provider.
15. Store final results.
16. Settle individual predictions.
17. Settle normal coupons.
18. Settle system columns.
19. Calculate returns/profit/ROI.
20. Update result badges.
21. Update dashboard statistics.
22. Record all job execution logs/errors.

The process must be restart-safe and idempotent.

---

# 43. FINAL ENVORASPORTS ACCEPTANCE CRITERIA

The project is complete only when all of the following work:

- EnvoraSports is the official product name everywhere.
- Plus/Premium/Elite memberships work.
- Monthly subscriptions work.
- Server-side entitlement enforcement works.
- Coupon quantities are fully dynamic and configurable.
- Odds ranges are fully dynamic.
- Quality thresholds are configurable.
- System coupon types are configurable.
- System column counts are mathematically correct.
- Stake and return calculations use decimal-safe arithmetic.
- Fixtures and odds are synchronized automatically.
- Match status is synchronized automatically.
- Final match results are retrieved automatically.
- Result polling follows actual kickoff/match status.
- Postponed/canceled matches are handled safely.
- Every supported market has a correct settlement evaluator.
- Predictions automatically become WON/LOST/PUSHED/VOID.
- Normal coupons automatically become WON/LOST/VOID.
- System coupons are settled column by column.
- System coupons can show PARTIAL WIN.
- UI displays clear result badges.
- Historical predictions retain their original odds/settings/model version.
- Sync jobs are retryable and idempotent.
- Duplicate result processing cannot duplicate financial returns.
- Admin can inspect and retry failed synchronization.
- Dashboard statistics update after settlement.
- No fake coupons are generated merely to satisfy a configured count.
- No guaranteed-win claims are used.
- EnvoraSports maintains its premium emerald + gold + deep-navy/black visual identity.
- The application feels like a serious football analytics/intelligence product.
