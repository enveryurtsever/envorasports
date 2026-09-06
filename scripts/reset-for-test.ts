import { PrismaClient } from '@prisma/client';

/**
 * Clears the record so a month-long test starts from a true zero.
 *
 * Removes what the system produced — coupons, predictions, narrations, job
 * history — and keeps what it was produced *from*: matches, odds, Elo, teams
 * and leagues. Re-fetching those would cost days of provider quota and prove
 * nothing, and they are observations rather than results.
 */
const prisma = new PrismaClient();

async function main() {
  const before = {
    coupons: await prisma.coupon.count(),
    predictions: await prisma.prediction.count(),
    jobRuns: await prisma.jobRun.count(),
  };

  const couponIds = (await prisma.coupon.findMany({ select: { id: true } })).map((c) => c.id);

  await prisma.systemCouponColumnSelection.deleteMany({
    where: { column: { systemCoupon: { couponId: { in: couponIds } } } },
  });
  await prisma.systemCouponColumn.deleteMany({
    where: { systemCoupon: { couponId: { in: couponIds } } },
  });
  await prisma.systemCoupon.deleteMany({ where: { couponId: { in: couponIds } } });
  await prisma.couponSelection.deleteMany({});
  await prisma.coupon.deleteMany({});
  await prisma.couponGenerationRun.deleteMany({});
  await prisma.prediction.deleteMany({});
  await prisma.jobRun.deleteMany({});

  // Cached analyses describe coupons that no longer exist.
  await prisma.appSetting.deleteMany({ where: { key: { startsWith: 'narration:' } } });

  // Let every finished match be re-read, so settlement starts clean too.
  await prisma.match.updateMany({
    data: { resultSyncAttempts: 0, resultLastSyncedAt: null },
  });

  console.log('silindi:');
  console.log(`  kupon        ${before.coupons}`);
  console.log(`  tahmin       ${before.predictions}`);
  console.log(`  iş kaydı     ${before.jobRuns}`);
  console.log('korundu:');
  console.log(`  maç          ${await prisma.match.count()}`);
  console.log(`  oran         ${await prisma.odds.count()}`);
  console.log(`  elo          ${await prisma.eloRating.count()}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
