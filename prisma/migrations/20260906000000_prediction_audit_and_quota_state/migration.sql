-- CreateEnum
CREATE TYPE "PredictionCoverageReason" AS ENUM ('PREDICTED', 'NO_ODDS', 'STALE_ODDS', 'NO_FEATURES', 'INSUFFICIENT_HISTORY', 'MODEL_ERROR', 'EXCLUDED', 'QUOTA_EXHAUSTED', 'INVALID_FIXTURE');

-- AlterTable
ALTER TABLE "predictions" ADD COLUMN     "fair_odds" DECIMAL(12,3),
ADD COLUMN     "market_probability" DECIMAL(9,8),
ADD COLUMN     "model_config_version" TEXT,
ADD COLUMN     "odds_age_minutes" INTEGER,
ADD COLUMN     "odds_captured_at" TIMESTAMP(3),
ADD COLUMN     "superseded_at" TIMESTAMP(3),
ADD COLUMN     "superseded_reason" TEXT;

-- CreateTable
CREATE TABLE "prediction_coverage" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "model_version_id" TEXT NOT NULL,
    "reason" "PredictionCoverageReason" NOT NULL,
    "selections_priced" INTEGER NOT NULL DEFAULT 0,
    "predictions_made" INTEGER NOT NULL DEFAULT 0,
    "recommendations" INTEGER NOT NULL DEFAULT 0,
    "odds_captured_at" TIMESTAMP(3),
    "odds_age_minutes" INTEGER,
    "detail" JSONB,
    "run_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "prediction_coverage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_quota_states" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "budget" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "remaining" INTEGER NOT NULL DEFAULT 0,
    "window_start" TIMESTAMP(3) NOT NULL,
    "window_end" TIMESTAMP(3) NOT NULL,
    "exhausted" BOOLEAN NOT NULL DEFAULT false,
    "exhausted_at" TIMESTAMP(3),
    "reset_at" TIMESTAMP(3),
    "endpoint_usage" JSONB,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_quota_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "prediction_coverage_run_at_reason_idx" ON "prediction_coverage"("run_at", "reason");

-- CreateIndex
CREATE UNIQUE INDEX "prediction_coverage_match_id_model_version_id_run_at_key" ON "prediction_coverage"("match_id", "model_version_id", "run_at");

-- CreateIndex
CREATE UNIQUE INDEX "provider_quota_states_provider_key" ON "provider_quota_states"("provider");

-- CreateIndex
CREATE INDEX "predictions_superseded_at_idx" ON "predictions"("superseded_at");

-- AddForeignKey
ALTER TABLE "prediction_coverage" ADD CONSTRAINT "prediction_coverage_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

