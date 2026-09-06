-- CreateEnum
CREATE TYPE "HayalSignalSource" AS ENUM ('NONE', 'MARKET', 'PROXY');

-- AlterTable
ALTER TABLE "hayal_signals" ADD COLUMN     "btts_first_half_odds" DECIMAL(12,3),
ADD COLUMN     "btts_second_half_odds" DECIMAL(12,3),
ADD COLUMN     "proxy_both_halves_odds" DECIMAL(12,3),
ADD COLUMN     "signal_source" "HayalSignalSource" NOT NULL DEFAULT 'NONE';

