import { PrismaClient } from '@prisma/client';
import { coverageWindow, publicationCovering, nextPublicationDate, todayInSchedule } from '../src/lib/schedule/bulletin-schedule';
import { getBulletinSchedule, captureSettingsSnapshot, getCategorySettings, getSystemSettings } from '../src/lib/config/settings-service';
import { DEFAULT_FOCUS_GROUPS } from '../src/lib/config/coupon-settings';
import { runPredictions } from '../src/services/predictions/prediction-engine';
import { generateCoupons } from '../src/services/coupons/coupon-generator';

/**
 * Retires predictions produced by a superseded model and rebuilds the window.
 *
 * Used after a correctness fix, where the stored predictions are not merely
 * old but wrong: the Poisson model was reading the away side's attack and
 * defence off the *home* team's form bundle, so the away team never entered
 * the heaviest model in the ensemble.
 *
 * Nothing is deleted. Affected rows are marked superseded with a reason, which
 * is what keeps the record honest — "we believed this, then we stopped, and
 * here is why" — while removing them from every downstream reader. Settled
 * predictions are left alone: those are historical facts about what was
 * backed, not live opinions.
 *
 *   npx tsx scripts/revalidate-predictions.ts "<reason>"
 */

const prisma = new PrismaClient();

const REASON =
  process.argv[2] ??
  'MODEL_SUPERSEDED: poisson away-strength input fix + ensemble v2 (xg disabled explicitly)';

async function main(): Promise<void> {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);
  const publication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(publication, schedule);

  const active = await prisma.modelVersion.findFirst({ where: { active: true } });
  if (!active) throw new Error('No active model version');
  console.log(`active model: ${active.name} ${active.version} (${active.id})`);
  console.log(`window: ${window.startDate} .. ${window.endDate}`);

  // 1. Retire every live opinion that did not come from the active version.
  //    Settled rows are excluded: they record what actually happened.
  const retired = await prisma.prediction.updateMany({
    where: {
      supersededAt: null,
      status: 'PENDING',
      modelVersionId: { not: active.id },
      match: { status: 'SCHEDULED' },
    },
    data: { supersededAt: new Date(), supersededReason: REASON },
  });
  console.log(`superseded ${retired.count} prediction(s) from earlier model versions`);

  // 2. Rebuild predictions for the window under the active version.
  const predictions = await runPredictions({
    from: window.startUtc,
    to: window.endUtc,
    asOf: new Date(),
    modelVersionId: active.id,
  });
  console.log('predictions:', JSON.stringify(predictions, null, 1));

  // 3. Rebuild coupons from the new predictions. Generation replaces its own
  //    pending coupons and leaves settled ones untouched.
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
  console.log('coupons:', JSON.stringify(generation, null, 1));

  // 4. Prove the invariant rather than assuming it: no live coupon may rest on
  //    a prediction the engine has withdrawn.
  const tainted = await prisma.couponSelection.count({
    where: {
      coupon: { resultStatus: 'PENDING' },
      prediction: { supersededAt: { not: null } },
    },
  });
  console.log(`pending coupon selections resting on a superseded prediction: ${tainted}`);
  if (tainted > 0) console.log('!! investigate before trusting the published coupons');

  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exitCode = 1;
});
