import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getFootballProvider } from '@/lib/providers';
import type { ProviderFixture } from '@/lib/providers/types';
import { getAppSetting } from '@/lib/config/settings-service';
import {
  RESERVE_SIDE,
  isContainmentMatch,
  normalizeTeamName,
  similarity,
} from './team-resolver';

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
/**
 * The span of dates the plan will actually serve.
 *
 * The provider states it outright when it refuses one: "Free plans do not have
 * access to this date, try from 2026-09-08 to 2026-09-10." That is a far better
 * thing to hold than a list of dates already refused, because it also rules out
 * dates never yet asked for — and it is stored, not held in memory.
 *
 * The in-memory set this replaces was emptied by every restart, and on a day
 * with eight of them the same hopeless dates were asked again after each one:
 * 130 fixture calls against a budget of 100, only 75 of them answered, and the
 * evening's matches went unsettled because the allowance was gone by then.
 *
 * Stored as an offset pair rather than absolute dates, since the window travels
 * with the calendar: "yesterday through tomorrow" stays true tomorrow.
 */
const PLAN_WINDOW_SETTING = 'sync.planDateOffsets';

/**
 * When each date was last fetched for results. In memory: a restart at worst
 * allows one extra fetch, which is nothing against the six an hour this stops.
 */
const lastDateFetchAt = new Map<string, number>();
/** The same, for the reconciliation pass, which has its own looser pace. */
const lastReconcileFetchAt = new Map<string, number>();

interface PlanWindow {
  /** Days back from today the plan will serve, as a negative number or zero. */
  from: number;
  /** Days forward from today. */
  to: number;
}

function isPlanRestriction(error: unknown): boolean {
  return (
    error instanceof Error &&
    /do not have access|not available for your plan/i.test(error.message)
  );
}

function daysBetween(fromKey: string, toKey: string): number {
  return Math.round(
    (Date.parse(`${toKey}T00:00:00.000Z`) - Date.parse(`${fromKey}T00:00:00.000Z`)) / 864e5,
  );
}

/**
 * Reads the served range out of the provider's own refusal and stores it.
 *
 * Silent when the message carries no range: a guess here would bar dates the
 * plan would have answered.
 */
async function learnPlanWindow(error: unknown, now: Date): Promise<void> {
  if (!isPlanRestriction(error) || !(error instanceof Error)) return;

  const match = /try from (\d{4}-\d{2}-\d{2}) to (\d{4}-\d{2}-\d{2})/i.exec(error.message);
  if (!match) return;

  const today = now.toISOString().slice(0, 10);
  const learned: PlanWindow = {
    from: daysBetween(today, match[1] as string),
    to: daysBetween(today, match[2] as string),
  };

  await prisma.appSetting.upsert({
    where: { key: PLAN_WINDOW_SETTING },
    create: {
      key: PLAN_WINDOW_SETTING,
      value: JSON.stringify(learned),
      valueType: 'JSON',
      category: 'sync',
      description: "Days either side of today the fixture provider's plan will serve, learned from its own refusal.",
    },
    update: { value: JSON.stringify(learned) },
  });
  log.info('plan date window learned', { ...learned, from: match[1], to: match[2] });
}

/** Dates the plan is known to serve, or every date until it has told us. */
async function servableDates(now: Date): Promise<(dateKey: string) => boolean> {
  const window = await getAppSetting<PlanWindow | null>(PLAN_WINDOW_SETTING, null);
  if (!window) return () => true;

  const today = now.toISOString().slice(0, 10);
  return (dateKey) => {
    const offset = daysBetween(today, dateKey);
    return offset >= window.from && offset <= window.to;
  };
}

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
): Promise<{
  candidates: number;
  reconciled: number;
  absorbed: number;
  requestsSpent: number;
}> {
  const provider = getFootballProvider();
  const result = { candidates: 0, reconciled: 0, absorbed: 0, requestsSpent: 0 };
  if (!provider.getFixturesByDate) return result;

  /**
   * Two days either side, of which only the forward half ever answers.
   *
   * Reconciliation is what lets a discovered fixture be priced by this provider
   * at all — until it carries an integer id, `/odds?fixture=` rejects it and
   * the five markets only this provider serves stay empty.
   *
   * The free plan serves today and the two days after it, and refuses every
   * past date outright. A fixture therefore has to be reconciled on or before
   * the day it is played; miss that and its result is out of reach here for
   * good. The backward half of the window stays because a paid plan serves it,
   * and the learned plan window stops it paying for the same refusal twice.
   */
  const horizonDays = options.horizonDays ?? 2;

  const orphans = await prisma.match.findMany({
    where: {
      source: { not: provider.name },
      status: { in: [...OPEN_STATUSES] },
      // Only dates the plan will serve; older ones can never be reconciled
      // this way and are left for a manual import.
      scheduledKickoffUtc: {
        // Back a fortnight, not the plan's two days: the provider fetch below
        // is bounded by what the plan serves, but the local-twin pass above
        // it needs no provider at all, and an orphan four days old with a
        // finished twin beside it was left out of the candidate set entirely.
        gte: new Date(now.getTime() - 14 * 864e5),
        lte: new Date(now.getTime() + horizonDays * 864e5),
      },
    },
    select: {
      id: true,
      source: true,
      scheduledKickoffUtc: true,
      homeTeamId: true,
      awayTeamId: true,
      /**
       * Aliases as well as the name.
       *
       * The two providers disagree on more than a suffix: ours says "Sp
       * Lisbon" where the football provider says "Sporting CP", and neither
       * similarity nor containment joins an abbreviation to the word it
       * stands for. The alias table is where that answer already lives —
       * discovery writes it — and not reading it here meant a Champions
       * League fixture with two coupon legs on it could never be settled.
       */
      homeTeam: { select: { name: true, aliases: { select: { alias: true } } } },
      awayTeam: { select: { name: true, aliases: { select: { alias: true } } } },
    },
  });
  result.candidates = orphans.length;
  if (orphans.length === 0) return result;

  /**
   * A twin we already hold needs no request.
   *
   * The football provider's own row for the same fixture — same two teams,
   * kick-off within two hours — is often already in the table, and once it
   * has finished it carries the score. Reconciliation only noticed such twins
   * as a by-product of a date fetch, so an orphan whose date had slipped out
   * of the plan's window was stuck for good beside a finished twin: Avellino–
   * Palermo sat SCHEDULED with eight coupon legs on it while its twin read
   * 1-1, and eleven coupons waited on it and one other. Local first, always.
   */
  const remaining: typeof orphans = [];
  for (const orphan of orphans) {
    const twin = await prisma.match.findFirst({
      where: {
        // Any source that carries a final result: the football provider's own
        // row, or the archive's, which arrives weekly and is the only route
        // left once a date has slipped out of the plan's window.
        source: { not: orphan.source },
        status: { in: ['FINISHED', 'AWARDED', 'CANCELED', 'ABANDONED', 'POSTPONED'] },
        homeTeamId: orphan.homeTeamId,
        awayTeamId: orphan.awayTeamId,
        // The same two teams do not meet twice in a day, so the day is the
        // match: the odds provider listed Avellino–Palermo at 13:00 and the
        // football provider at 15:15, and a two-hour tolerance missed the
        // twin by a quarter of an hour.
        scheduledKickoffUtc: {
          gte: new Date(orphan.scheduledKickoffUtc.getTime() - 12 * 3600 * 1000),
          lte: new Date(orphan.scheduledKickoffUtc.getTime() + 12 * 3600 * 1000),
        },
      },
      select: {
        status: true,
        providerStatus: true,
        homeScore: true,
        awayScore: true,
        halfTimeHomeScore: true,
        halfTimeAwayScore: true,
        finishedAtUtc: true,
      },
    });
    if (!twin || (twin.status === 'FINISHED' && twin.homeScore === null)) {
      remaining.push(orphan);
      continue;
    }
    await prisma.match.update({
      where: { id: orphan.id },
      data: {
        status: twin.status,
        providerStatus: twin.providerStatus,
        homeScore: twin.homeScore,
        awayScore: twin.awayScore,
        halfTimeHomeScore: twin.halfTimeHomeScore,
        halfTimeAwayScore: twin.halfTimeAwayScore,
        finishedAtUtc: twin.finishedAtUtc,
        excludedFromGeneration: true,
      },
    });
    result.absorbed++;
  }
  if (remaining.length === 0) {
    if (result.absorbed > 0) log.info('discovered fixtures reconciled', { ...result });
    return result;
  }

  /**
   * Forward, only the next few hours; backward, everything still unsettled.
   *
   * Orphans up to two days out were being re-asked every ten minutes, one
   * request per date per run, all night. An orphan that kicks off tomorrow
   * evening gains nothing from being bound at 03:00 today; it is bound when its
   * kick-off comes within reach, which is still hours before the per-fixture
   * pricing that depends on it.
   *
   * The backward side is not symmetric. A bound applied both ways left a
   * fixture that had been played eleven hours earlier — with five coupon legs
   * on it — permanently out of reach: too old for the window, and with no
   * other route to its result. Anything already played is asked for until it
   * settles, or until the plan stops serving its date.
   */
  const REACH_AHEAD_MS = 6 * 60 * 60 * 1000;
  const dates = [
    ...new Set(
      remaining
        .filter((m) => m.scheduledKickoffUtc.getTime() - now.getTime() <= REACH_AHEAD_MS)
        .map((m) => m.scheduledKickoffUtc.toISOString().slice(0, 10)),
    ),
  ]
    .sort()
    .reverse();

  const isServable = await servableDates(now);

  /**
   * Once an hour per date, not once a run.
   *
   * This loop rides inside the result sync, six times an hour, and fetched a
   * date on every pass while the main loop, throttled the day before, sat at
   * zero: 74 fixture calls on the Wednesday, the same day's list over and
   * over, and the budget gone by evening again. Binding an orphan to the
   * provider's id is not urgent to the minute — it needs to happen before the
   * per-fixture pricing and before settlement, both hours away — so an hour
   * between asks costs nothing.
   */
  const RECONCILE_REFETCH_MS = 60 * 60_000;

  for (const dateKey of dates) {
    if (!isServable(dateKey)) continue;
    if (now.getTime() - (lastReconcileFetchAt.get(dateKey) ?? 0) < RECONCILE_REFETCH_MS) continue;

    let fixtures: ProviderFixture[];
    try {
      fixtures = await provider.getFixturesByDate(new Date(`${dateKey}T00:00:00.000Z`));
      result.requestsSpent++;
      lastReconcileFetchAt.set(dateKey, now.getTime());
    } catch (error) {
      await learnPlanWindow(error, now);
      log.warn('reconciliation date fetch failed', { date: dateKey, error: String(error) });
      continue;
    }

    for (const orphan of remaining) {
      if (orphan.scheduledKickoffUtc.toISOString().slice(0, 10) !== dateKey) continue;

      const homeNames = [orphan.homeTeam.name, ...orphan.homeTeam.aliases.map((a) => a.alias)];
      const awayNames = [orphan.awayTeam.name, ...orphan.awayTeam.aliases.map((a) => a.alias)];

      /** Any spelling we hold for this side against the one the provider used. */
      const sideMatches = (ours: string[], theirs: string): boolean =>
        ours.some(
          (name) =>
            similarity(normalizeTeamName(name), normalizeTeamName(theirs)) >= 0.9 ||
            isContainmentMatch(name, theirs),
        );

      /**
       * Two ways to recognise the same fixture, and both are needed.
       *
       * Scoring alone missed almost everything worth reconciling: the odds
       * provider writes "Dortmund", "Club Brugge", "Oxford", and against
       * "Borussia Dortmund", "Club Brugge KV" and "Oxford United" bigram
       * similarity gives 0.61, 0.77 and 0.59 — all far below a threshold that
       * has to stay near-exact, so a whole night of European football stayed
       * SCHEDULED with coupons resting on it. Containment recognises exactly
       * that shape, and refuses a reserve side on either end.
       */
      const candidates = fixtures.filter((fixture) => {
        // Two hours of drift: kickoffs move, and the two providers do not
        // always agree on the minute.
        if (
          Math.abs(fixture.kickoffUtc.getTime() - orphan.scheduledKickoffUtc.getTime()) >
          2 * 3600 * 1000
        ) {
          return false;
        }

        // The senior fixture and its U19 game are often hours apart on the same
        // day, so the kickoff window does not separate them on its own.
        if (
          RESERVE_SIDE.test(fixture.homeTeamName) !== RESERVE_SIDE.test(orphan.homeTeam.name) ||
          RESERVE_SIDE.test(fixture.awayTeamName) !== RESERVE_SIDE.test(orphan.awayTeam.name)
        ) {
          return false;
        }

        return (
          sideMatches(homeNames, fixture.homeTeamName) &&
          sideMatches(awayNames, fixture.awayTeamName)
        );
      });

      /**
       * One candidate or none. Containment is deliberately generous — "Rovers"
       * is a whole word in three English clubs — so ambiguity is what keeps it
       * safe: a wrong join writes another match's score onto this one, and
       * every coupon resting on it settles against a fiction.
       */
      if (candidates.length !== 1) {
        if (candidates.length > 1) {
          log.warn('reconciliation ambiguous, left alone', {
            matchId: orphan.id,
            fixture: `${orphan.homeTeam.name} - ${orphan.awayTeam.name}`,
            candidates: candidates.map((f) => `${f.homeTeamName} - ${f.awayTeamName}`),
          });
        }
        continue;
      }

      const best = { fixture: candidates[0] as ProviderFixture };

      /**
       * The provider's id may already belong to a fixture we hold, in which
       * case this one is that fixture's twin rather than a new one.
       *
       * Skipping it was leaving the twin SCHEDULED for good: discovery makes a
       * fresh copy of a fixture the provider already gave us, the real one
       * finishes, and the copy sits on the matches page as the same game
       * unplayed. It cannot take the provider's id — that is spoken for — so
       * it takes the result instead, and is barred from anything built later.
       */
      const clash = await prisma.match.findFirst({
        where: { source: provider.name, externalId: best.fixture.externalId },
        select: {
          id: true,
          status: true,
          homeScore: true,
          awayScore: true,
          halfTimeHomeScore: true,
          halfTimeAwayScore: true,
          finishedAtUtc: true,
        },
      });

      if (clash) {
        await prisma.match.update({
          where: { id: orphan.id },
          data: {
            status: clash.status,
            homeScore: clash.homeScore,
            awayScore: clash.awayScore,
            halfTimeHomeScore: clash.halfTimeHomeScore,
            halfTimeAwayScore: clash.halfTimeAwayScore,
            finishedAtUtc: clash.finishedAtUtc,
            excludedFromGeneration: true,
          },
        });
        result.absorbed++;
        continue;
      }

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

  if (result.reconciled > 0 || result.absorbed > 0) {
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

  /**
   * A date is worth fetching only once something on it can have changed.
   *
   * The fetch is one request for every match on the day, which is cheap — but
   * it was being made every ten minutes from midnight on, because with twenty
   * fixtures spread across a day and their check times staggered, some match
   * was always "due". Ninety-four of those calls went out between 00:31 and
   * 07:11 while nothing was being played, and the budget was gone before the
   * evening's kick-offs. Before kick-off a result fetch can only report a
   * postponement, and the near-kickoff window is early enough to catch one.
   */
  /**
   * Only dates with a match already under way, and each at most once per
   * quarter hour.
   *
   * "Within three hours of kick-off" was the previous gate, and with fixtures
   * spread across a day it was open from mid-morning on: every ten-minute run
   * fetched the day again — the same list, unchanged — six times an hour for
   * the rest of the day. Ninety-four fixture calls on one Tuesday, the budget
   * gone by noon, and the evening's matches, Banko legs among them, left
   * unsettled until midnight.
   *
   * Before kick-off there is no result to fetch. After it, the day's list
   * changes at the pace matches finish, which fifteen minutes covers.
   */
  const REFETCH_MS = 15 * 60_000;
  const worthFetching = new Set(
    due
      .filter((match) => match.scheduledKickoffUtc.getTime() <= now.getTime())
      .map((match) => match.scheduledKickoffUtc.toISOString().slice(0, 10)),
  );

  const dateKeys = [...worthFetching]
    .filter((key) => key >= earliest)
    .filter((key) => now.getTime() - (lastDateFetchAt.get(key) ?? 0) >= REFETCH_MS)
    .sort()
    .reverse();

  if (provider.getFixturesByDate && dateKeys.length > 0 && dateKeys.length < due.length) {
    const isServable = await servableDates(now);

    for (const dateKey of dateKeys) {
      if (!isServable(dateKey)) continue;

      let fixtures: ProviderFixture[];
      try {
        fixtures = await provider.getFixturesByDate(new Date(`${dateKey}T00:00:00.000Z`));
        result.requestsSpent++;
        lastDateFetchAt.set(dateKey, now.getTime());
      } catch (error) {
        await learnPlanWindow(error, now);
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

  /**
   * No per-fixture fallback where a date fetch exists.
   *
   * On the free plan the batched `ids` form is refused, so one batch of twenty
   * is twenty separate calls — counted here as one request, and spent at the
   * provider as twenty. Every night just after the budget reset, the first run
   * found nothing worth a date fetch (the day's matches were hours away and
   * the unsettled ones were two days back, outside the window the plan serves)
   * and fell through to this path for forty-odd matches: ~46 calls, the
   * provider's remaining header dropping 99 to 53 in five minutes, for
   * fixtures a date fetch could not have reached either. Two evenings in a row
   * the budget was gone before kick-off because of it.
   *
   * Anything a date fetch can reach, the date path handles. Anything it cannot
   * is out of the plan's reach by any route; it is charged an attempt so it
   * ages out, and no request is spent on it.
   */
  if (typeof provider.getFixturesByDate === 'function') {
    if (due.length > 0) {
      await prisma.match.updateMany({
        where: { id: { in: due.map((m) => m.id) } },
        data: { resultSyncAttempts: { increment: 1 }, resultLastSyncedAt: now },
      });
    }
    log.info('result sync complete', {
      candidates: result.candidates,
      checked: 0,
      finished: 0,
      requests: 0,
      dates: 0,
      unreachable: due.length,
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
