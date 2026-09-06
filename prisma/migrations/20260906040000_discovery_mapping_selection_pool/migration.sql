-- AlterTable
ALTER TABLE "provider_request_logs" ADD COLUMN     "bookmaker_count" INTEGER,
ADD COLUMN     "events_returned" INTEGER,
ADD COLUMN     "market_count" INTEGER,
ADD COLUMN     "sport_key" TEXT;

-- CreateTable
CREATE TABLE "discovered_fixtures" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "external_event_id" TEXT NOT NULL,
    "sport_key" TEXT NOT NULL,
    "sport_title" TEXT,
    "commence_time_utc" TIMESTAMP(3) NOT NULL,
    "home_team_name" TEXT NOT NULL,
    "away_team_name" TEXT NOT NULL,
    "bookmaker_count" INTEGER,
    "market_count" INTEGER,
    "odds_last_checked_at" TIMESTAMP(3),
    "match_id" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "discovered_fixtures_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_match_mappings" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "the_odds_event_id" TEXT,
    "api_football_fixture_id" TEXT,
    "confidence" DECIMAL(5,4) NOT NULL,
    "matching_method" TEXT NOT NULL,
    "detail" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "external_match_mappings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "selection_pool" (
    "id" TEXT NOT NULL,
    "generation_run_id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "prediction_id" TEXT NOT NULL,
    "market_code" TEXT NOT NULL,
    "selection_code" TEXT NOT NULL,
    "odds" DECIMAL(12,3) NOT NULL,
    "odds_source" TEXT NOT NULL,
    "odds_captured_at" TIMESTAMP(3) NOT NULL,
    "odds_age_minutes" INTEGER NOT NULL,
    "odds_freshness" TEXT NOT NULL,
    "bookmaker_count" INTEGER NOT NULL DEFAULT 1,
    "model_probability" DECIMAL(9,8) NOT NULL,
    "market_probability" DECIMAL(9,8),
    "fair_odds" DECIMAL(12,3),
    "probability_edge" DECIMAL(10,6),
    "expected_value" DECIMAL(10,6) NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "risk_score" DECIMAL(5,4) NOT NULL,
    "data_quality_score" DECIMAL(5,4) NOT NULL,
    "diversity_score" DECIMAL(5,4) NOT NULL,
    "eligible" BOOLEAN NOT NULL DEFAULT false,
    "reason_codes" TEXT[],
    "league_id" TEXT NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "category" TEXT,
    "built_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "selection_pool_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "discovered_fixtures_commence_time_utc_idx" ON "discovered_fixtures"("commence_time_utc");

-- CreateIndex
CREATE INDEX "discovered_fixtures_sport_key_commence_time_utc_idx" ON "discovered_fixtures"("sport_key", "commence_time_utc");

-- CreateIndex
CREATE INDEX "discovered_fixtures_match_id_idx" ON "discovered_fixtures"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "discovered_fixtures_source_external_event_id_key" ON "discovered_fixtures"("source", "external_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_match_mappings_match_id_key" ON "external_match_mappings"("match_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_match_mappings_the_odds_event_id_key" ON "external_match_mappings"("the_odds_event_id");

-- CreateIndex
CREATE INDEX "external_match_mappings_confidence_idx" ON "external_match_mappings"("confidence");

-- CreateIndex
CREATE INDEX "selection_pool_generation_run_id_eligible_idx" ON "selection_pool"("generation_run_id", "eligible");

-- CreateIndex
CREATE INDEX "selection_pool_built_at_idx" ON "selection_pool"("built_at");

-- CreateIndex
CREATE UNIQUE INDEX "selection_pool_generation_run_id_match_id_selection_code_key" ON "selection_pool"("generation_run_id", "match_id", "selection_code");

-- AddForeignKey
ALTER TABLE "discovered_fixtures" ADD CONSTRAINT "discovered_fixtures_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_match_mappings" ADD CONSTRAINT "external_match_mappings_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "selection_pool" ADD CONSTRAINT "selection_pool_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "selection_pool" ADD CONSTRAINT "selection_pool_prediction_id_fkey" FOREIGN KEY ("prediction_id") REFERENCES "predictions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

