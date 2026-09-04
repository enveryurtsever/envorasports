import { prisma } from '@/lib/db/prisma';
import { runJob, runKeyFor, type JobOutcome } from '@/lib/jobs/runner';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import {
  coverageWindow,
  decideRun,
  isPublicationDay,
  nextPublicationDate,
  publicationCovering,
  todayInSchedule,
} from '@/lib/schedule/bulletin-schedule';
import { syncFixturesForWindow } from '../ingestion/fixture-sync';
import { syncBulletinForWindow } from '../ingestion/bulletin-sync';
import { syncMatchResults } from '../ingestion/result-sync';
import { importSeasons } from '../ingestion/historical-import';
import { runSettlement, settleCoupons, settleSystemCoupons } from '../settlement/settlement-service';
import { rebuildEloRatings } from '../features/elo';
import { runPredictions } from '../predictions/prediction-engine';
import { generateCoupons } from '../coupons/coupon-generator';
import { narrateWindow } from '../narration/narration-job';
import {
  captureSettingsSnapshot,
  getCategorySettings,
  getSystemSettings,
} from '@/lib/config/settings-service';
import { getFootballProvider, getOddsProvider, footballQuotaPolicy, oddsQuotaPolicy } from '@/lib/providers';
import { getQuotaState } from '@/lib/providers/quota';

/**
 * The scheduled jobs and what each is allowed to do (§38, §42).
 *
 * Every job goes through `runJob`, which supplies the lock, the JobRun record
 * and the idempotency key. None of them throws at the caller — a failure is a
 * recorded outcome, so one broken provider never stops the rest of the pipeline.
 */

export type JobName =
  | 'bulletin-publication'
  | 'fixture-topup'
  | 'rebuild-features'
  | 'narrate-analyses'
  | 'result-sync'
  | 'settlement'
  | 'historical-import';

export interface JobRequest {
  /** Runs a publication job outside its scheduled day (manual/backfill). */
  force?: boolean;
  /** historical-import only. */
  divisions?: string[];
  seasons?: number[];
}

/**
 * The publication run (§42 steps 1–2).
 *
 * Fires only on a publication day, and prepares the forward window: Monday
 * covers Tue–Thu, Thursday covers Fri–Sun. On any other day it exits without
 * spending a single provider request.
 */
export async function runBulletinPublication(request: JobRequest = {}): Promise<JobOutcome> {
  const schedule = await getBulletinSchedule();
  const decision = decideRun(schedule, new Date(), { force: request.force });

  if (!decision.shouldRun || !decision.window) {
    await prisma.jobRun.create({
      data: {
        jobName: 'bulletin-publication',
        status: 'SKIPPED',
        startedAt: new Date(),
        finishedAt: new Date(),
        error: decision.reason,
        metadata: { publicationDate: decision.publicationDate, reason: decision.reason },
      },
    });
    return { status: 'SKIPPED', reason: decision.reason, runId: null };
  }

  const window = decision.window;

  return runJob({
    jobName: 'bulletin-publication',
    // One successful publication per day: re-triggering the cron is a no-op.
    runKey: runKeyFor('bulletin-publication', decision.publicationDate),
    lockKey: 'ingestion',
    lockTtlMs: 20 * 60 * 1000,
    handler: async ({ logger, heartbeat }) => {
      logger.info('publication window', {
        publicationDate: decision.publicationDate,
        days: window.days,
      });

      const fixtures = await syncFixturesForWindow(window);
      await heartbeat();

      // The bulletin runs second on purpose: it only spends credits on
      // competitions that actually have fixtures in the window.
      const bulletin = await syncBulletinForWindow(window);
      await heartbeat();

      // Features -> models -> value -> coupons. Each step reads only what the
      // step before it persisted, so a failure leaves a coherent partial state.
      const elo = await rebuildEloRatings();
      await heartbeat();

      const predictions = await runPredictions({
        from: window.startUtc,
        to: window.endUtc,
        asOf: new Date(),
      });
      await heartbeat();

      const modelVersion = await prisma.modelVersion.findFirst({ where: { active: true } });
      if (!modelVersion) throw new Error('No active model version');

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

      logger.info('publication produced coupons', {
        coupons: generation.couponsGenerated,
        candidates: generation.candidatesEvaluated,
      });

      return {
        itemsProcessed: generation.couponsGenerated,
        itemsFailed: bulletin.eventsUnmatched + fixtures.unresolvedTeams,
        metadata: {
          publicationDate: decision.publicationDate,
          coverageStart: window.startDate,
          coverageEnd: window.endDate,
          coverageDays: window.days,
          fixtures,
          bulletin,
          elo,
          predictions,
          generation,
        },
      };
    },
  });
}

/**
 * Fills in coverage days the publication run could not fetch.
 *
 * API-Football's Free plan only serves fixtures within a day or so of today,
 * so a Thursday publication cannot see Sunday yet. This runs daily, re-syncs
 * the window that covers today, and picks up whatever has come into range. It
 * is idempotent, so days already ingested cost nothing but a lookup.
 */
export async function runFixtureTopup(): Promise<JobOutcome> {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);
  const activePublication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(activePublication, schedule);

  return runJob({
    jobName: 'fixture-topup',
    runKey: runKeyFor('fixture-topup', today),
    lockKey: 'ingestion',
    lockTtlMs: 15 * 60 * 1000,
    handler: async ({ logger }) => {
      const fixtures = await syncFixturesForWindow(window);
      logger.info('window topped up', {
        publication: activePublication,
        deferred: fixtures.daysDeferred,
      });
      return {
        itemsProcessed: fixtures.matchesUpserted,
        itemsFailed: fixtures.daysDeferred.length,
        metadata: { publication: activePublication, window: window.days, fixtures },
      };
    },
  });
}

/**
 * Rebuilds Elo from stored results.
 *
 * Separate from the publication run so a history backfill can be followed by a
 * single rebuild without re-fetching anything.
 */
export async function runFeatureRebuild(): Promise<JobOutcome> {
  return runJob({
    jobName: 'rebuild-features',
    lockKey: 'features',
    lockTtlMs: 30 * 60 * 1000,
    handler: async () => {
      const elo = await rebuildEloRatings();
      return { itemsProcessed: elo.ratingsWritten, metadata: { elo } };
    },
  });
}

/**
 * Fills the narration cache for the active window.
 *
 * Kept out of the publication run because it is paced against a per-minute
 * rate limit and would otherwise hold that job open for minutes.
 */
export async function runNarration(): Promise<JobOutcome> {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);
  const activePublication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(activePublication, schedule);

  return runJob({
    jobName: 'narrate-analyses',
    runKey: runKeyFor('narrate-analyses', today),
    lockKey: 'narration',
    lockTtlMs: 30 * 60 * 1000,
    handler: async ({ heartbeat }) => {
      const result = await narrateWindow(window);
      await heartbeat();
      return {
        itemsProcessed: result.generated,
        itemsFailed: result.fromTemplate,
        metadata: { window: window.days, ...result },
      };
    },
  });
}

/**
 * Kickoff-aware result polling, then settlement for anything that just became
 * final. Safe to call on a short interval: it self-throttles per match.
 */
export async function runResultSync(): Promise<JobOutcome> {
  return runJob({
    jobName: 'result-sync',
    lockKey: 'result-sync',
    lockTtlMs: 10 * 60 * 1000,
    handler: async ({ logger }) => {
      const results = await syncMatchResults();

      let settlement = { predictionsSettled: 0, couponsSettled: 0, systemCouponsSettled: 0, columnsSettled: 0 };
      if (results.finishedMatchIds.length > 0) {
        settlement = await runSettlement(results.finishedMatchIds);
        logger.info('settlement triggered by finished matches', { ...settlement });
      }

      return {
        itemsProcessed: results.checked,
        itemsFailed: 0,
        metadata: { ...results, finishedMatchIds: undefined, settlement },
      };
    },
  });
}

/**
 * Settlement sweep. The result sync already settles what it finishes; this
 * catches coupons whose last selection resolved through a different path (a
 * late statistics import, a manual correction, a previous failure).
 */
export async function runSettlementSweep(): Promise<JobOutcome> {
  return runJob({
    jobName: 'settlement',
    lockKey: 'settlement',
    lockTtlMs: 10 * 60 * 1000,
    handler: async () => {
      const coupons = await settleCoupons();
      const systems = await settleSystemCoupons();
      return {
        itemsProcessed: coupons.coupons + systems.systems,
        metadata: { coupons, systems },
      };
    },
  });
}

/** Bulk history import. Unmetered, so it may run for a long time. */
export async function runHistoricalImport(request: JobRequest = {}): Promise<JobOutcome> {
  const divisions = request.divisions ?? [];
  const currentYear = new Date().getUTCFullYear();
  const seasons = request.seasons ?? [currentYear - 1, currentYear - 2, currentYear - 3];

  return runJob({
    jobName: 'historical-import',
    lockKey: 'historical-import',
    lockTtlMs: 60 * 60 * 1000,
    handler: async ({ logger, heartbeat }) => {
      const targets =
        divisions.length > 0
          ? divisions
          : (
              await prisma.league.findMany({
                where: { active: true, csvDivision: { not: null } },
                select: { csvDivision: true },
                orderBy: { tier: 'asc' },
              })
            )
              .map((l) => l.csvDivision)
              .filter((d): d is string => d !== null);

      let matches = 0;
      let odds = 0;
      const unresolved = new Set<string>();

      for (const division of targets) {
        const results = await importSeasons(division, seasons);
        for (const result of results) {
          matches += result.matchesImported;
          odds += result.oddsImported;
          result.unresolvedTeams.forEach((name) => unresolved.add(name));
        }
        await heartbeat();
        logger.info('division imported', { division });
      }

      return {
        itemsProcessed: matches,
        itemsFailed: unresolved.size,
        metadata: {
          divisions: targets,
          seasons,
          matches,
          odds,
          unresolvedTeams: [...unresolved].slice(0, 50),
        },
      };
    },
  });
}

export async function runNamedJob(name: JobName, request: JobRequest = {}): Promise<JobOutcome> {
  switch (name) {
    case 'bulletin-publication':
      return runBulletinPublication(request);
    case 'fixture-topup':
      return runFixtureTopup();
    case 'rebuild-features':
      return runFeatureRebuild();
    case 'narrate-analyses':
      return runNarration();
    case 'result-sync':
      return runResultSync();
    case 'settlement':
      return runSettlementSweep();
    case 'historical-import':
      return runHistoricalImport(request);
  }
}

export const JOB_NAMES: JobName[] = [
  'bulletin-publication',
  'fixture-topup',
  'rebuild-features',
  'narrate-analyses',
  'result-sync',
  'settlement',
  'historical-import',
];

/** Operational snapshot for the admin monitor (§39). */
export async function getPipelineStatus() {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);

  // On a non-publication day the interesting window is the one that covers
  // today, not the hypothetical one today would produce.
  const activePublication =
    publicationCovering(today, schedule) ?? nextPublicationDate(today, schedule, { inclusive: true });
  const window = coverageWindow(activePublication, schedule);

  const [footballQuota, oddsQuota, recentRuns, awaitingResult, pendingCoupons] = await Promise.all([
    getQuotaState(footballQuotaPolicy()),
    getQuotaState(oddsQuotaPolicy()),
    prisma.jobRun.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    prisma.match.count({ where: { status: { in: ['SCHEDULED', 'LIVE', 'HALF_TIME', 'SUSPENDED'] } } }),
    prisma.coupon.count({ where: { resultStatus: 'PENDING' } }),
  ]);

  return {
    schedule,
    today,
    isPublicationDay: isPublicationDay(today, schedule),
    activePublication,
    nextPublication: nextPublicationDate(today, schedule),
    window,
    providers: {
      football: { name: getFootballProvider().name, quota: footballQuota },
      odds: { name: getOddsProvider().name, quota: oddsQuota },
    },
    recentRuns,
    awaitingResult,
    pendingCoupons,
  };
}
