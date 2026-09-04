-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Locale" AS ENUM ('EN', 'TR');

-- CreateEnum
CREATE TYPE "MatchStatus" AS ENUM ('SCHEDULED', 'LIVE', 'HALF_TIME', 'FINISHED', 'POSTPONED', 'CANCELED', 'SUSPENDED', 'ABANDONED', 'AWARDED');

-- CreateEnum
CREATE TYPE "LineupType" AS ENUM ('CONFIRMED', 'PREDICTED', 'UNAVAILABLE');

-- CreateEnum
CREATE TYPE "InjuryStatus" AS ENUM ('OUT', 'DOUBTFUL', 'SUSPENDED', 'AVAILABLE');

-- CreateEnum
CREATE TYPE "MarketCategory" AS ENUM ('RESULT', 'GOALS', 'BOTH_TEAMS', 'HALVES', 'SCORE', 'HANDICAP', 'TEAM_TOTALS', 'CORNERS', 'CARDS', 'SPECIALS');

-- CreateEnum
CREATE TYPE "CouponCategory" AS ENUM ('HIGH_CONFIDENCE', 'BALANCED_PICKS', 'HIGH_VALUE', 'COMBINATION_SYSTEM');

-- CreateEnum
CREATE TYPE "CouponKind" AS ENUM ('STANDARD', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'WON', 'LOST', 'PUSHED', 'HALF_WON', 'HALF_LOST', 'VOID', 'CANCELED');

-- CreateEnum
CREATE TYPE "CouponResultStatus" AS ENUM ('PENDING', 'WON', 'LOST', 'PARTIAL_WIN', 'VOID');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "PlanCode" AS ENUM ('PLUS', 'PREMIUM', 'ELITE');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED');

-- CreateEnum
CREATE TYPE "SettingValueType" AS ENUM ('STRING', 'NUMBER', 'DECIMAL', 'BOOLEAN', 'JSON');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'SKIPPED');

-- CreateTable
CREATE TABLE "translations" (
    "id" TEXT NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "value" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "translations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leagues" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "country_code" TEXT,
    "type" TEXT,
    "logo" TEXT,
    "tier" INTEGER,
    "data_quality" DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "leagues_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL,
    "league_id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "start_date" DATE,
    "end_date" DATE,
    "current" BOOLEAN NOT NULL DEFAULT false,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "short_name" TEXT,
    "country" TEXT,
    "logo" TEXT,
    "founded" INTEGER,
    "venue" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_seasons" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "matches" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "league_id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "home_team_id" TEXT NOT NULL,
    "away_team_id" TEXT NOT NULL,
    "scheduled_kickoff_utc" TIMESTAMP(3) NOT NULL,
    "venue_timezone" TEXT,
    "started_at_utc" TIMESTAMP(3),
    "finished_at_utc" TIMESTAMP(3),
    "status" "MatchStatus" NOT NULL DEFAULT 'SCHEDULED',
    "provider_status" TEXT,
    "round" TEXT,
    "venue" TEXT,
    "referee" TEXT,
    "home_score" INTEGER,
    "away_score" INTEGER,
    "half_time_home_score" INTEGER,
    "half_time_away_score" INTEGER,
    "extra_time_home_score" INTEGER,
    "extra_time_away_score" INTEGER,
    "result_last_synced_at" TIMESTAMP(3),
    "result_sync_attempts" INTEGER NOT NULL DEFAULT 0,
    "provider_last_updated_at" TIMESTAMP(3),
    "lineup_type" "LineupType" NOT NULL DEFAULT 'UNAVAILABLE',
    "lineup_available_at" TIMESTAMP(3),
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "matches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_statistics" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "possession" DECIMAL(5,2),
    "shots" INTEGER,
    "shots_on_target" INTEGER,
    "shots_off_target" INTEGER,
    "blocked_shots" INTEGER,
    "corners" INTEGER,
    "fouls" INTEGER,
    "offsides" INTEGER,
    "yellow_cards" INTEGER,
    "red_cards" INTEGER,
    "saves" INTEGER,
    "passes" INTEGER,
    "pass_accuracy" DECIMAL(5,2),
    "expected_goals" DECIMAL(6,3),
    "expected_goals_against" DECIMAL(6,3),
    "extra" JSONB,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "match_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "match_result_snapshots" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_status" TEXT,
    "status" "MatchStatus" NOT NULL,
    "home_score" INTEGER,
    "away_score" INTEGER,
    "half_time_home_score" INTEGER,
    "half_time_away_score" INTEGER,
    "statistics_json" JSONB,
    "captured_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "match_result_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "team_form_snapshots" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "league_id" TEXT,
    "snapshot_date" TIMESTAMP(3) NOT NULL,
    "window" TEXT NOT NULL,
    "venue_scope" TEXT NOT NULL,
    "matches_played" INTEGER NOT NULL,
    "wins" INTEGER NOT NULL,
    "draws" INTEGER NOT NULL,
    "losses" INTEGER NOT NULL,
    "goals_for" INTEGER NOT NULL,
    "goals_against" INTEGER NOT NULL,
    "average_goals_for" DECIMAL(6,3) NOT NULL,
    "average_goals_against" DECIMAL(6,3) NOT NULL,
    "average_xg" DECIMAL(6,3),
    "average_xga" DECIMAL(6,3),
    "clean_sheet_rate" DECIMAL(5,4) NOT NULL,
    "btts_rate" DECIMAL(5,4) NOT NULL,
    "over_1_5_rate" DECIMAL(5,4) NOT NULL,
    "over_2_5_rate" DECIMAL(5,4) NOT NULL,
    "over_3_5_rate" DECIMAL(5,4) NOT NULL,
    "sample_size" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_form_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "elo_ratings" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "league_id" TEXT,
    "rating" DECIMAL(8,3) NOT NULL,
    "home_rating" DECIMAL(8,3),
    "away_rating" DECIMAL(8,3),
    "rating_date" TIMESTAMP(3) NOT NULL,
    "matches_played" INTEGER NOT NULL DEFAULT 0,
    "source_match_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "elo_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "head_to_head" (
    "id" TEXT NOT NULL,
    "home_team_id" TEXT NOT NULL,
    "away_team_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "match_date" TIMESTAMP(3) NOT NULL,
    "home_score" INTEGER NOT NULL,
    "away_score" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "head_to_head_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "players" (
    "id" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "team_id" TEXT,
    "name" TEXT NOT NULL,
    "position" TEXT,
    "nationality" TEXT,
    "birth_date" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "players_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "injuries" (
    "id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "status" "InjuryStatus" NOT NULL,
    "reason" TEXT,
    "start_date" DATE,
    "expected_return" DATE,
    "source_updated_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "injuries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lineups" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "player_id" TEXT NOT NULL,
    "type" "LineupType" NOT NULL,
    "starter" BOOLEAN NOT NULL DEFAULT false,
    "position" TEXT,
    "shirt_number" INTEGER,
    "formation" TEXT,
    "published_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lineups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookmakers" (
    "id" TEXT NOT NULL,
    "external_id" TEXT,
    "source" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "country" TEXT,
    "reliability" DECIMAL(4,3) NOT NULL DEFAULT 0.5,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookmakers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "betting_markets" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "MarketCategory" NOT NULL,
    "description" TEXT,
    "params_schema" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "betting_markets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "betting_selections" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "parameters" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "betting_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "odds" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "bookmaker_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "selection_id" TEXT NOT NULL,
    "price" DECIMAL(12,3) NOT NULL,
    "handicap" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "is_opening" BOOLEAN NOT NULL DEFAULT false,
    "is_closing" BOOLEAN NOT NULL DEFAULT false,
    "available" BOOLEAN NOT NULL DEFAULT true,
    "captured_at" TIMESTAMP(3) NOT NULL,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "odds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_versions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "description" TEXT,
    "configuration" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "predictions" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "selection_id" TEXT NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "probability" DECIMAL(9,8) NOT NULL,
    "odds_used" DECIMAL(12,3),
    "odds_id" TEXT,
    "implied_probability" DECIMAL(9,8),
    "edge" DECIMAL(10,6),
    "expected_value" DECIMAL(10,6),
    "confidence_score" DECIMAL(5,4) NOT NULL,
    "risk_score" DECIMAL(5,4) NOT NULL,
    "data_quality_score" DECIMAL(5,4) NOT NULL,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "breakdown" JSONB,
    "prediction_timestamp" TIMESTAMP(3) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settled_at" TIMESTAMP(3),
    "settlement_version" INTEGER,
    "settlement_snapshot" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "SettingValueType" NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT,
    "updated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_category_settings" (
    "id" TEXT NOT NULL,
    "category" "CouponCategory" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "coupon_count" INTEGER NOT NULL,
    "min_total_odds" DECIMAL(12,3) NOT NULL,
    "max_total_odds" DECIMAL(12,3),
    "min_selections" INTEGER NOT NULL,
    "max_selections" INTEGER NOT NULL,
    "min_confidence" DECIMAL(5,4) NOT NULL,
    "min_expected_value" DECIMAL(10,6) NOT NULL,
    "min_edge" DECIMAL(10,6) NOT NULL,
    "min_probability" DECIMAL(9,8) NOT NULL,
    "max_risk" DECIMAL(5,4) NOT NULL,
    "max_correlation" DECIMAL(5,4) NOT NULL,
    "min_data_quality" DECIMAL(5,4) NOT NULL,
    "one_selection_per_match" BOOLEAN NOT NULL DEFAULT true,
    "allowed_markets" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupon_category_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_coupon_settings" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "allowed_system_types" TEXT[],
    "default_system_type" TEXT NOT NULL,
    "min_base_selections" INTEGER NOT NULL,
    "max_base_selections" INTEGER NOT NULL,
    "stake_per_column" DECIMAL(14,2) NOT NULL,
    "max_total_stake" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "min_combined_probability" DECIMAL(9,8) NOT NULL,
    "min_expected_value" DECIMAL(10,6) NOT NULL,
    "max_correlation" DECIMAL(5,4) NOT NULL,
    "one_selection_per_match" BOOLEAN NOT NULL DEFAULT true,
    "coupon_count" INTEGER NOT NULL DEFAULT 2,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_coupon_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_snapshots" (
    "id" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_id" TEXT,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_generation_runs" (
    "id" TEXT NOT NULL,
    "bulletin_date" DATE NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "settings_snapshot_id" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "matches_considered" INTEGER NOT NULL DEFAULT 0,
    "candidates_evaluated" INTEGER NOT NULL DEFAULT 0,
    "coupons_generated" INTEGER NOT NULL DEFAULT 0,
    "shortfall_reasons" JSONB,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_generation_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupons" (
    "id" TEXT NOT NULL,
    "generation_run_id" TEXT NOT NULL,
    "category" "CouponCategory" NOT NULL,
    "kind" "CouponKind" NOT NULL DEFAULT 'STANDARD',
    "reference" TEXT NOT NULL,
    "name" TEXT,
    "bulletin_date" DATE NOT NULL,
    "total_odds" DECIMAL(18,4) NOT NULL,
    "estimated_probability" DECIMAL(9,8) NOT NULL,
    "expected_value" DECIMAL(10,6) NOT NULL,
    "confidence_score" DECIMAL(5,4) NOT NULL,
    "risk_score" DECIMAL(5,4) NOT NULL,
    "correlation_score" DECIMAL(5,4) NOT NULL,
    "diversification_score" DECIMAL(5,4) NOT NULL,
    "score" DECIMAL(10,6) NOT NULL,
    "selection_count" INTEGER NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "settings_snapshot_id" TEXT NOT NULL,
    "generation_timestamp" TIMESTAMP(3) NOT NULL,
    "result_status" "CouponResultStatus" NOT NULL DEFAULT 'PENDING',
    "settled_at" TIMESTAMP(3),
    "settlement_version" INTEGER,
    "winning_selection_count" INTEGER NOT NULL DEFAULT 0,
    "losing_selection_count" INTEGER NOT NULL DEFAULT 0,
    "void_selection_count" INTEGER NOT NULL DEFAULT 0,
    "effective_odds" DECIMAL(18,4),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coupon_selections" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "prediction_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "market_code" TEXT NOT NULL,
    "selection_code" TEXT NOT NULL,
    "odds" DECIMAL(12,3) NOT NULL,
    "probability" DECIMAL(9,8) NOT NULL,
    "implied_probability" DECIMAL(9,8) NOT NULL,
    "edge" DECIMAL(10,6) NOT NULL,
    "expected_value" DECIMAL(10,6) NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "result_status" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "coupon_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_coupons" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "system_type" TEXT NOT NULL,
    "base_selection_count" INTEGER NOT NULL,
    "system_selection_count" INTEGER NOT NULL,
    "column_count" INTEGER NOT NULL,
    "stake_per_column" DECIMAL(14,2) NOT NULL,
    "total_stake" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "result_status" "CouponResultStatus" NOT NULL DEFAULT 'PENDING',
    "winning_columns" INTEGER NOT NULL DEFAULT 0,
    "losing_columns" INTEGER NOT NULL DEFAULT 0,
    "void_columns" INTEGER NOT NULL DEFAULT 0,
    "total_return" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "net_profit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "roi" DECIMAL(10,6) NOT NULL DEFAULT 0,
    "settled_at" TIMESTAMP(3),
    "settlement_version" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "system_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_coupon_columns" (
    "id" TEXT NOT NULL,
    "system_coupon_id" TEXT NOT NULL,
    "column_index" INTEGER NOT NULL,
    "combined_odds" DECIMAL(18,4) NOT NULL,
    "stake" DECIMAL(14,2) NOT NULL,
    "result_status" "CouponResultStatus" NOT NULL DEFAULT 'PENDING',
    "return_amount" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "net_profit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_coupon_columns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_coupon_column_selections" (
    "id" TEXT NOT NULL,
    "column_id" TEXT NOT NULL,
    "coupon_selection_id" TEXT NOT NULL,

    CONSTRAINT "system_coupon_column_selections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "market_correlations" (
    "id" TEXT NOT NULL,
    "market_code_a" TEXT NOT NULL,
    "selection_code_a" TEXT,
    "market_code_b" TEXT NOT NULL,
    "selection_code_b" TEXT,
    "coefficient" DECIMAL(5,4) NOT NULL,
    "same_match_only" BOOLEAN NOT NULL DEFAULT true,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "market_correlations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtests" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "start_date" DATE NOT NULL,
    "end_date" DATE NOT NULL,
    "walk_forward_plan" JSONB NOT NULL,
    "configuration" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "total_bets" INTEGER NOT NULL DEFAULT 0,
    "winning_bets" INTEGER NOT NULL DEFAULT 0,
    "losing_bets" INTEGER NOT NULL DEFAULT 0,
    "void_bets" INTEGER NOT NULL DEFAULT 0,
    "hit_rate" DECIMAL(6,5),
    "average_odds" DECIMAL(12,4),
    "average_probability" DECIMAL(9,8),
    "average_edge" DECIMAL(10,6),
    "total_stake" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "profit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "roi" DECIMAL(10,6),
    "max_drawdown" DECIMAL(16,2),
    "brier_score" DECIMAL(10,8),
    "log_loss" DECIMAL(10,8),
    "calibration" JSONB,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backtest_predictions" (
    "id" TEXT NOT NULL,
    "backtest_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "market_code" TEXT NOT NULL,
    "selection_code" TEXT NOT NULL,
    "knowledge_cutoff" TIMESTAMP(3) NOT NULL,
    "probability" DECIMAL(9,8) NOT NULL,
    "odds" DECIMAL(12,3) NOT NULL,
    "implied_probability" DECIMAL(9,8) NOT NULL,
    "edge" DECIMAL(10,6) NOT NULL,
    "expected_value" DECIMAL(10,6) NOT NULL,
    "stake" DECIMAL(14,2) NOT NULL,
    "status" "SettlementStatus" NOT NULL,
    "payout" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "profit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "fold" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "backtest_predictions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "email_verified_at" TIMESTAMP(3),
    "name" TEXT,
    "password_hash" TEXT,
    "external_auth_id" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'USER',
    "locale" "Locale" NOT NULL DEFAULT 'EN',
    "stripe_customer_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "user_agent" TEXT,
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plans" (
    "id" TEXT NOT NULL,
    "code" "PlanCode" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "monthly_price" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "stripe_product_id" TEXT,
    "stripe_price_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscription_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_plan_features" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "feature_code" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "limit_value" INTEGER,

    CONSTRAINT "subscription_plan_features_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "external_customer_id" TEXT,
    "external_subscription_id" TEXT,
    "status" "SubscriptionStatus" NOT NULL,
    "current_period_start" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN NOT NULL DEFAULT false,
    "canceled_at" TIMESTAMP(3),
    "trial_end" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "payload_json" JSONB NOT NULL,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'stripe',
    "external_invoice_id" TEXT NOT NULL,
    "amount_due" DECIMAL(12,2) NOT NULL,
    "amount_paid" DECIMAL(12,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "hosted_invoice_url" TEXT,
    "pdf_url" TEXT,
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "issued_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_runs" (
    "id" TEXT NOT NULL,
    "job_name" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "run_key" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "items_processed" INTEGER NOT NULL DEFAULT 0,
    "items_failed" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_locks" (
    "key" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "acquired_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "job_locks_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "provider_request_logs" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "status_code" INTEGER,
    "duration_ms" INTEGER,
    "success" BOOLEAN NOT NULL DEFAULT true,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_request_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_statistics" (
    "id" TEXT NOT NULL,
    "bulletin_date" DATE NOT NULL,
    "category" "CouponCategory",
    "market_code" TEXT,
    "league_id" TEXT,
    "model_version_id" TEXT,
    "coupons_generated" INTEGER NOT NULL DEFAULT 0,
    "coupons_settled" INTEGER NOT NULL DEFAULT 0,
    "coupons_pending" INTEGER NOT NULL DEFAULT 0,
    "coupons_won" INTEGER NOT NULL DEFAULT 0,
    "coupons_lost" INTEGER NOT NULL DEFAULT 0,
    "coupons_void" INTEGER NOT NULL DEFAULT 0,
    "win_rate" DECIMAL(6,5),
    "average_odds" DECIMAL(12,4),
    "average_probability" DECIMAL(9,8),
    "average_edge" DECIMAL(10,6),
    "average_expected_value" DECIMAL(10,6),
    "total_stake" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "total_return" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "net_profit" DECIMAL(16,2) NOT NULL DEFAULT 0,
    "roi" DECIMAL(10,6),
    "system_winning_columns" INTEGER NOT NULL DEFAULT 0,
    "computed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "daily_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "translations_entity_type_entity_id_idx" ON "translations"("entity_type", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "translations_entity_type_entity_id_field_locale_key" ON "translations"("entity_type", "entity_id", "field", "locale");

-- CreateIndex
CREATE INDEX "leagues_active_country_idx" ON "leagues"("active", "country");

-- CreateIndex
CREATE UNIQUE INDEX "leagues_source_external_id_key" ON "leagues"("source", "external_id");

-- CreateIndex
CREATE INDEX "seasons_league_id_current_idx" ON "seasons"("league_id", "current");

-- CreateIndex
CREATE UNIQUE INDEX "seasons_source_external_id_key" ON "seasons"("source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "seasons_league_id_name_key" ON "seasons"("league_id", "name");

-- CreateIndex
CREATE INDEX "teams_name_idx" ON "teams"("name");

-- CreateIndex
CREATE UNIQUE INDEX "teams_source_external_id_key" ON "teams"("source", "external_id");

-- CreateIndex
CREATE INDEX "team_seasons_season_id_idx" ON "team_seasons"("season_id");

-- CreateIndex
CREATE UNIQUE INDEX "team_seasons_team_id_season_id_key" ON "team_seasons"("team_id", "season_id");

-- CreateIndex
CREATE INDEX "matches_scheduled_kickoff_utc_status_idx" ON "matches"("scheduled_kickoff_utc", "status");

-- CreateIndex
CREATE INDEX "matches_status_result_last_synced_at_idx" ON "matches"("status", "result_last_synced_at");

-- CreateIndex
CREATE INDEX "matches_league_id_scheduled_kickoff_utc_idx" ON "matches"("league_id", "scheduled_kickoff_utc");

-- CreateIndex
CREATE INDEX "matches_season_id_scheduled_kickoff_utc_idx" ON "matches"("season_id", "scheduled_kickoff_utc");

-- CreateIndex
CREATE INDEX "matches_home_team_id_scheduled_kickoff_utc_idx" ON "matches"("home_team_id", "scheduled_kickoff_utc");

-- CreateIndex
CREATE INDEX "matches_away_team_id_scheduled_kickoff_utc_idx" ON "matches"("away_team_id", "scheduled_kickoff_utc");

-- CreateIndex
CREATE UNIQUE INDEX "matches_source_external_id_key" ON "matches"("source", "external_id");

-- CreateIndex
CREATE INDEX "match_statistics_team_id_idx" ON "match_statistics"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "match_statistics_match_id_team_id_key" ON "match_statistics"("match_id", "team_id");

-- CreateIndex
CREATE INDEX "match_result_snapshots_match_id_captured_at_idx" ON "match_result_snapshots"("match_id", "captured_at");

-- CreateIndex
CREATE INDEX "team_form_snapshots_team_id_snapshot_date_idx" ON "team_form_snapshots"("team_id", "snapshot_date");

-- CreateIndex
CREATE UNIQUE INDEX "team_form_snapshots_team_id_snapshot_date_window_venue_scop_key" ON "team_form_snapshots"("team_id", "snapshot_date", "window", "venue_scope");

-- CreateIndex
CREATE INDEX "elo_ratings_team_id_rating_date_idx" ON "elo_ratings"("team_id", "rating_date");

-- CreateIndex
CREATE UNIQUE INDEX "elo_ratings_team_id_rating_date_key" ON "elo_ratings"("team_id", "rating_date");

-- CreateIndex
CREATE INDEX "head_to_head_home_team_id_away_team_id_match_date_idx" ON "head_to_head"("home_team_id", "away_team_id", "match_date");

-- CreateIndex
CREATE UNIQUE INDEX "head_to_head_match_id_key" ON "head_to_head"("match_id");

-- CreateIndex
CREATE INDEX "players_team_id_idx" ON "players"("team_id");

-- CreateIndex
CREATE UNIQUE INDEX "players_source_external_id_key" ON "players"("source", "external_id");

-- CreateIndex
CREATE INDEX "injuries_team_id_source_updated_at_idx" ON "injuries"("team_id", "source_updated_at");

-- CreateIndex
CREATE INDEX "injuries_player_id_source_updated_at_idx" ON "injuries"("player_id", "source_updated_at");

-- CreateIndex
CREATE INDEX "lineups_match_id_published_at_idx" ON "lineups"("match_id", "published_at");

-- CreateIndex
CREATE UNIQUE INDEX "lineups_match_id_player_id_type_key" ON "lineups"("match_id", "player_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "bookmakers_source_name_key" ON "bookmakers"("source", "name");

-- CreateIndex
CREATE UNIQUE INDEX "betting_markets_code_key" ON "betting_markets"("code");

-- CreateIndex
CREATE INDEX "betting_markets_category_active_idx" ON "betting_markets"("category", "active");

-- CreateIndex
CREATE INDEX "betting_selections_code_idx" ON "betting_selections"("code");

-- CreateIndex
CREATE UNIQUE INDEX "betting_selections_market_id_code_key" ON "betting_selections"("market_id", "code");

-- CreateIndex
CREATE INDEX "odds_match_id_selection_id_captured_at_idx" ON "odds"("match_id", "selection_id", "captured_at");

-- CreateIndex
CREATE INDEX "odds_match_id_captured_at_idx" ON "odds"("match_id", "captured_at");

-- CreateIndex
CREATE INDEX "odds_selection_id_captured_at_idx" ON "odds"("selection_id", "captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "odds_match_id_bookmaker_id_selection_id_handicap_captured_a_key" ON "odds"("match_id", "bookmaker_id", "selection_id", "handicap", "captured_at");

-- CreateIndex
CREATE INDEX "model_versions_active_idx" ON "model_versions"("active");

-- CreateIndex
CREATE UNIQUE INDEX "model_versions_name_version_key" ON "model_versions"("name", "version");

-- CreateIndex
CREATE INDEX "predictions_match_id_model_version_id_idx" ON "predictions"("match_id", "model_version_id");

-- CreateIndex
CREATE INDEX "predictions_model_version_id_prediction_timestamp_idx" ON "predictions"("model_version_id", "prediction_timestamp");

-- CreateIndex
CREATE INDEX "predictions_status_prediction_timestamp_idx" ON "predictions"("status", "prediction_timestamp");

-- CreateIndex
CREATE INDEX "predictions_recommended_expected_value_idx" ON "predictions"("recommended", "expected_value");

-- CreateIndex
CREATE UNIQUE INDEX "predictions_match_id_selection_id_model_version_id_predicti_key" ON "predictions"("match_id", "selection_id", "model_version_id", "prediction_timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "app_settings_key_key" ON "app_settings"("key");

-- CreateIndex
CREATE INDEX "app_settings_category_idx" ON "app_settings"("category");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_category_settings_category_key" ON "coupon_category_settings"("category");

-- CreateIndex
CREATE UNIQUE INDEX "settings_snapshots_checksum_key" ON "settings_snapshots"("checksum");

-- CreateIndex
CREATE INDEX "settings_audit_logs_scope_created_at_idx" ON "settings_audit_logs"("scope", "created_at");

-- CreateIndex
CREATE INDEX "coupon_generation_runs_bulletin_date_idx" ON "coupon_generation_runs"("bulletin_date");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_generation_runs_bulletin_date_model_version_id_key" ON "coupon_generation_runs"("bulletin_date", "model_version_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupons_reference_key" ON "coupons"("reference");

-- CreateIndex
CREATE INDEX "coupons_bulletin_date_category_idx" ON "coupons"("bulletin_date", "category");

-- CreateIndex
CREATE INDEX "coupons_category_result_status_idx" ON "coupons"("category", "result_status");

-- CreateIndex
CREATE INDEX "coupons_generation_run_id_idx" ON "coupons"("generation_run_id");

-- CreateIndex
CREATE INDEX "coupon_selections_coupon_id_sort_order_idx" ON "coupon_selections"("coupon_id", "sort_order");

-- CreateIndex
CREATE INDEX "coupon_selections_match_id_idx" ON "coupon_selections"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_selections_coupon_id_prediction_id_key" ON "coupon_selections"("coupon_id", "prediction_id");

-- CreateIndex
CREATE UNIQUE INDEX "system_coupons_coupon_id_key" ON "system_coupons"("coupon_id");

-- CreateIndex
CREATE INDEX "system_coupon_columns_system_coupon_id_result_status_idx" ON "system_coupon_columns"("system_coupon_id", "result_status");

-- CreateIndex
CREATE UNIQUE INDEX "system_coupon_columns_system_coupon_id_column_index_key" ON "system_coupon_columns"("system_coupon_id", "column_index");

-- CreateIndex
CREATE INDEX "system_coupon_column_selections_coupon_selection_id_idx" ON "system_coupon_column_selections"("coupon_selection_id");

-- CreateIndex
CREATE UNIQUE INDEX "system_coupon_column_selections_column_id_coupon_selection__key" ON "system_coupon_column_selections"("column_id", "coupon_selection_id");

-- CreateIndex
CREATE UNIQUE INDEX "market_correlations_market_code_a_selection_code_a_market_c_key" ON "market_correlations"("market_code_a", "selection_code_a", "market_code_b", "selection_code_b");

-- CreateIndex
CREATE INDEX "backtests_model_version_id_created_at_idx" ON "backtests"("model_version_id", "created_at");

-- CreateIndex
CREATE INDEX "backtest_predictions_backtest_id_knowledge_cutoff_idx" ON "backtest_predictions"("backtest_id", "knowledge_cutoff");

-- CreateIndex
CREATE INDEX "backtest_predictions_backtest_id_fold_idx" ON "backtest_predictions"("backtest_id", "fold");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_external_auth_id_key" ON "users"("external_auth_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_stripe_customer_id_key" ON "users"("stripe_customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_expires_at_idx" ON "sessions"("user_id", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_code_key" ON "subscription_plans"("code");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plans_stripe_price_id_key" ON "subscription_plans"("stripe_price_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_plan_features_plan_id_feature_code_key" ON "subscription_plan_features"("plan_id", "feature_code");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_external_subscription_id_key" ON "subscriptions"("external_subscription_id");

-- CreateIndex
CREATE INDEX "subscriptions_user_id_status_idx" ON "subscriptions"("user_id", "status");

-- CreateIndex
CREATE INDEX "subscriptions_status_current_period_end_idx" ON "subscriptions"("status", "current_period_end");

-- CreateIndex
CREATE INDEX "subscription_events_processed_at_idx" ON "subscription_events"("processed_at");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_events_provider_external_event_id_key" ON "subscription_events"("provider", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_external_invoice_id_key" ON "invoices"("external_invoice_id");

-- CreateIndex
CREATE INDEX "invoices_user_id_issued_at_idx" ON "invoices"("user_id", "issued_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_runs_run_key_key" ON "job_runs"("run_key");

-- CreateIndex
CREATE INDEX "job_runs_job_name_created_at_idx" ON "job_runs"("job_name", "created_at");

-- CreateIndex
CREATE INDEX "job_runs_status_idx" ON "job_runs"("status");

-- CreateIndex
CREATE INDEX "job_locks_expires_at_idx" ON "job_locks"("expires_at");

-- CreateIndex
CREATE INDEX "provider_request_logs_provider_created_at_idx" ON "provider_request_logs"("provider", "created_at");

-- CreateIndex
CREATE INDEX "provider_request_logs_success_created_at_idx" ON "provider_request_logs"("success", "created_at");

-- CreateIndex
CREATE INDEX "daily_statistics_bulletin_date_idx" ON "daily_statistics"("bulletin_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_statistics_bulletin_date_category_market_code_league__key" ON "daily_statistics"("bulletin_date", "category", "market_code", "league_id", "model_version_id");

-- AddForeignKey
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_seasons" ADD CONSTRAINT "team_seasons_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_seasons" ADD CONSTRAINT "team_seasons_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_home_team_id_fkey" FOREIGN KEY ("home_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "matches" ADD CONSTRAINT "matches_away_team_id_fkey" FOREIGN KEY ("away_team_id") REFERENCES "teams"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_statistics" ADD CONSTRAINT "match_statistics_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_statistics" ADD CONSTRAINT "match_statistics_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "match_result_snapshots" ADD CONSTRAINT "match_result_snapshots_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "team_form_snapshots" ADD CONSTRAINT "team_form_snapshots_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "elo_ratings" ADD CONSTRAINT "elo_ratings_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "elo_ratings" ADD CONSTRAINT "elo_ratings_league_id_fkey" FOREIGN KEY ("league_id") REFERENCES "leagues"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_to_head" ADD CONSTRAINT "head_to_head_home_team_id_fkey" FOREIGN KEY ("home_team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_to_head" ADD CONSTRAINT "head_to_head_away_team_id_fkey" FOREIGN KEY ("away_team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "head_to_head" ADD CONSTRAINT "head_to_head_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "players" ADD CONSTRAINT "players_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "injuries" ADD CONSTRAINT "injuries_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "injuries" ADD CONSTRAINT "injuries_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lineups" ADD CONSTRAINT "lineups_player_id_fkey" FOREIGN KEY ("player_id") REFERENCES "players"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "betting_selections" ADD CONSTRAINT "betting_selections_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "betting_markets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds" ADD CONSTRAINT "odds_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds" ADD CONSTRAINT "odds_bookmaker_id_fkey" FOREIGN KEY ("bookmaker_id") REFERENCES "bookmakers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds" ADD CONSTRAINT "odds_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "betting_markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "odds" ADD CONSTRAINT "odds_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "betting_selections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_market_id_fkey" FOREIGN KEY ("market_id") REFERENCES "betting_markets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_selection_id_fkey" FOREIGN KEY ("selection_id") REFERENCES "betting_selections"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "predictions" ADD CONSTRAINT "predictions_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings_audit_logs" ADD CONSTRAINT "settings_audit_logs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_generation_runs" ADD CONSTRAINT "coupon_generation_runs_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_generation_runs" ADD CONSTRAINT "coupon_generation_runs_settings_snapshot_id_fkey" FOREIGN KEY ("settings_snapshot_id") REFERENCES "settings_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_generation_run_id_fkey" FOREIGN KEY ("generation_run_id") REFERENCES "coupon_generation_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupons" ADD CONSTRAINT "coupons_settings_snapshot_id_fkey" FOREIGN KEY ("settings_snapshot_id") REFERENCES "settings_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_selections" ADD CONSTRAINT "coupon_selections_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_selections" ADD CONSTRAINT "coupon_selections_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "predictions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coupon_selections" ADD CONSTRAINT "coupon_selections_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_coupons" ADD CONSTRAINT "system_coupons_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_coupon_columns" ADD CONSTRAINT "system_coupon_columns_system_coupon_id_fkey" FOREIGN KEY ("system_coupon_id") REFERENCES "system_coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_coupon_column_selections" ADD CONSTRAINT "system_coupon_column_selections_column_id_fkey" FOREIGN KEY ("column_id") REFERENCES "system_coupon_columns"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_coupon_column_selections" ADD CONSTRAINT "system_coupon_column_selections_coupon_selection_id_fkey" FOREIGN KEY ("coupon_selection_id") REFERENCES "coupon_selections"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_model_version_id_fkey" FOREIGN KEY ("model_version_id") REFERENCES "model_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backtest_predictions" ADD CONSTRAINT "backtest_predictions_backtest_id_fkey" FOREIGN KEY ("backtest_id") REFERENCES "backtests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_plan_features" ADD CONSTRAINT "subscription_plan_features_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_plan_id_fkey" FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ===========================================================================
-- CHECK CONSTRAINTS
-- Prisma has no first-class CHECK support, so the domain invariants that must
-- never be violated live here. They are the last line of defence behind Zod.
-- ===========================================================================

-- Football core -------------------------------------------------------------
ALTER TABLE "matches"
  ADD CONSTRAINT "matches_distinct_teams" CHECK ("home_team_id" <> "away_team_id"),
  ADD CONSTRAINT "matches_scores_non_negative" CHECK (
    ("home_score" IS NULL OR "home_score" >= 0) AND
    ("away_score" IS NULL OR "away_score" >= 0) AND
    ("half_time_home_score" IS NULL OR "half_time_home_score" >= 0) AND
    ("half_time_away_score" IS NULL OR "half_time_away_score" >= 0)
  ),
  ADD CONSTRAINT "matches_halftime_not_above_fulltime" CHECK (
    "half_time_home_score" IS NULL OR "home_score" IS NULL OR "half_time_home_score" <= "home_score"
  );

ALTER TABLE "leagues"
  ADD CONSTRAINT "leagues_data_quality_range" CHECK ("data_quality" >= 0 AND "data_quality" <= 1);

ALTER TABLE "team_form_snapshots"
  ADD CONSTRAINT "team_form_rates_range" CHECK (
    "clean_sheet_rate" BETWEEN 0 AND 1 AND
    "btts_rate" BETWEEN 0 AND 1 AND
    "over_1_5_rate" BETWEEN 0 AND 1 AND
    "over_2_5_rate" BETWEEN 0 AND 1 AND
    "over_3_5_rate" BETWEEN 0 AND 1
  ),
  ADD CONSTRAINT "team_form_counts_consistent" CHECK (
    "matches_played" >= 0 AND "wins" >= 0 AND "draws" >= 0 AND "losses" >= 0 AND
    "wins" + "draws" + "losses" = "matches_played"
  );

-- Prices --------------------------------------------------------------------
ALTER TABLE "bookmakers"
  ADD CONSTRAINT "bookmakers_reliability_range" CHECK ("reliability" >= 0 AND "reliability" <= 1);

-- Decimal odds are strictly greater than 1.0; anything else is a parse error.
ALTER TABLE "odds"
  ADD CONSTRAINT "odds_price_valid" CHECK ("price" > 1);

-- Predictions ---------------------------------------------------------------
ALTER TABLE "predictions"
  ADD CONSTRAINT "predictions_probability_range" CHECK ("probability" >= 0 AND "probability" <= 1),
  ADD CONSTRAINT "predictions_implied_range" CHECK (
    "implied_probability" IS NULL OR ("implied_probability" >= 0 AND "implied_probability" <= 1)
  ),
  ADD CONSTRAINT "predictions_scores_range" CHECK (
    "confidence_score" BETWEEN 0 AND 1 AND
    "risk_score" BETWEEN 0 AND 1 AND
    "data_quality_score" BETWEEN 0 AND 1
  ),
  ADD CONSTRAINT "predictions_odds_valid" CHECK ("odds_used" IS NULL OR "odds_used" > 1);

-- Coupons -------------------------------------------------------------------
ALTER TABLE "coupons"
  ADD CONSTRAINT "coupons_total_odds_valid" CHECK ("total_odds" >= 1),
  ADD CONSTRAINT "coupons_selection_count_positive" CHECK ("selection_count" > 0),
  ADD CONSTRAINT "coupons_probability_range" CHECK ("estimated_probability" >= 0 AND "estimated_probability" <= 1),
  ADD CONSTRAINT "coupons_scores_range" CHECK (
    "confidence_score" BETWEEN 0 AND 1 AND
    "risk_score" BETWEEN 0 AND 1 AND
    "correlation_score" BETWEEN 0 AND 1 AND
    "diversification_score" BETWEEN 0 AND 1
  );

ALTER TABLE "coupon_selections"
  ADD CONSTRAINT "coupon_selections_odds_valid" CHECK ("odds" > 1),
  ADD CONSTRAINT "coupon_selections_probability_range" CHECK ("probability" >= 0 AND "probability" <= 1);

-- System (combination) coupons ---------------------------------------------
ALTER TABLE "system_coupons"
  ADD CONSTRAINT "system_coupons_k_within_n" CHECK (
    "system_selection_count" >= 1 AND "system_selection_count" <= "base_selection_count"
  ),
  ADD CONSTRAINT "system_coupons_columns_positive" CHECK ("column_count" > 0),
  ADD CONSTRAINT "system_coupons_stake_non_negative" CHECK ("stake_per_column" >= 0 AND "total_stake" >= 0),
  -- total_stake = column_count * stake_per_column (§18). Enforced, not assumed.
  ADD CONSTRAINT "system_coupons_total_stake_consistent" CHECK (
    "total_stake" = "column_count" * "stake_per_column"
  ),
  ADD CONSTRAINT "system_coupons_column_tally" CHECK (
    "winning_columns" + "losing_columns" + "void_columns" <= "column_count"
  );

ALTER TABLE "system_coupon_columns"
  ADD CONSTRAINT "system_columns_odds_valid" CHECK ("combined_odds" >= 1),
  ADD CONSTRAINT "system_columns_stake_non_negative" CHECK ("stake" >= 0);

ALTER TABLE "market_correlations"
  ADD CONSTRAINT "market_correlations_coefficient_range" CHECK ("coefficient" >= -1 AND "coefficient" <= 1);

-- Configuration -------------------------------------------------------------
-- Impossible configurations can never be persisted (§17).
ALTER TABLE "coupon_category_settings"
  ADD CONSTRAINT "ccs_coupon_count_positive" CHECK ("coupon_count" > 0),
  ADD CONSTRAINT "ccs_odds_range_ordered" CHECK (
    "max_total_odds" IS NULL OR "min_total_odds" <= "max_total_odds"
  ),
  ADD CONSTRAINT "ccs_min_total_odds_valid" CHECK ("min_total_odds" >= 1),
  ADD CONSTRAINT "ccs_selections_ordered" CHECK (
    "min_selections" >= 1 AND "min_selections" <= "max_selections"
  ),
  ADD CONSTRAINT "ccs_thresholds_range" CHECK (
    "min_confidence" BETWEEN 0 AND 1 AND
    "min_probability" BETWEEN 0 AND 1 AND
    "max_risk" BETWEEN 0 AND 1 AND
    "max_correlation" BETWEEN 0 AND 1 AND
    "min_data_quality" BETWEEN 0 AND 1
  );

ALTER TABLE "system_coupon_settings"
  ADD CONSTRAINT "scs_base_selections_ordered" CHECK (
    "min_base_selections" >= 2 AND "min_base_selections" <= "max_base_selections"
  ),
  ADD CONSTRAINT "scs_stake_non_negative" CHECK ("stake_per_column" >= 0 AND "max_total_stake" >= 0),
  ADD CONSTRAINT "scs_coupon_count_non_negative" CHECK ("coupon_count" >= 0),
  ADD CONSTRAINT "scs_thresholds_range" CHECK (
    "min_combined_probability" BETWEEN 0 AND 1 AND
    "max_correlation" BETWEEN 0 AND 1
  );

-- Billing -------------------------------------------------------------------
ALTER TABLE "subscription_plans"
  ADD CONSTRAINT "plans_price_non_negative" CHECK ("monthly_price" >= 0);

ALTER TABLE "subscriptions"
  ADD CONSTRAINT "subscriptions_period_ordered" CHECK (
    "current_period_start" IS NULL OR "current_period_end" IS NULL OR
    "current_period_start" <= "current_period_end"
  );

ALTER TABLE "backtests"
  ADD CONSTRAINT "backtests_date_range_ordered" CHECK ("start_date" <= "end_date");

-- ===========================================================================
-- PARTIAL / COVERING INDEXES for the hot paths
-- ===========================================================================

-- "Which matches still need a result?" — the polling job's main query (§31).
CREATE INDEX "matches_awaiting_result_idx"
  ON "matches" ("scheduled_kickoff_utc", "result_last_synced_at")
  WHERE "status" IN ('SCHEDULED', 'LIVE', 'HALF_TIME', 'SUSPENDED');

-- Latest price per selection: odds is append-only, so reads always want DESC.
CREATE INDEX "odds_latest_per_selection_idx"
  ON "odds" ("match_id", "selection_id", "captured_at" DESC);

-- Closing-line comparison for model evaluation.
CREATE INDEX "odds_closing_idx"
  ON "odds" ("match_id", "selection_id")
  WHERE "is_closing" = true;

-- Candidate pool for the coupon generator.
CREATE INDEX "predictions_candidates_idx"
  ON "predictions" ("prediction_timestamp", "expected_value" DESC)
  WHERE "recommended" = true AND "status" = 'PENDING';

-- Unsettled coupons, scanned by CouponSettlementJob.
CREATE INDEX "coupons_pending_settlement_idx"
  ON "coupons" ("bulletin_date")
  WHERE "result_status" = 'PENDING';

CREATE INDEX "system_columns_pending_idx"
  ON "system_coupon_columns" ("system_coupon_id")
  WHERE "result_status" = 'PENDING';

-- Webhook inbox drain.
CREATE INDEX "subscription_events_unprocessed_idx"
  ON "subscription_events" ("created_at")
  WHERE "processed_at" IS NULL;

-- One active subscription per user per provider.
CREATE UNIQUE INDEX "subscriptions_one_active_per_user_idx"
  ON "subscriptions" ("user_id", "provider")
  WHERE "status" IN ('TRIALING', 'ACTIVE', 'PAST_DUE');
