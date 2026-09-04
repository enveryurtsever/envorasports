-- DropIndex
-- Redundant: odds_match_id_selection_id_captured_at_idx already covers this
-- column set, and Postgres scans a b-tree backwards just as cheaply, so the
-- extra DESC index only cost write throughput on the largest table.
DROP INDEX IF EXISTS "odds_latest_per_selection_idx";

-- AlterTable
ALTER TABLE "leagues" ADD COLUMN     "csv_division" TEXT,
ADD COLUMN     "odds_api_key" TEXT;

-- AlterTable
ALTER TABLE "provider_request_logs" ADD COLUMN     "cost" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "quota_remaining" INTEGER;

-- CreateTable
CREATE TABLE "team_aliases" (
    "id" TEXT NOT NULL,
    "team_id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "alias" TEXT NOT NULL,
    "normalized" TEXT NOT NULL,
    "confidence" DECIMAL(4,3) NOT NULL DEFAULT 1,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "team_aliases_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "team_aliases_team_id_idx" ON "team_aliases"("team_id");

-- CreateIndex
CREATE INDEX "team_aliases_normalized_idx" ON "team_aliases"("normalized");

-- CreateIndex
CREATE UNIQUE INDEX "team_aliases_source_normalized_key" ON "team_aliases"("source", "normalized");

-- AddForeignKey
ALTER TABLE "team_aliases" ADD CONSTRAINT "team_aliases_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

