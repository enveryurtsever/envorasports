import { PrismaClient } from '@prisma/client';
import { rebuildEloRatings } from '../src/services/features/elo';
import { runPredictions } from '../src/services/predictions/prediction-engine';
import { generateCoupons } from '../src/services/coupons/coupon-generator';
import {
  captureSettingsSnapshot,
  getBulletinSchedule,
  getCategorySettings,
  getSystemSettings,
} from '../src/lib/config/settings-service';
import {
  coverageWindow,
  nextPublicationDate,
  publicationCovering,
  todayInSchedule,
} from '../src/lib/schedule/bulletin-schedule';

/**
 * Runs features -> predictions -> coupons on data already in the database.
 * No provider calls, so it costs nothing and can be re-run freely.
 */
const prisma = new PrismaClient();

async function main() {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);
  const publication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(publication, schedule);

  console.log(`Window: ${window.startDate} -> ${window.endDate} (published ${publication})`);

  console.log('\n1. Elo');
  const elo = await rebuildEloRatings();
  console.log(`   ${elo.matchesProcessed} matches, ${elo.teamsRated} teams, ${elo.ratingsWritten} ratings`);

  console.log('\n2. Predictions');
  const predictions = await runPredictions({ from: window.startUtc, to: window.endUtc });
  console.log(`   considered=${predictions.matchesConsidered} priced=${predictions.matchesPriced}`);
  console.log(`   written=${predictions.predictionsWritten} recommended=${predictions.candidatesRecommended}`);
  console.log(`   skipped: noOdds=${predictions.skippedNoOdds} noFeatures=${predictions.skippedNoFeatures}`);

  console.log('\n3. Coupons');
  const modelVersion = await prisma.modelVersion.findFirst({ where: { active: true } });
  if (!modelVersion) throw new Error('no active model version');

  const snapshot = await captureSettingsSnapshot();
  const [categorySettings, systemSettings] = await Promise.all([
    getCategorySettings(),
    getSystemSettings(),
  ]);

  const generation = await generateCoupons({
    window,
    timezone: schedule.timezone,
    grouping: schedule.grouping,
    modelVersionId: modelVersion.id,
    settingsSnapshotId: snapshot.id,
    categorySettings,
    systemSettings,
  });

  console.log(`   generated=${generation.couponsGenerated} candidates=${generation.candidatesEvaluated}`);
  for (const outcome of generation.outcomes) {
    console.log(
      `   ${outcome.category.padEnd(19)} ${outcome.produced}/${outcome.requested}` +
        ` pool=${outcome.candidatePool}` +
        (outcome.shortfallReason ? `  (${outcome.shortfallReason})` : ''),
    );
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
