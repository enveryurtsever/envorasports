-- A coupon count of zero is a valid configuration: it means "generate none of
-- this category". The original constraint demanded a positive count, which
-- contradicted the Zod schema (min 0) and made a category impossible to switch
-- off through the admin UI.
ALTER TABLE "coupon_category_settings"
  DROP CONSTRAINT IF EXISTS "ccs_coupon_count_positive";

ALTER TABLE "coupon_category_settings"
  ADD CONSTRAINT "ccs_coupon_count_non_negative" CHECK ("coupon_count" >= 0);
