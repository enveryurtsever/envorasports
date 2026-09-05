import { PrismaClient, Prisma } from '@prisma/client';
import { DEFAULT_SYSTEM_SETTINGS } from '../src/lib/config/coupon-settings';

/** Applies the current shipped system/category defaults to the database. */
const prisma = new PrismaClient();

async function main() {
  const s = DEFAULT_SYSTEM_SETTINGS;

  const existing = await prisma.systemCouponSetting.findFirst();
  const data = {
    enabled: s.enabled,
    allowedSystemTypes: s.allowedSystemTypes,
    defaultSystemType: s.defaultSystemType,
    sourceCategories: s.sourceCategories,
    minBaseSelections: s.minBaseSelections,
    maxBaseSelections: s.maxBaseSelections,
    stakePerColumn: new Prisma.Decimal(s.stakePerColumn),
    maxTotalStake: new Prisma.Decimal(s.maxTotalStake),
    currency: s.currency,
    couponCount: s.couponCount,
  };

  if (existing) {
    await prisma.systemCouponSetting.update({ where: { id: existing.id }, data });
  } else {
    await prisma.systemCouponSetting.create({
      data: {
        ...data,
        minCombinedProbability: new Prisma.Decimal(s.minCombinedProbability),
        minExpectedValue: new Prisma.Decimal(s.minExpectedValue),
        maxCorrelation: new Prisma.Decimal(s.maxCorrelation),
        oneSelectionPerMatch: s.oneSelectionPerMatch,
      },
    });
  }

  // Systems now come from a real category, so the standalone one is retired.
  await prisma.couponCategorySetting.update({
    where: { category: 'COMBINATION_SYSTEM' },
    data: { enabled: false, couponCount: 0 },
  });
  const removed = await prisma.coupon.deleteMany({ where: { category: 'COMBINATION_SYSTEM' } });

  console.log(`system sources : ${s.sourceCategories.join(', ')}`);
  console.log(`default system : ${s.defaultSystemType} @ ${s.stakePerColumn} ${s.currency}/column`);
  console.log(`combination category retired; removed ${removed.count} of its coupons`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
