-- AlterTable
ALTER TABLE "system_coupon_columns" ADD COLUMN     "size" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "system_coupons" ADD COLUMN     "system_sizes" INTEGER[];

