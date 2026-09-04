-- AlterTable
ALTER TABLE "market_correlations" ALTER COLUMN "selection_code_a" SET NOT NULL,
ALTER COLUMN "selection_code_a" SET DEFAULT '*',
ALTER COLUMN "selection_code_b" SET NOT NULL,
ALTER COLUMN "selection_code_b" SET DEFAULT '*';

