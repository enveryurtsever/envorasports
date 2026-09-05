import { PrismaClient, Prisma } from '@prisma/client';
import { DEFAULT_CATEGORY_SETTINGS, type CouponCategory } from '../src/lib/config/coupon-settings';

/** Pushes the coded category defaults into the stored settings. */
const p = new PrismaClient();
async function main() {
  for (const [category, d] of Object.entries(DEFAULT_CATEGORY_SETTINGS)) {
    await p.couponCategorySetting.update({
      where: { category: category as CouponCategory },
      data: {
        enabled: d.enabled,
        couponCount: d.couponCount,
        minTotalOdds: new Prisma.Decimal(d.minTotalOdds),
        maxTotalOdds: d.maxTotalOdds === null ? null : new Prisma.Decimal(d.maxTotalOdds),
        minSelections: d.minSelections,
        maxSelections: d.maxSelections,
        minConfidence: new Prisma.Decimal(d.minConfidence),
        minExpectedValue: new Prisma.Decimal(d.minExpectedValue),
        minEdge: new Prisma.Decimal(d.minEdge),
        minProbability: new Prisma.Decimal(d.minProbability),
        maxRisk: new Prisma.Decimal(d.maxRisk),
        minDataQuality: new Prisma.Decimal(d.minDataQuality),
        minCombinedProbability: new Prisma.Decimal(d.minCombinedProbability),
      },
    });
  }
  for (const r of await p.couponCategorySetting.findMany({ orderBy: { category: 'asc' } }))
    console.log(`${r.category.padEnd(18)} adet=${r.couponCount} oran>=${Number(r.minTotalOdds).toFixed(2).padStart(7)} tutma>=%${(Number(r.minCombinedProbability)*100).toFixed(0).padStart(3)} bacak ${r.minSelections}-${r.maxSelections}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => p.$disconnect());
