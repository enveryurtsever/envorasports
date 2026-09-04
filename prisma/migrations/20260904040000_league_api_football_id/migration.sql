-- DropIndex
DROP INDEX "coupons_target_day_idx";

-- AlterTable
ALTER TABLE "leagues" ADD COLUMN     "api_football_id" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "leagues_api_football_id_key" ON "leagues"("api_football_id");

