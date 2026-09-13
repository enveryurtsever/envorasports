import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getOddsProvider, oddsQuotaPolicy, THE_ODDS_API } from '@/lib/providers';
import { getQuotaSnapshot } from '@/lib/providers/quota-manager';
import { DEFAULT_MARKETS, DEFAULT_REGIONS, creditCost } from '@/lib/providers/the-odds-api/odds-provider';
import { getAppSetting } from '@/lib/config/settings-service';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';

const log = createLogger('ingestion:bulk-odds');

/**
 * Prices a whole competition in one call.
 *
 * This replaces asking the fixture provider for odds one fixture at a time,
 * which was consuming 219 of a hard 100-request daily budget — 82% of it — to
 * price about fifty matches from a single bookmaker.
 *
 * The same fifty here cost roughly two credits per competition and arrive with
 * a dozen bookmakers each, which is also the difference between a price and a
 * consensus. Competitions with nothing in the window are skipped rather than
 * swept, because a competition is the unit of cost.
 */

export interface BulkOddsResult {
  competitionsConsidered: number;
  competitionsFetched: number;
  competitionsSkippedFresh: number;
  eventsReturned: number;
  eventsPriced: number;
  fixturesMatched: number;
  pricesStored: number;
  creditsSpent: number;
  budgetReason: string;
  marketsSeen: string[];
}

/** Credits one competition costs at the configured market/region set. */
export const CREDITS_PER_COMPETITION = creditCost(DEFAULT_MARKETS, DEFAULT_REGIONS);

export async function syncBulkOdds(
  window: CoverageWindow,
  options: {
    now?: Date;
    /**
     * Spend into the reserve. An operator's call, never the scheduler's: the
     * reserve is what keeps the month's last days serviceable, and only a
     * person weighing a specific slate against that should override it.
     */
    ignoreReserve?: boolean;
  } = {},
): Promise<BulkOddsResult> {
  const now = options.now ?? new Date();
  const provider = getOddsProvider();

  const refreshAfterMinutes = await getAppSetting<number>('odds.bulkRefreshAfterMinutes', 240);

  const result: BulkOddsResult = {
    competitionsConsidered: 0,
    competitionsFetched: 0,
    competitionsSkippedFresh: 0,
    eventsReturned: 0,
    eventsPriced: 0,
    fixturesMatched: 0,
    pricesStored: 0,
    creditsSpent: 0,
    budgetReason: 'not_evaluated',
    marketsSeen: [],
  };

  /**
   * Only competitions with a fixture we model inside the window.
   *
   * Discovery records every competition the provider carries; pricing spends
   * credits, so it follows the fixtures we can actually predict for. A
   * competition with nothing in the window costs two credits and returns
   * nothing usable.
   */
  const leagues = await prisma.league.findMany({
    where: {
      active: true,
      oddsApiKey: { not: null },
      matches: {
        some: {
          status: 'SCHEDULED',
          scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
        },
      },
    },
    select: { id: true, name: true, oddsApiKey: true },
  });
  result.competitionsConsidered = leagues.length;

  if (leagues.length === 0) {
    result.budgetReason = 'no modelled competition has a fixture in the window';
    return result;
  }

  // Competitions priced recently enough are skipped: prices move, but not so
  // fast that re-buying a whole competition every ten minutes buys anything.
  const since = new Date(now.getTime() - refreshAfterMinutes * 60_000);
  const recent = await prisma.providerRequestLog.findMany({
    where: {
      provider: THE_ODDS_API,
      endpoint: { endsWith: '/odds' },
      sportKey: { not: null },
      success: true,
      createdAt: { gte: since },
    },
    select: { sportKey: true },
  });
  const recentlyFetched = new Set(
    recent.map((row) => row.sportKey).filter((k): k is string => Boolean(k)),
  );

  /**
   * A competition counts as fresh only if everything we model in it is priced.
   *
   * Freshness on the call alone was wrong: discovery creates fixtures between
   * runs, so a competition fetched ten minutes ago can already have a mapped
   * fixture with no price at all, and skipping it left those fixtures out of
   * the pool until the timer expired. What matters is whether the fixtures are
   * covered, not whether the call is recent.
   */
  const windowFixtures = await prisma.match.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
      league: { active: true, oddsApiKey: { not: null } },
    },
    select: { id: true, league: { select: { oddsApiKey: true } } },
  });

  const pricedIds = new Set(
    (
      await prisma.odds.groupBy({
        by: ['matchId'],
        where: { matchId: { in: windowFixtures.map((m) => m.id) } },
      })
    ).map((row) => row.matchId),
  );

  const unpricedByLeague = new Set(
    windowFixtures
      .filter((match) => !pricedIds.has(match.id))
      .map((match) => match.league.oddsApiKey)
      .filter((key): key is string => Boolean(key)),
  );

  const fresh = new Set(
    [...recentlyFetched].filter((key) => !unpricedByLeague.has(key)),
  );

  const policy = oddsQuotaPolicy();
  const reserve = options.ignoreReserve ? 0 : Math.ceil(policy.budget * (policy.reserveRatio ?? 0.15));

  const [marketIds, selectionIds] = await Promise.all([loadMarketIds(), loadSelectionIds()]);
  const bookmakerCache = new Map<string, string>();
  const markets = new Set<string>();

  for (const league of leagues) {
    const key = league.oddsApiKey;
    if (!key) continue;

    if (fresh.has(key)) {
      result.competitionsSkippedFresh++;
      continue;
    }

    // Re-read between competitions rather than reserving up front: the balance
    // is the authority, and a stale estimate either overspends or stops early.
    const quota = await getQuotaSnapshot(policy, now);
    if (quota.exhausted || quota.remaining - reserve < CREDITS_PER_COMPETITION) {
      result.budgetReason =
        `stopped after ${result.competitionsFetched} competitions: ` +
        `${quota.remaining} credits left, ${reserve} reserved`;
      break;
    }

    const bulletin = await provider.getBulletin([key]);
    result.competitionsFetched++;

    const after = await getQuotaSnapshot(policy);
    result.creditsSpent += Math.max(0, quota.remaining - after.remaining);
    result.eventsReturned += bulletin.events.length;

    for (const event of bulletin.events) {
      if (event.odds.length === 0) continue;
      result.eventsPriced++;

      const match = await prisma.match.findFirst({
        where: { oddsEventExternalId: event.externalId },
        select: { id: true },
      });
      // Unmapped events are discovery's job, not this one's. Storing prices
      // against a guess is how one team's odds end up on another team's match.
      if (!match) continue;
      result.fixturesMatched++;

      const rows: Prisma.OddsCreateManyInput[] = [];
      for (const price of event.odds) {
        const marketId = marketIds.get(price.marketCode);
        const selectionId = selectionIds.get(`${price.marketCode}:${price.selectionCode}`);
        if (!marketId || !selectionId) continue;

        const bookmakerId = await ensureBookmaker(
          bookmakerCache,
          price.bookmakerExternalId,
          price.bookmakerName,
        );
        markets.add(price.marketCode);

        rows.push({
          matchId: match.id,
          bookmakerId,
          marketId,
          selectionId,
          price: new Prisma.Decimal(price.price.toFixed(3)),
          handicap: new Prisma.Decimal(price.handicap.toFixed(2)),
          capturedAt: price.capturedAt,
          source: THE_ODDS_API,
        });
      }

      if (rows.length > 0) {
        const written = await prisma.odds.createMany({ data: rows, skipDuplicates: true });
        result.pricesStored += written.count;
      }
    }
  }

  result.marketsSeen = [...markets].sort();
  if (result.budgetReason === 'not_evaluated') {
    result.budgetReason =
      `${result.competitionsFetched} fetched, ${result.competitionsSkippedFresh} already fresh ` +
      `(within ${refreshAfterMinutes} min)`;
  }

  log.info('bulk odds sync complete', { ...result });
  return result;
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
    where: { source_name: { source: THE_ODDS_API, name } },
    update: { externalId },
    create: { source: THE_ODDS_API, externalId, name, active: true },
    select: { id: true },
  });
  cache.set(externalId, bookmaker.id);
  return bookmaker.id;
}
