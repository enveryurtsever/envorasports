-- CreateEnum
CREATE TYPE "CoverageGrouping" AS ENUM ('PER_DAY', 'WINDOW');

-- DropIndex
DROP INDEX "coupon_generation_runs_bulletin_date_idx";

-- DropIndex
DROP INDEX "coupon_generation_runs_bulletin_date_model_version_id_key";

-- DropIndex
DROP INDEX "coupons_bulletin_date_category_idx";

-- DropIndex
DROP INDEX "daily_statistics_bulletin_date_category_market_code_league__key";

-- DropIndex
DROP INDEX "daily_statistics_bulletin_date_idx";

-- AlterTable
ALTER TABLE "coupon_generation_runs" DROP COLUMN "bulletin_date",
ADD COLUMN     "coverage_end_date" DATE NOT NULL,
ADD COLUMN     "coverage_start_date" DATE NOT NULL,
ADD COLUMN     "grouping" "CoverageGrouping" NOT NULL DEFAULT 'PER_DAY',
ADD COLUMN     "publication_date" DATE NOT NULL,
ADD COLUMN     "schedule_timezone" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "coupons" DROP COLUMN "bulletin_date",
ADD COLUMN     "first_kickoff_utc" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "last_kickoff_utc" TIMESTAMP(3) NOT NULL,
ADD COLUMN     "target_date" DATE NOT NULL;

-- AlterTable
ALTER TABLE "daily_statistics" DROP COLUMN "bulletin_date",
ADD COLUMN     "target_date" DATE NOT NULL;

-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "odds_event_external_id" TEXT;

-- CreateTable
CREATE TABLE "bulletin_schedule_settings" (
    "id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "timezone" TEXT NOT NULL DEFAULT 'Europe/Istanbul',
    "publication_weekdays" INTEGER[],
    "coverage_offset_days" INTEGER NOT NULL DEFAULT 1,
    "coverage_days" INTEGER NOT NULL DEFAULT 3,
    "publish_time_local" TEXT NOT NULL DEFAULT '09:00',
    "grouping" "CoverageGrouping" NOT NULL DEFAULT 'PER_DAY',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bulletin_schedule_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "coupon_generation_runs_publication_date_idx" ON "coupon_generation_runs"("publication_date");

-- CreateIndex
CREATE INDEX "coupon_generation_runs_coverage_start_date_coverage_end_dat_idx" ON "coupon_generation_runs"("coverage_start_date", "coverage_end_date");

-- CreateIndex
CREATE UNIQUE INDEX "coupon_generation_runs_publication_date_model_version_id_key" ON "coupon_generation_runs"("publication_date", "model_version_id");

-- CreateIndex
CREATE INDEX "coupons_target_date_category_idx" ON "coupons"("target_date", "category");

-- CreateIndex
CREATE INDEX "coupons_last_kickoff_utc_result_status_idx" ON "coupons"("last_kickoff_utc", "result_status");

-- CreateIndex
CREATE INDEX "daily_statistics_target_date_idx" ON "daily_statistics"("target_date");

-- CreateIndex
CREATE UNIQUE INDEX "daily_statistics_target_date_category_market_code_league_id_key" ON "daily_statistics"("target_date", "category", "market_code", "league_id", "model_version_id");

-- CreateIndex
CREATE INDEX "matches_odds_event_external_id_idx" ON "matches"("odds_event_external_id");


-- ===========================================================================
-- Rebuild the partial index that hung off the dropped bulletin_date column.
-- Postgres drops dependent indexes with the column, so this is a recreate,
-- not a duplicate.
-- ===========================================================================
DROP INDEX IF EXISTS "coupons_pending_settlement_idx";

CREATE INDEX "coupons_pending_settlement_idx"
  ON "coupons" ("last_kickoff_utc")
  WHERE "result_status" = 'PENDING';

-- "Which coupons are ready to grade?" — every selection has kicked off and the
-- coupon is still open. This is the settlement job's driving query.
CREATE INDEX "coupons_target_day_idx"
  ON "coupons" ("target_date", "category", "result_status");
