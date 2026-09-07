import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getFootballProvider } from '@/lib/providers';
import type { ProviderFixture } from '@/lib/providers/types';
import { getAppSetting } from '@/lib/config/settings-service';
import { normalizeTeamName, similarity } from './team-resolver';

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

/** True when the call never reached the provider, so it proves nothing. */
function isPreflightFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'QuotaExceededError' ||
    /budget exhausted|do not have access|not available for your plan/i.test(error.message) ||
    // A spent per-minute burst says nothing about the fixture. Counting it as
    // an attempt let two jobs ticking in the same minute burn a match's
    // allowance until it could never be settled at all.
    /rate limit is \d+ requests per minute|too many requests/i.test(error.message)
  );
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

/**
 * Ties fixtures created from odds events to the football provider's own.
 *
 * Discovery creates fixtures the fixture provider's plan has not served yet, so
 * they carry an odds-event id and nothing this provider recognises. They can be
 * priced and predicted, but never settled — eighteen of Sunday's matches sat
 * SCHEDULED after the whole day had been played, with coupons resting on them.
 *
 * The date fetch already pulls every fixture on a day for one request, so the
 * reconciliation is free: whatever comes back is matched on team names and
 * kickoff, and the fixture inherits the provider's id. From then on it settles
 * like any other.
 */
export async function reconcileDiscoveredFixtures(
  now: Date = new Date(),
  options: { horizonDays?: number } = {},
): Promise<{ candidates: number; reconciled: number; requestsSpent: number }> {
  const provider = getFootballProvider();
  const result = { candidates: 0, reconciled: 0, requestsSpent: 0 };
  if (!provider.getFixturesByDate) return result;

  /**
   * Two days, which is as far as the plan will serve.
   *
   * Reconciliation is what lets a discovered fixture be priced by this provider
   * at all — until it carries an integer id, `/odds?fixture=` rejects it and
   * the five markets only this provider serves stay empty. The free plan
   * answers "try from <yesterday> to <tomorrow>", so anything further out
   * simply has to wait for its date to come round.
   */
  const horizonDays = options.horizonDays ?? 2;

  const orphans = await prisma.match.findMany({
    where: {
      source: { not: provider.name },
      status: { in: [...OPEN_STATUSES] },
      // Only dates the plan will serve; older ones can never be reconciled
      // this way and are left for a manual import.
      scheduledKickoffUtc: {
        gte: new Date(now.getTime() - horizonDays * 864e5),
        lte: new Date(now.getTime() + horizonDays * 864e5),
      },
    },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
  });
  result.candidates = orphans.length;
  if (orphans.length === 0) return result;

  const dates = [
    ...new Set(orphans.map((m) => m.scheduledKickoffUtc.toISOString().slice(0, 10))),
  ].sort().reverse();

  for (const dateKey of dates) {
    let fixtures: ProviderFixture[];
    try {
      fixtures = await provider.getFixturesByDate(new Date(`${dateKey}T00:00:00.000Z`));
      result.requestsSpent++;
    } catch (error) {
      log.warn('reconciliation date fetch failed', { date: dateKey, error: String(error) });
      continue;
    }

    for (const orphan of orphans) {
      if (orphan.scheduledKickoffUtc.toISOString().slice(0, 10) !== dateKey) continue;

      const home = normalizeTeamName(orphan.homeTeam.name);
      const away = normalizeTeamName(orphan.awayTeam.name);

      let best: { fixture: ProviderFixture; score: number } | null = null;
      for (const fixture of fixtures) {
        // Two hours of drift: kickoffs move, and the two providers do not
        // always agree on the minute.
        if (
          Math.abs(fixture.kickoffUtc.getTime() - orphan.scheduledKickoffUtc.getTime()) >
          2 * 3600 * 1000
        ) {
          continue;
        }

        const score = Math.min(
          similarity(home, normalizeTeamName(fixture.homeTeamName)),
          similarity(away, normalizeTeamName(fixture.awayTeamName)),
        );
        if (!best || score > best.score) best = { fixture, score };
      }

      // Near-exact only. A wrong join here writes another match's score onto
      // this one, and every coupon resting on it settles against a fiction.
      if (!best || best.score < 0.9) continue;

      // The provider's id may already belong to a fixture we hold, in which
      // case this one is a duplicate of it rather than a new fixture.
      const clash = await prisma.match.findFirst({
        where: { source: provider.name, externalId: best.fixture.externalId },
        select: { id: true },
      });
      if (clash) continue;

      await prisma.match.update({
        where: { id: orphan.id },
        data: {
          source: provider.name,
          externalId: best.fixture.externalId,
          // A fresh identity deserves a fresh allowance: the attempts it
          // accrued were against an id this provider never recognised.
          resultSyncAttempts: 0,
          resultLastSyncedAt: null,
        },
      });
      result.reconciled++;
    }
  }

  if (result.reconciled > 0) {
    log.info('discovered fixtures reconciled', { ...result });
  }
  return result;
}

export async function syncMatchResults(now: Date = new Date()): Promise<ResultSyncResult> {
  const intervals = await loadIntervals();

  const provider = getFootballProvider();

  const candidates = await prisma.match.findMany({
    where: {
      status: { in: [...OPEN_STATUSES] },
      /**
       * Only fixtures this provider can answer about.
       *
       * Discovery creates fixtures from the odds provider, whose event ids mean
       * nothing here. Polling them would spend the daily budget asking about
       * fixtures that cannot exist, and every answer would be "not found" —
       * which then counts as a failed attempt against a real match's allowance.
       * They are settled once the football provider serves them and the fixture
       * is reconciled; until then they are simply not this job's business.
       */
      source: provider.name,
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
    // Newest first. Ordered by earliest kickoff, a handful of week-old matches
    // that never resolve fill the whole batch every run, and today's finished
    // matches — the ones a settlement is actually waiting on — are never
    // reached. The candidate set is drawn wider than the batch budget and
    // trimmed after the due filter, so undue matches do not consume it either.
    orderBy: { scheduledKickoffUtc: 'desc' },
    take: BATCH_SIZE * intervals.maxBatchesPerRun * 5,
  });

  const due = candidates
    .filter((match) => isDueForCheck(match, intervals, now))
    .slice(0, BATCH_SIZE * intervals.maxBatchesPerRun);

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

  /**
   * Ask by date, not by fixture.
   *
   * The batched `ids` parameter is refused on the Free plan, so asking per
   * fixture meant one request each: sixty-eight of a hundred-request day just
   * to learn one Sunday's scores, and nothing left for anything else. A date
   * costs one request whatever it holds, and the fixtures we did not ask about
   * are simply dropped from the answer.
   */
  /**
   * Newest first, and only dates the plan will serve.
   *
   * The Free plan answers a date outside a narrow window around today with
   * "Free plans do not have access to this date, try from X to Y". Asked
   * oldest-first, every probe a held budget allowed was spent on a date that
   * could never be served, and today's results — which the plan does allow —
   * were never reached. Older dates fall through to the per-fixture path,
   * which has no such restriction.
   */
  const PLAN_DATE_RADIUS_DAYS = 1;
  const earliest = new Date(now.getTime() - PLAN_DATE_RADIUS_DAYS * 864e5)
    .toISOString()
    .slice(0, 10);

  const dateKeys = [
    ...new Set(due.map((match) => match.scheduledKickoffUtc.toISOString().slice(0, 10))),
  ]
    .filter((key) => key >= earliest)
    .sort()
    .reverse();

  if (provider.getFixturesByDate && dateKeys.length > 0 && dateKeys.length < due.length) {
    for (const dateKey of dateKeys) {
      let fixtures: ProviderFixture[];
      try {
        fixtures = await provider.getFixturesByDate(new Date(`${dateKey}T00:00:00.000Z`));
        result.requestsSpent++;
      } catch (error) {
        log.error('result date fetch failed', { date: dateKey, error: String(error) });
        // A budget refusal proves nothing about the match, so no attempt is
        // recorded against it; the next tick tries again.
        if (isPreflightFailure(error)) continue;

        const onDate = due.filter(
          (match) => match.scheduledKickoffUtc.toISOString().slice(0, 10) === dateKey,
        );
        await prisma.match.updateMany({
          where: { id: { in: onDate.map((m) => m.id) } },
          data: { resultSyncAttempts: { increment: 1 }, resultLastSyncedAt: now },
        });
        continue;
      }

      const wanted = fixtures.filter((fixture) => byExternalId.has(fixture.externalId));
      result.checked += wanted.length;

      for (const fixture of wanted) {
        const known = byExternalId.get(fixture.externalId);
        if (!known) continue;

        const becameFinal = await applyFixtureResult(known.id, fixture, now);
        result.updated++;
        if (becameFinal) {
          result.finished++;
          result.finishedMatchIds.push(known.id);
        }
      }

      // Fixtures we asked about that the date did not carry still consumed an
      // attempt: the provider answered, it simply had nothing for them.
      const returned = new Set(wanted.map((f) => f.externalId));
      const missing = due.filter(
        (match) =>
          match.scheduledKickoffUtc.toISOString().slice(0, 10) === dateKey &&
          !returned.has(match.externalId),
      );
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
      dates: dateKeys.length,
    });
    return result;
  }

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

      /**
       * Only a real answer counts as an attempt.
       *
       * A quota rejection or a plan restriction never reached the provider, so
       * it says nothing about whether the match is resolvable. Counting those
       * burned the whole attempt budget on matches that had simply never been
       * asked about: a day of finished fixtures sat at 19 attempts against a
       * limit of 12 and could no longer be settled at all.
       */
      if (!isPreflightFailure(error)) {
        await prisma.match.updateMany({
          where: { id: { in: batch.map((m) => m.id) } },
          data: { resultSyncAttempts: { increment: 1 }, resultLastSyncedAt: now },
        });
      }
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
