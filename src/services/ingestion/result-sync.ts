import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getFootballProvider } from '@/lib/providers';
import type { ProviderFixture } from '@/lib/providers/types';
import { getAppSetting } from '@/lib/config/settings-service';

const log = createLogger('ingestion:results');

/**
 * Kickoff-aware result polling (§31).
 *
 * Two rules shape this job:
 *  1. A match is only settled when the provider says FINISHED. Kickoff time
 *     having passed proves nothing — matches get delayed, suspended, abandoned.
 *  2. Polling frequency follows the match, not the clock: rare before kickoff,
 *     frequent around it, and persistent afterwards until the provider confirms
 *     a final result. With 100 requests a day, polling everything every 15
 *     minutes would exhaust the budget before lunch.
 */

/** Statuses that still need watching. */
const OPEN_STATUSES = ['SCHEDULED', 'LIVE', 'HALF_TIME', 'SUSPENDED'] as const;

/** The endpoint takes at most 20 ids per call. */
const BATCH_SIZE = 20;

export interface ResultSyncIntervals {
  preKickoffMinutes: number;
  nearKickoffMinutes: number;
  liveMinutes: number;
  postMatchMinutes: number;
  maxAttempts: number;
  maxBatchesPerRun: number;
}

export async function loadIntervals(): Promise<ResultSyncIntervals> {
  const [preKickoffMinutes, nearKickoffMinutes, liveMinutes, postMatchMinutes, maxAttempts, maxBatchesPerRun] =
    await Promise.all([
      getAppSetting<number>('sync.preKickoffIntervalMinutes', 180),
      getAppSetting<number>('sync.nearKickoffIntervalMinutes', 30),
      getAppSetting<number>('sync.liveIntervalMinutes', 15),
      getAppSetting<number>('sync.postMatchIntervalMinutes', 20),
      getAppSetting<number>('sync.maxResultSyncAttempts', 40),
      getAppSetting<number>('sync.maxResultBatchesPerRun', 3),
    ]);

  return { preKickoffMinutes, nearKickoffMinutes, liveMinutes, postMatchMinutes, maxAttempts, maxBatchesPerRun };
}

/** Minutes to wait before re-checking a match, given where it is in its life. */
export function pollIntervalMinutes(
  minutesSinceKickoff: number,
  intervals: ResultSyncIntervals,
): number {
  // Well before kickoff: a status change here is rare (a postponement).
  if (minutesSinceKickoff < -180) return intervals.preKickoffMinutes;
  // Approaching kickoff: line-ups, late postponements.
  if (minutesSinceKickoff < 0) return intervals.nearKickoffMinutes;
  // In play, including stoppages and half time (~110 minutes of match).
  if (minutesSinceKickoff <= 110) return intervals.liveMinutes;
  // Past full time but not confirmed: keep asking until the provider says so.
  return intervals.postMatchMinutes;
}

export function isDueForCheck(
  match: { scheduledKickoffUtc: Date; resultLastSyncedAt: Date | null; resultSyncAttempts: number },
  intervals: ResultSyncIntervals,
  now: Date,
): boolean {
  if (match.resultSyncAttempts >= intervals.maxAttempts) return false;
  if (!match.resultLastSyncedAt) return true;

  const minutesSinceKickoff = (now.getTime() - match.scheduledKickoffUtc.getTime()) / 60_000;
  const waitMinutes = pollIntervalMinutes(minutesSinceKickoff, intervals);
  const minutesSinceCheck = (now.getTime() - match.resultLastSyncedAt.getTime()) / 60_000;
  return minutesSinceCheck >= waitMinutes;
}

export interface ResultSyncResult {
  candidates: number;
  checked: number;
  updated: number;
  finished: number;
  finishedMatchIds: string[];
  requestsSpent: number;
}

export async function syncMatchResults(now: Date = new Date()): Promise<ResultSyncResult> {
  const intervals = await loadIntervals();

  const candidates = await prisma.match.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      // Anything older than a week without a final result is a data problem,
      // not a match in progress; it is surfaced in the admin monitor instead.
      scheduledKickoffUtc: {
        gte: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        lte: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
      },
      resultSyncAttempts: { lt: intervals.maxAttempts },
    },
    select: {
      id: true,
      externalId: true,
      source: true,
      scheduledKickoffUtc: true,
      resultLastSyncedAt: true,
      resultSyncAttempts: true,
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    take: BATCH_SIZE * intervals.maxBatchesPerRun,
  });

  const due = candidates.filter((match) => isDueForCheck(match, intervals, now));

  const result: ResultSyncResult = {
    candidates: candidates.length,
    checked: 0,
    updated: 0,
    finished: 0,
    finishedMatchIds: [],
    requestsSpent: 0,
  };

  if (due.length === 0) return result;

  const byExternalId = new Map(due.map((m) => [m.externalId, m]));
  const provider = getFootballProvider();

  for (let i = 0; i < due.length; i += BATCH_SIZE) {
    const batch = due.slice(i, i + BATCH_SIZE);
    let fixtures: ProviderFixture[];

    try {
      fixtures = await provider.getFixturesByIds(batch.map((m) => m.externalId));
      result.requestsSpent++;
    } catch (error) {
      // A provider failure must never mark predictions lost (§38). Record the
      // attempt and move on; the next tick retries.
      log.error('result batch failed', { error: String(error), size: batch.length });
      await prisma.match.updateMany({
        where: { id: { in: batch.map((m) => m.id) } },
        data: { resultSyncAttempts: { increment: 1 }, resultLastSyncedAt: now },
      });
      continue;
    }

    result.checked += batch.length;

    for (const fixture of fixtures) {
      const known = byExternalId.get(fixture.externalId);
      if (!known) continue;

      const becameFinal = await applyFixtureResult(known.id, fixture, now);
      result.updated++;
      if (becameFinal) {
        result.finished++;
        result.finishedMatchIds.push(known.id);
      }
    }

    // Fixtures the provider did not return still consumed an attempt.
    const returned = new Set(fixtures.map((f) => f.externalId));
    const missing = batch.filter((m) => !returned.has(m.externalId));
    if (missing.length > 0) {
      await prisma.match.updateMany({
        where: { id: { in: missing.map((m) => m.id) } },
        data: { resultSyncAttempts: { increment: 1 }, resultLastSyncedAt: now },
      });
    }
  }

  log.info('result sync complete', {
    candidates: result.candidates,
    checked: result.checked,
    finished: result.finished,
    requests: result.requestsSpent,
  });
  return result;
}

/** Returns true when this update moved the match into a terminal state. */
async function applyFixtureResult(
  matchId: string,
  fixture: ProviderFixture,
  now: Date,
): Promise<boolean> {
  const isFinal =
    fixture.status === 'FINISHED' ||
    fixture.status === 'AWARDED' ||
    fixture.status === 'CANCELED' ||
    fixture.status === 'ABANDONED';

  const existing = await prisma.match.findUnique({
    where: { id: matchId },
    select: { status: true },
  });

  await prisma.$transaction([
    prisma.match.update({
      where: { id: matchId },
      data: {
        status: fixture.status,
        providerStatus: fixture.rawStatus,
        homeScore: fixture.homeScore,
        awayScore: fixture.awayScore,
        halfTimeHomeScore: fixture.halfTimeHomeScore,
        halfTimeAwayScore: fixture.halfTimeAwayScore,
        scheduledKickoffUtc: fixture.kickoffUtc,
        finishedAtUtc: isFinal ? (fixture.status === 'FINISHED' ? now : null) : null,
        startedAtUtc: fixture.status === 'SCHEDULED' ? null : undefined,
        resultLastSyncedAt: now,
        resultSyncAttempts: { increment: 1 },
        providerLastUpdatedAt: fixture.providerUpdatedAt,
      },
    }),
    // Append-only audit of exactly what the provider said (§37).
    prisma.matchResultSnapshot.create({
      data: {
        matchId,
        provider: fixture.source,
        providerStatus: fixture.rawStatus,
        status: fixture.status,
        homeScore: fixture.homeScore,
        awayScore: fixture.awayScore,
        halfTimeHomeScore: fixture.halfTimeHomeScore,
        halfTimeAwayScore: fixture.halfTimeAwayScore,
        capturedAt: now,
      },
    }),
  ]);

  // Only a *transition* into a final state should trigger settlement.
  const wasFinal =
    existing?.status === 'FINISHED' ||
    existing?.status === 'AWARDED' ||
    existing?.status === 'CANCELED' ||
    existing?.status === 'ABANDONED';

  return isFinal && !wasFinal;
}
