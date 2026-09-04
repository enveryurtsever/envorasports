-- AlterTable
ALTER TABLE "matches" ADD COLUMN     "excluded_from_generation" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "exclusion_reason" TEXT;

