import { PrismaClient, Prisma } from '@prisma/client';
import { DEFAULT_CATEGORY_SETTINGS } from '../src/lib/config/coupon-settings';

/** Restores a category to the shipped defaults. Admin edits are otherwise kept. */
const prisma = new PrismaClient();

async function main() {
  const category = process.argv[2] as keyof typeof DEFAULT_CATEGORY_SETTINGS;
  const settings = DEFAULT_CATEGORY_SETTINGS[category];
  if (!settings) throw new Error(`Unknown category ${category}`);

  await prisma.couponCategorySetting.update({
    where: { category },
    data: {
      minTotalOdds: new Prisma.Decimal(settings.minTotalOdds),
      maxTotalOdds: settings.maxTotalOdds === null ? null : new Prisma.Decimal(settings.maxTotalOdds),
    },
  });
  console.log(`${category}: odds band ${settings.minTotalOdds} - ${settings.maxTotalOdds ?? 'open'}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
