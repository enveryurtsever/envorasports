import { PrismaClient } from '@prisma/client';
import {
  coverageWindow,
  nextPublicationDate,
  publicationCovering,
  todayInSchedule,
} from '../src/lib/schedule/bulletin-schedule';
import {
  captureSettingsSnapshot,
  getBulletinSchedule,
  getCategorySettings,
  getSystemSettings,
} from '../src/lib/config/settings-service';
import { DEFAULT_FOCUS_GROUPS } from '../src/lib/config/coupon-settings';
import { generateCoupons } from '../src/services/coupons/coupon-generator';

/**
 * Clears every coupon and rebuilds the active window from scratch.
 *
 * Deliberately destructive, and only safe while the record is being reset on
 * purpose — a settled coupon is the evidence of what was actually backed, and
 * once deleted no settlement history can be reconstructed. The count of what
 * is about to go is printed first, and a settled coupon requires --force, so
 * this cannot quietly erase a graded record.
 *
 * Predictions are untouched: they are the audit trail the coupons were built
 * from, and they carry their own supersede markers.
 *
 *   npx tsx scripts/reset-coupons.ts [--force]
 */

const prisma = new PrismaClient();
const force = process.argv.includes('--force');

async function main(): Promise<void> {
  const byStatus = await prisma.coupon.groupBy({ by: ['resultStatus'], _count: true });
  const settled = byStatus
    .filter((row) => row.resultStatus !== 'PENDING')
    .reduce((sum, row) => sum + row._count, 0);
  const total = byStatus.reduce((sum, row) => sum + row._count, 0);

  console.log(`coupons to delete: ${total} (${settled} of them settled)`);
  for (const row of byStatus) console.log(`  ${row.resultStatus}: ${row._count}`);

  if (settled > 0 && !force) {
    console.log('\nRefusing: settled coupons are the record of what was backed.');
    console.log('Re-run with --force if the record is genuinely meant to be cleared.');
    await prisma.$disconnect();
    return;
  }

  // Selections and system columns hang off the coupon and cascade with it;
  // deleting them explicitly first keeps the outcome the same whether or not
  // the cascade is configured, and makes the counts visible.
  const columns = await prisma.systemCouponColumn.deleteMany({});
  const selections = await prisma.couponSelection.deleteMany({});
  const coupons = await prisma.coupon.deleteMany({});
  const runs = await prisma.couponGenerationRun.deleteMany({});

  console.log(
    `deleted: ${coupons.count} coupons, ${selections.count} selections, ` +
      `${columns.count} system columns, ${runs.count} generation runs`,
  );

  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);
  const publication =
    publicationCovering(today, schedule) ??
    nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(publication, schedule);

  const active = await prisma.modelVersion.findFirst({ where: { active: true } });
  if (!active) throw new Error('No active model version');

  const snapshot = await captureSettingsSnapshot();
  const [categorySettings, systemSettings] = await Promise.all([
    getCategorySettings(),
    getSystemSettings(),
  ]);

  const generation = await generateCoupons({
    focusGroups: DEFAULT_FOCUS_GROUPS,
    window,
    timezone: schedule.timezone,
    grouping: schedule.grouping,
    modelVersionId: active.id,
    settingsSnapshotId: snapshot.id,
    categorySettings,
    systemSettings,
  });

  console.log(
    `\nrebuilt with ${active.name} ${active.version} over ${window.startDate}..${window.endDate}`,
  );
  console.log(
    `coupons generated: ${generation.couponsGenerated} from ${generation.candidatesEvaluated} candidates`,
  );

  const tainted = await prisma.couponSelection.count({
    where: { prediction: { supersededAt: { not: null } } },
  });
  console.log(`selections resting on a superseded prediction: ${tainted}`);

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
