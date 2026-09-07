import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getMatchOddsProvider, API_FOOTBALL_ODDS, footballQuotaPolicy } from '@/lib/providers';
import { getQuotaSnapshot } from '@/lib/providers/quota-manager';
import { getAppSetting } from '@/lib/config/settings-service';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';

const log = createLogger('ingestion:match-odds');

/**
 * Per-fixture odds for the bulletin window.
 *
 * This is what makes a Turkish-style bulletin possible. The competition-wide
 * sync gets three markets on the free plan — MS and the goal lines — so every
 * coupon was built from those alone. Asking API-Football per fixture returns
 * İY, KG, double chance and the goal ladder to 6+ as well, and the prediction
 * engine only stores a prediction where a price exists, so widening the prices
 * widens what a coupon can be built from without touching the model.
 *
 * One request per fixture against a 100/day allowance, so the fixture list is
 * capped and ordered by kickoff: the matches about to be played are the ones
 * worth spending on.
 */

export interface MatchOddsSyncResult {
  fixturesConsidered: number;
  /** Prices already fresh enough to act on; no request was spent on them. */
  fixturesFresh: number;
  /** Wanted a refresh but the budget could not reach them this run. */
  fixturesDeferred: number;
  fixturesRequested: number;
  fixturesPriced: number;
  pricesStored: number;
  marketsSeen: string[];
  quotaRemaining: number | null;
  /** Requests this run was allowed to spend, and why it was that number. */
  requestBudget: number;
  budgetReason: string;
}

/**
 * How stale a fixture's prices must be before spending a request on them.
 *
 * The job used to re-request every fixture in the window on every run,
 * regardless of whether it had been priced minutes earlier: fifty requests a
 * run, four runs a day, against a hundred-request budget. Structurally over
 * budget before a single price moved.
 */
const DEFAULT_REFRESH_AFTER_MINUTES = 240;

/**
 * Markets no bulk feed carries, so this provider is the only source.
 *
 * The Odds API's competition endpoint serves 1X2, totals and spreads; the rest
 * of a Turkish bulletin comes from here. A fixture is worth a request while any
 * of these is missing, however recently its 1X2 was refreshed.
 */
const API_FOOTBALL_ONLY_MARKETS = [
  'DOUBLE_CHANCE',
  'BTTS',
  'HALF_TIME_RESULT',
  'HALF_TIME_FULL_TIME',
  'TOTAL_GOALS_THRESHOLD',
] as const;

export async function syncMatchOddsForWindow(
  window: CoverageWindow,
  options: { maxFixtures?: number; now?: Date } = {},
): Promise<MatchOddsSyncResult> {
  const now = options.now ?? new Date();
  const [configuredMax, refreshAfterMinutes] = await Promise.all([
    getAppSetting<number>('odds.maxFixturesPerRun', 30),
    getAppSetting<number>('odds.refreshAfterMinutes', DEFAULT_REFRESH_AFTER_MINUTES),
  ]);
  const maxFixtures = options.maxFixtures ?? configuredMax;

  const candidates = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
      status: 'SCHEDULED',
      league: { active: true },
      /**
       * Only fixtures this provider can answer about.
       *
       * Discovery creates fixtures carrying the odds provider's event id — a
       * hex hash — and `/odds?fixture=` rejects it outright ("must contain an
       * integer"), one wasted request per fixture. They are priced in bulk
       * elsewhere and reconciled once this provider serves them.
       */
      source: API_FOOTBALL_ODDS,
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: {
      id: true,
      externalId: true,
      scheduledKickoffUtc: true,
      // The provider's league id lives in the season key, as "203-2026".
      season: { select: { externalId: true } },
    },
  });

  const result: MatchOddsSyncResult = {
    fixturesConsidered: candidates.length,
    fixturesFresh: 0,
    fixturesDeferred: 0,
    fixturesRequested: 0,
    fixturesPriced: 0,
    pricesStored: 0,
    marketsSeen: [],
    quotaRemaining: null,
    requestBudget: 0,
    budgetReason: 'not_evaluated',
  };

  if (candidates.length === 0) {
    log.info('no fixtures in window to price');
    return result;
  }

  const plan = await planOddsRequests(candidates, {
    now,
    maxFixtures,
    refreshAfterMinutes,
  });

  result.fixturesFresh = plan.fresh;
  result.fixturesDeferred = plan.deferred;
  result.requestBudget = plan.budget;
  result.budgetReason = plan.reason;

  if (plan.targets.length === 0) {
    log.info('nothing to price this run', {
      considered: candidates.length,
      fresh: plan.fresh,
      deferred: plan.deferred,
      budget: plan.budget,
      reason: plan.reason,
    });
    return result;
  }

  const provider = getMatchOddsProvider();
  const requested = plan.targets;
  result.fixturesRequested = requested.length;

  const byExternalId = new Map(requested.map((match) => [match.externalId, match.id]));

  /**
   * Ask by date when most of a bulletin is wanted.
   *
   * A date pages ten fixtures to a request; asking fixture by fixture is ten
   * times the price. On a Sunday with hundreds of fixtures that difference is
   * the whole candidate pool — eleven usable matches against a full slate.
   * Below the threshold the per-fixture path is still cheaper, because it asks
   * only for what it needs.
   */
  /**
   * Group the work by league and date.
   *
   * The cheapest shape when it is available — one league's four fixtures on a
   * date is a single page. It is not available on the free plan: `league`
   * requires `season`, and the current season is refused ("try from 2022 to
   * 2024"), so this path waits for a plan that allows it.
   */
  const groups = new Map<string, { leagueId: string; season: string; date: string }>();
  for (const match of requested) {
    const [leagueId, season] = (match.season?.externalId ?? '').split('-');
    if (!leagueId || !season) continue;

    const date = match.scheduledKickoffUtc.toISOString().slice(0, 10);
    groups.set(`${leagueId}:${season}:${date}`, { leagueId, season, date });
  }

  /**
   * Which shape is cheaper depends on how much of the day we want.
   *
   * A whole date is 56 pages of ten — every competition the provider carries —
   * so it only wins when we want more fixtures than that costs. For a bulletin
   * of fifty it does not: fifty individual requests price exactly the fifty we
   * care about, where the same spend on pages returns five hundred we do not.
   */
  const DATE_PAGE_COST = 56;
  const bulkAvailable = provider.getBulletinByDate !== undefined && requested.length > DATE_PAGE_COST;

  let bulletin;
  if (bulkAvailable && provider.getBulletinByLeagueDate && groups.size > 0) {
    const events = [];
    let quotaRemaining: number | null = null;
    // Two pages each: a league rarely plays more than twenty fixtures a day.
    for (const group of groups.values()) {
      const page = await provider.getBulletinByLeagueDate(
        group.leagueId,
        group.season,
        group.date,
        2,
      );
      events.push(...page.events);
      quotaRemaining = page.quotaRemaining;
    }
    bulletin = { capturedAt: new Date(), events, quotaRemaining };
  } else {
    bulletin = await provider.getBulletin([...byExternalId.keys()]);
  }

  result.quotaRemaining = bulletin.quotaRemaining;

  const [marketIds, selectionIds] = await Promise.all([loadMarketIds(), loadSelectionIds()]);
  const bookmakerCache = new Map<string, string>();
  const markets = new Set<string>();

  for (const event of bulletin.events) {
    const matchId = byExternalId.get(event.externalId);
    // The fixture id is our own external id, so a miss here means the provider
    // answered about something we did not ask for. Skip rather than guess.
    if (!matchId) continue;

    const rows: Prisma.OddsCreateManyInput[] = [];

    for (const price of event.odds) {
      const marketId = marketIds.get(price.marketCode);
      const selectionId = selectionIds.get(`${price.marketCode}:${price.selectionCode}`);
      if (!marketId || !selectionId) {
        // A market we do not model yet. Dropped, never invented (§40).
        continue;
      }

      const bookmakerId = await ensureBookmaker(
        bookmakerCache,
        price.bookmakerExternalId,
        price.bookmakerName,
      );

      markets.add(price.marketCode);

      rows.push({
        matchId,
        bookmakerId,
        marketId,
        selectionId,
        price: new Prisma.Decimal(price.price.toFixed(3)),
        handicap: new Prisma.Decimal(price.handicap.toFixed(2)),
        capturedAt: price.capturedAt,
        source: API_FOOTBALL_ODDS,
      });
    }

    if (rows.length > 0) {
      // Append-only: the same price at the same instant is a duplicate and is
      // skipped, so re-running the job costs quota but never corrupts history.
      const written = await prisma.odds.createMany({ data: rows, skipDuplicates: true });
      result.pricesStored += written.count;
      result.fixturesPriced++;
    }
  }

  result.marketsSeen = [...markets].sort();
  log.info('match odds sync complete', { ...result });
  return result;
}

interface OddsCandidate {
  id: string;
  externalId: string;
  scheduledKickoffUtc: Date;
  season: { externalId: string } | null;
}

interface OddsPlan {
  targets: OddsCandidate[];
  fresh: number;
  deferred: number;
  budget: number;
  reason: string;
}

/**
 * Decides which fixtures are worth a request, and how many requests there are.
 *
 * The old job asked for every fixture in the window every run and let the quota
 * guard sort it out. That is not a plan, it is a hope: fifty requests four
 * times a day against a hundred-request budget, spent re-fetching prices that
 * had not moved, leaving nothing for result sync and settlement.
 *
 * The order matters as much as the count. Fixtures already sitting on a
 * published coupon come first — those are the prices a reader is looking at.
 * Then fixtures with no price at all, because they cannot enter the pool
 * without one. Then everything else by kickoff. When the budget runs out it
 * runs out at the bottom of that list, not at an arbitrary point in it.
 */
async function planOddsRequests(
  candidates: OddsCandidate[],
  options: { now: Date; maxFixtures: number; refreshAfterMinutes: number },
): Promise<OddsPlan> {
  const ids = candidates.map((match) => match.id);

  const [captures, coupled, quota] = await Promise.all([
    /**
     * Freshness is judged on the markets only this provider serves.
     *
     * Judged on any odds at all, a fixture priced 1X2 in bulk minutes earlier
     * looked covered and was skipped — so double chance, both-teams-to-score,
     * half-time result, HT/FT and the goal ladder were never asked for, and the
     * İY/MS and 6+ goals slates had nothing to build from at all.
     */
    prisma.odds.groupBy({
      by: ['matchId'],
      where: {
        matchId: { in: ids },
        market: { code: { in: [...API_FOOTBALL_ONLY_MARKETS] } },
      },
      _max: { capturedAt: true },
    }),
    prisma.couponSelection.findMany({
      where: { matchId: { in: ids }, coupon: { resultStatus: 'PENDING' } },
      select: { matchId: true },
      distinct: ['matchId'],
    }),
    getQuotaSnapshot(footballQuotaPolicy(), options.now),
  ]);

  const lastCaptured = new Map(captures.map((row) => [row.matchId, row._max.capturedAt]));
  const onPendingCoupon = new Set(coupled.map((row) => row.matchId));

  const staleness = (match: OddsCandidate): number => {
    const captured = lastCaptured.get(match.id);
    // Never priced: infinitely stale, and the highest-value request there is.
    if (!captured) return Number.POSITIVE_INFINITY;
    return (options.now.getTime() - captured.getTime()) / 60_000;
  };

  const due = candidates.filter((match) => staleness(match) >= options.refreshAfterMinutes);
  const fresh = candidates.length - due.length;

  due.sort((a, b) => {
    const couponRank = Number(onPendingCoupon.has(b.id)) - Number(onPendingCoupon.has(a.id));
    if (couponRank !== 0) return couponRank;

    const unpricedRank = Number(!lastCaptured.get(b.id)) - Number(!lastCaptured.get(a.id));
    if (unpricedRank !== 0) return unpricedRank;

    return a.scheduledKickoffUtc.getTime() - b.scheduledKickoffUtc.getTime();
  });

  /**
   * The budget, stated rather than discovered by hitting the wall.
   *
   * A fifth of the day is held back for result sync and settlement — a coupon
   * that cannot be settled is worse than a coupon priced from a slightly older
   * quote — so this job plans against what is left after that reserve.
   */
  const policy = footballQuotaPolicy();
  const reserve = Math.ceil(policy.budget * (policy.reserveRatio ?? 0.2));
  const spendable = Math.max(0, quota.remaining - reserve);
  const budget = Math.min(options.maxFixtures, spendable);

  const reason = quota.exhausted
    ? `provider budget exhausted until ${quota.resetAt?.toISOString() ?? 'reset'}`
    : spendable === 0
      ? `remaining ${quota.remaining} is inside the ${reserve}-request reserve`
      : budget < due.length
        ? `budget ${budget} covers ${budget} of ${due.length} due fixtures`
        : 'all due fixtures fit inside the budget';

  const targets = due.slice(0, budget);

  return { targets, fresh, deferred: due.length - targets.length, budget, reason };
}

async function loadMarketIds(): Promise<Map<string, string>> {
  const markets = await prisma.bettingMarket.findMany({ select: { id: true, code: true } });
  return new Map(markets.map((m) => [m.code, m.id]));
}

async function loadSelectionIds(): Promise<Map<string, string>> {
  const selections = await prisma.bettingSelection.findMany({
    select: { id: true, code: true, market: { select: { code: true } } },
  });
  return new Map(selections.map((s) => [`${s.market.code}:${s.code}`, s.id]));
}

async function ensureBookmaker(
  cache: Map<string, string>,
  externalId: string,
  name: string,
): Promise<string> {
  const cached = cache.get(externalId);
  if (cached) return cached;

  const bookmaker = await prisma.bookmaker.upsert({
    where: { source_name: { source: API_FOOTBALL_ODDS, name } },
    update: { externalId },
    create: { source: API_FOOTBALL_ODDS, externalId, name, active: true },
    select: { id: true },
  });

  cache.set(externalId, bookmaker.id);
  return bookmaker.id;
}
