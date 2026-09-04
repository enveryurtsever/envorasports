import { PrismaClient, Prisma } from '@prisma/client';
import { MARKET_DEFINITIONS } from '../src/lib/markets/registry';
import { CSV_DIVISIONS } from '../src/lib/providers/football-data-csv/divisions';
import {
  DEFAULT_CATEGORY_SETTINGS,
  DEFAULT_MODEL_WEIGHTS,
  DEFAULT_SCORING_WEIGHTS,
  DEFAULT_SYSTEM_SETTINGS,
} from '../src/lib/config/coupon-settings';
import { PLAN_FEATURES } from '../src/lib/entitlements/features';
import { DEFAULT_BULLETIN_SCHEDULE } from '../src/lib/schedule/bulletin-schedule';

/**
 * Idempotent seed: every write is an upsert keyed on a natural unique, so
 * running it twice changes nothing and running it after a schema change fills
 * only the gaps.
 *
 * It seeds vocabulary and configuration — never match data or predictions.
 */

const prisma = new PrismaClient();

async function seedMarkets() {
  let markets = 0;
  let selections = 0;

  for (const definition of MARKET_DEFINITIONS) {
    const market = await prisma.bettingMarket.upsert({
      where: { code: definition.code },
      update: {
        name: definition.name,
        category: definition.category,
        description: definition.description,
        active: true,
      },
      create: {
        code: definition.code,
        name: definition.name,
        category: definition.category,
        description: definition.description,
        active: true,
      },
    });
    markets++;

    for (const selection of definition.selections) {
      await prisma.bettingSelection.upsert({
        where: { marketId_code: { marketId: market.id, code: selection.code } },
        update: {
          name: selection.name,
          parameters: (selection.parameters ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          active: true,
        },
        create: {
          marketId: market.id,
          code: selection.code,
          name: selection.name,
          description: null,
          parameters: (selection.parameters ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          active: true,
        },
      });
      selections++;
    }
  }

  console.log(`  markets: ${markets}, selections: ${selections}`);
}

async function seedLeagues() {
  // Leagues are seeded from the historical archive because that is the only
  // source that covers every one of them for free. External ids from the live
  // providers are filled in by the ingestion job on first sync.
  for (const division of CSV_DIVISIONS) {
    await prisma.league.upsert({
      where: { source_externalId: { source: 'football-data-csv', externalId: division.code } },
      update: {
        name: division.name,
        country: division.country,
        oddsApiKey: division.oddsApiKey,
        csvDivision: division.code,
        tier: division.tier,
      },
      create: {
        source: 'football-data-csv',
        externalId: division.code,
        name: division.name,
        country: division.country,
        type: 'League',
        tier: division.tier,
        oddsApiKey: division.oddsApiKey,
        csvDivision: division.code,
        // Tier-1 leagues have richer stats coverage; this feeds data quality.
        dataQuality: division.tier === 1 ? 0.8 : 0.6,
        active: true,
      },
    });
  }
  console.log(`  leagues: ${CSV_DIVISIONS.length}`);
}

async function seedBookmakers() {
  const bookmakers = [
    { source: 'football-data-csv', name: 'Bet365', reliability: 0.85 },
    { source: 'football-data-csv', name: 'Pinnacle', reliability: 0.98 },
    { source: 'football-data-csv', name: 'Market Average', reliability: 0.9 },
    { source: 'football-data-csv', name: 'Market Best', reliability: 0.7 },
  ];

  for (const bookmaker of bookmakers) {
    await prisma.bookmaker.upsert({
      where: { source_name: { source: bookmaker.source, name: bookmaker.name } },
      update: { reliability: bookmaker.reliability },
      create: { ...bookmaker, active: true },
    });
  }
  console.log(`  bookmakers: ${bookmakers.length}`);
}

async function seedModelVersion() {
  await prisma.modelVersion.upsert({
    where: { name_version: { name: 'ensemble', version: 'v1' } },
    update: { active: true },
    create: {
      name: 'ensemble',
      version: 'v1',
      description: 'Elo + Poisson + Form + xG ensemble with the documented starting weights.',
      configuration: {
        weights: DEFAULT_MODEL_WEIGHTS,
        elo: { kFactor: 20, homeAdvantage: 65, initialRating: 1500 },
        poisson: { maxGoals: 10, homeAdvantage: 1.12, shrinkage: 0.25 },
        form: { windows: ['LAST_5', 'LAST_10', 'LAST_20', 'SEASON'], venueSplit: true },
        scoring: DEFAULT_SCORING_WEIGHTS,
      },
      active: true,
    },
  });
  console.log('  model version: ensemble-v1');
}

async function seedPlans() {
  const plans = [
    { code: 'PLUS' as const, name: 'Plus', monthlyPrice: '9.90', sortOrder: 1 },
    { code: 'PREMIUM' as const, name: 'Premium', monthlyPrice: '19.90', sortOrder: 2 },
    { code: 'ELITE' as const, name: 'Elite', monthlyPrice: '39.90', sortOrder: 3 },
  ];

  for (const plan of plans) {
    // Prices live in the database so they change without a deploy (§16).
    const record = await prisma.subscriptionPlan.upsert({
      where: { code: plan.code },
      update: { name: plan.name, sortOrder: plan.sortOrder, active: true },
      create: {
        code: plan.code,
        name: plan.name,
        description: null,
        monthlyPrice: new Prisma.Decimal(plan.monthlyPrice),
        currency: 'EUR',
        sortOrder: plan.sortOrder,
        active: true,
      },
    });

    for (const feature of PLAN_FEATURES[plan.code]) {
      await prisma.subscriptionPlanFeature.upsert({
        where: { planId_featureCode: { planId: record.id, featureCode: feature } },
        update: { enabled: true },
        create: { planId: record.id, featureCode: feature, enabled: true },
      });
    }
  }
  console.log(`  plans: ${plans.length}`);
}

async function seedCouponSettings() {
  for (const settings of Object.values(DEFAULT_CATEGORY_SETTINGS)) {
    await prisma.couponCategorySetting.upsert({
      where: { category: settings.category },
      // Never overwrite an operator's tuning on re-seed.
      update: {},
      create: {
        category: settings.category,
        enabled: settings.enabled,
        couponCount: settings.couponCount,
        minTotalOdds: new Prisma.Decimal(settings.minTotalOdds),
        maxTotalOdds: settings.maxTotalOdds === null ? null : new Prisma.Decimal(settings.maxTotalOdds),
        minSelections: settings.minSelections,
        maxSelections: settings.maxSelections,
        minConfidence: new Prisma.Decimal(settings.minConfidence),
        minExpectedValue: new Prisma.Decimal(settings.minExpectedValue),
        minEdge: new Prisma.Decimal(settings.minEdge),
        minProbability: new Prisma.Decimal(settings.minProbability),
        maxRisk: new Prisma.Decimal(settings.maxRisk),
        maxCorrelation: new Prisma.Decimal(settings.maxCorrelation),
        minDataQuality: new Prisma.Decimal(settings.minDataQuality),
        oneSelectionPerMatch: settings.oneSelectionPerMatch,
        allowedMarkets: settings.allowedMarkets,
      },
    });
  }

  const existingSystem = await prisma.systemCouponSetting.findFirst();
  if (!existingSystem) {
    const s = DEFAULT_SYSTEM_SETTINGS;
    await prisma.systemCouponSetting.create({
      data: {
        enabled: s.enabled,
        allowedSystemTypes: s.allowedSystemTypes,
        defaultSystemType: s.defaultSystemType,
        minBaseSelections: s.minBaseSelections,
        maxBaseSelections: s.maxBaseSelections,
        stakePerColumn: new Prisma.Decimal(s.stakePerColumn),
        maxTotalStake: new Prisma.Decimal(s.maxTotalStake),
        currency: s.currency,
        minCombinedProbability: new Prisma.Decimal(s.minCombinedProbability),
        minExpectedValue: new Prisma.Decimal(s.minExpectedValue),
        maxCorrelation: new Prisma.Decimal(s.maxCorrelation),
        oneSelectionPerMatch: s.oneSelectionPerMatch,
        couponCount: s.couponCount,
      },
    });
  }
  console.log('  coupon settings: 4 categories + system defaults');
}

async function seedBulletinSchedule() {
  const existing = await prisma.bulletinScheduleSetting.findFirst();
  if (existing) {
    console.log('  bulletin schedule: kept operator configuration');
    return;
  }

  const s = DEFAULT_BULLETIN_SCHEDULE;
  await prisma.bulletinScheduleSetting.create({
    data: {
      enabled: s.enabled,
      timezone: s.timezone,
      publicationWeekdays: s.publicationWeekdays,
      coverageOffsetDays: s.coverageOffsetDays,
      coverageDays: s.coverageDays,
      publishTimeLocal: s.publishTimeLocal,
      grouping: s.grouping,
    },
  });
  console.log(
    `  bulletin schedule: publish [${s.publicationWeekdays.join(', ')}] (ISO weekdays), ` +
      `cover ${s.coverageDays} days from +${s.coverageOffsetDays}, ${s.timezone}`,
  );
}

async function seedCorrelations() {
  /**
   * Rule-based starting matrix (§33). These are the pairs where treating
   * selections as independent overstates a coupon's true probability the most.
   * A fitted statistical model replaces these numbers later.
   */
  const correlations = [
    { a: 'MATCH_RESULT', sa: 'MS_1', b: 'ASIAN_HANDICAP', sb: '*', c: 0.75, note: 'Home win and a home handicap move together' },
    { a: 'MATCH_RESULT', sa: 'MS_1', b: 'DOUBLE_CHANCE', sb: 'DOUBLE_CHANCE_1X', c: 0.82, note: 'Home win is contained in 1X' },
    { a: 'MATCH_RESULT', sa: 'MS_2', b: 'DOUBLE_CHANCE', sb: 'DOUBLE_CHANCE_X2', c: 0.82, note: 'Away win is contained in X2' },
    { a: 'OVER_UNDER', sa: 'OVER_2_5', b: 'TOTAL_GOALS_THRESHOLD', sb: 'GOALS_6_PLUS', c: 0.55, note: 'Both need a high-scoring game' },
    { a: 'OVER_UNDER', sa: 'OVER_2_5', b: 'BTTS', sb: 'BTTS_YES', c: 0.62, note: 'Goals and both teams scoring co-occur' },
    { a: 'OVER_UNDER', sa: 'OVER_2_5', b: 'GOAL_RANGE', sb: 'GOAL_RANGE_4_6', c: 0.7, note: 'Overlapping goal bands' },
    { a: 'BTTS', sa: 'BTTS_NO', b: 'OVER_UNDER', sb: 'UNDER_2_5', c: 0.6, note: 'Low-scoring outcomes co-occur' },
    { a: 'HALF_TIME_RESULT', sa: 'HT_1', b: 'HALF_TIME_FULL_TIME', sb: 'HTFT_1_1', c: 0.85, note: 'HT/FT contains the half-time result' },
    { a: 'CORRECT_SCORE', sa: '*', b: 'OVER_UNDER', sb: '*', c: 0.5, note: 'An exact score fixes the total' },
  ];

  for (const item of correlations) {
    await prisma.marketCorrelation.upsert({
      where: {
        marketCodeA_selectionCodeA_marketCodeB_selectionCodeB: {
          marketCodeA: item.a,
          selectionCodeA: item.sa,
          marketCodeB: item.b,
          selectionCodeB: item.sb,
        },
      },
      update: { coefficient: new Prisma.Decimal(item.c), note: item.note },
      create: {
        marketCodeA: item.a,
        selectionCodeA: item.sa,
        marketCodeB: item.b,
        selectionCodeB: item.sb,
        coefficient: new Prisma.Decimal(item.c),
        sameMatchOnly: true,
        note: item.note,
      },
    });
  }
  console.log(`  correlations: ${correlations.length}`);
}

async function seedAppSettings() {
  const settings = [
    { key: 'generation.dailyTimeUtc', value: '06:30', valueType: 'STRING' as const, category: 'generation', description: 'UTC time the daily generation pipeline runs.' },
    { key: 'generation.bulletinLookaheadHours', value: '36', valueType: 'NUMBER' as const, category: 'generation', description: 'How far ahead fixtures are eligible for today’s bulletin.' },
    { key: 'sync.preKickoffIntervalMinutes', value: '180', valueType: 'NUMBER' as const, category: 'sync', description: 'Status check interval well before kickoff.' },
    { key: 'sync.nearKickoffIntervalMinutes', value: '30', valueType: 'NUMBER' as const, category: 'sync', description: 'Status check interval around kickoff.' },
    { key: 'sync.liveIntervalMinutes', value: '15', valueType: 'NUMBER' as const, category: 'sync', description: 'Status check interval during a live match.' },
    { key: 'sync.postMatchIntervalMinutes', value: '20', valueType: 'NUMBER' as const, category: 'sync', description: 'Retry interval until the provider confirms FINISHED.' },
    { key: 'sync.maxResultSyncAttempts', value: '40', valueType: 'NUMBER' as const, category: 'sync', description: 'Attempts before a match is surfaced as a sync failure.' },
    { key: 'settlement.version', value: '1', valueType: 'NUMBER' as const, category: 'settlement', description: 'Bumping this re-settles history under a new recorded version.' },
    { key: 'settlement.voidHandling', value: 'NEUTRALISE', valueType: 'STRING' as const, category: 'settlement', description: 'Void selections are removed from the accumulator rather than losing it.' },
    { key: 'prediction.minEdge', value: '0.02', valueType: 'NUMBER' as const, category: 'prediction', description: 'Minimum edge for a selection to be marked recommended.' },
    { key: 'prediction.minExpectedValue', value: '0.02', valueType: 'NUMBER' as const, category: 'prediction', description: 'Minimum EV for a selection to be marked recommended.' },
    { key: 'prediction.minProbability', value: '0.25', valueType: 'NUMBER' as const, category: 'prediction', description: 'Backtest-derived floor: below this the model shows no measured skill.' },
    { key: 'access.freePreviewCategory', value: 'HIGH_CONFIDENCE', valueType: 'STRING' as const, category: 'access', description: 'Category visitors can sample without a membership.' },
    { key: 'access.freePreviewCount', value: '2', valueType: 'NUMBER' as const, category: 'access', description: 'How many coupons a visitor sees in full.' },
    { key: 'narration.maxPerRun', value: '20', valueType: 'NUMBER' as const, category: 'narration', description: 'Cap on narration calls per pass; the free tier rate-limits per minute.' },
    { key: 'narration.delayBetweenCallsMs', value: '4000', valueType: 'NUMBER' as const, category: 'narration', description: 'Pacing between narration calls.' },
    { key: 'sync.maxResultBatchesPerRun', value: '3', valueType: 'NUMBER' as const, category: 'sync', description: 'Caps result-sync requests per tick; each batch covers 20 matches.' },
    { key: 'odds.maxCompetitionsPerRun', value: '6', valueType: 'NUMBER' as const, category: 'odds', description: 'Competitions priced per publication. Each costs markets x regions credits.' },
    { key: 'odds.staleAfterMinutes', value: '180', valueType: 'NUMBER' as const, category: 'odds', description: 'Prices older than this are shown with an explicit timestamp warning.' },
    { key: 'scoring.weights', value: JSON.stringify(DEFAULT_SCORING_WEIGHTS), valueType: 'JSON' as const, category: 'scoring', description: 'Coupon score weights (§34).' },
    { key: 'model.weights', value: JSON.stringify(DEFAULT_MODEL_WEIGHTS), valueType: 'JSON' as const, category: 'model', description: 'Ensemble weights (§26).' },
  ];

  for (const setting of settings) {
    await prisma.appSetting.upsert({
      where: { key: setting.key },
      update: { description: setting.description, category: setting.category },
      create: setting,
    });
  }
  console.log(`  app settings: ${settings.length}`);
}

async function main() {
  console.log('Seeding EnvoraSports reference data...');
  await seedMarkets();
  await seedLeagues();
  await seedBookmakers();
  await seedModelVersion();
  await seedPlans();
  await seedCouponSettings();
  await seedBulletinSchedule();
  await seedCorrelations();
  await seedAppSettings();
  console.log('Seed complete.');
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
