import { PrismaClient, Prisma } from '@prisma/client';
import { DEFAULT_CATEGORY_SETTINGS, type CouponCategory } from '../src/lib/config/coupon-settings';

/** Pushes the category defaults into the stored settings the generator reads. */
const p = new PrismaClient();
(async () => {
  for (const [category, d] of Object.entries(DEFAULT_CATEGORY_SETTINGS)) {
    await p.couponCategorySetting.update({
      where: { category: category as CouponCategory },
      data: {
        couponCount: d.couponCount,
        minTotalOdds: new Prisma.Decimal(d.minTotalOdds),
        minSelections: d.minSelections,
        maxSelections: d.maxSelections,
        minCombinedProbability: new Prisma.Decimal(d.minCombinedProbability),
      },
    });
  }
  const rows = await p.couponCategorySetting.findMany({ orderBy: { category: 'asc' } });
  for (const r of rows)
    console.log(`${r.category.padEnd(18)} count=${r.couponCount} oran>=${Number(r.minTotalOdds).toFixed(2).padStart(7)} tutma>=%${(Number(r.minCombinedProbability)*100).toFixed(1).padStart(5)} legs ${r.minSelections}-${r.maxSelections}`);
  await p.$disconnect();
})();
