-- CreateEnum
CREATE TYPE "HayalVariant" AS ENUM ('HAYAL_NORMAL', 'HAYAL_STRONG', 'HAYAL_PREMIUM', 'HAYAL_CRAZY');

-- AlterEnum
ALTER TYPE "CouponCategory" ADD VALUE 'HAYAL';

-- CreateTable
CREATE TABLE "hayal_signals" (
    "id" TEXT NOT NULL,
    "match_id" TEXT NOT NULL,
    "btts_both_halves_odds" DECIMAL(12,3),
    "half_time_2_2_odds" DECIMAL(12,3),
    "btts_under_threshold" BOOLEAN NOT NULL,
    "ht22_under_threshold" BOOLEAN NOT NULL,
    "btts_threshold" DECIMAL(12,3) NOT NULL,
    "ht22_threshold" DECIMAL(12,3) NOT NULL,
    "premium" BOOLEAN NOT NULL DEFAULT false,
    "signal_captured_at" TIMESTAMP(3) NOT NULL,
    "odds_captured_at" TIMESTAMP(3),
    "match_start_time" TIMESTAMP(3) NOT NULL,
    "outcomes" JSONB,
    "settled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hayal_signals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hayal_coupons" (
    "id" TEXT NOT NULL,
    "coupon_id" TEXT NOT NULL,
    "variant" "HayalVariant" NOT NULL,
    "combined_probability" DECIMAL(9,8) NOT NULL,
    "average_selection_strength" DECIMAL(9,8) NOT NULL,
    "signals" JSONB NOT NULL,
    "signal_captured_at" TIMESTAMP(3) NOT NULL,
    "odds_captured_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hayal_coupons_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "hayal_signals_premium_match_start_time_idx" ON "hayal_signals"("premium", "match_start_time");

-- CreateIndex
CREATE INDEX "hayal_signals_match_start_time_idx" ON "hayal_signals"("match_start_time");

-- CreateIndex
CREATE UNIQUE INDEX "hayal_signals_match_id_signal_captured_at_key" ON "hayal_signals"("match_id", "signal_captured_at");

-- CreateIndex
CREATE UNIQUE INDEX "hayal_coupons_coupon_id_key" ON "hayal_coupons"("coupon_id");

-- CreateIndex
CREATE INDEX "hayal_coupons_variant_idx" ON "hayal_coupons"("variant");

-- AddForeignKey
ALTER TABLE "hayal_signals" ADD CONSTRAINT "hayal_signals_match_id_fkey" FOREIGN KEY ("match_id") REFERENCES "matches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hayal_coupons" ADD CONSTRAINT "hayal_coupons_coupon_id_fkey" FOREIGN KEY ("coupon_id") REFERENCES "coupons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

