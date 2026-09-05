-- A floor on the chance the whole coupon lands, as opposed to minProbability
-- which bounds a single leg. It trades directly against min_total_odds: an
-- honest coupon prices at roughly 1/probability, so a high floor here caps the
-- odds. Both bounds are enforced, and a category configured with an impossible
-- pair produces nothing and records why.
ALTER TABLE "coupon_category_settings"
  ADD COLUMN IF NOT EXISTS "min_combined_probability" DECIMAL(9, 8) NOT NULL DEFAULT 0;

ALTER TABLE "coupon_category_settings"
  DROP CONSTRAINT IF EXISTS "ccs_min_combined_probability_range";

ALTER TABLE "coupon_category_settings"
  ADD CONSTRAINT "ccs_min_combined_probability_range"
  CHECK ("min_combined_probability" >= 0 AND "min_combined_probability" <= 1);
