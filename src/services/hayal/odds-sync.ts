import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getOddsProvider, oddsQuotaPolicy, THE_ODDS_API } from '@/lib/providers';
import { getQuotaSnapshot } from '@/lib/providers/quota-manager';
import { HALF_TIME_MARKETS, DEFAULT_REGIONS, creditCost } from '@/lib/providers/the-odds-api/odds-provider';
import { getAppSetting } from '@/lib/config/settings-service';
import { resolveEventToMatch } from '@/services/ingestion/bulletin-sync';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';

const log = createLogger('hayal:odds');

/**
 * Fetches the markets the HAYAL signal is stated in.
 *
 * They live behind The Odds API's per-event endpoint and cost
 * `markets x regions` credits each — four, against five hundred a month. That
 * is roughly a hundred fixtures in total, so this is not a sweep: it reconciles
 * fixtures for free, then spends on the ones closest to kicking off that have
 * no half-time price yet.
 *
 * Reconciliation is the free half. The Odds API does not meter its event list,
 * so enumerating every competition's fixtures costs nothing, and the event ids
 * it yields are cached on our own fixtures for good.
 */

export interface HayalOddsSyncResult {
  competitionsScanned: number;
  eventsListed: number;
  fixturesReconciled: number;
  fixturesEligible: number;
  fixturesFetched: number;
  pricesStored: number;
  creditsSpent: number;
  creditBudget: number;
  budgetReason: string;
  marketsSeen: string[];
}

/**
 * What a fixture costs at most — not what it usually costs.
 *
 * The Odds API charges `markets x regions`, but only for markets that actually
 * return a price: an event no bookmaker has priced for these markets comes back
 * empty and is charged nothing. Coverage of the half-time markets is thin, so
 * most fixtures are free and a few cost up to this. Budgeting on the worst case
 * would refuse almost every fixture; budgeting on the observed spend, re-read
 * between fetches, spends what is really there.
 */
export const MAX_CREDITS_PER_FIXTURE = creditCost(HALF_TIME_MARKETS, DEFAULT_REGIONS);

export async function syncHayalOdds(
  window: CoverageWindow,
  options: { now?: Date; maxFixtures?: number } = {},
): Promise<HayalOddsSyncResult> {
  const now = options.now ?? new Date();
  const provider = getOddsProvider();

  const result: HayalOddsSyncResult = {
    competitionsScanned: 0,
    eventsListed: 0,
    fixturesReconciled: 0,
    fixturesEligible: 0,
    fixturesFetched: 0,
    pricesStored: 0,
    creditsSpent: 0,
    creditBudget: 0,
    budgetReason: 'not_evaluated',
    marketsSeen: [],
  };

  if (!provider.listEvents || !provider.getEventMarkets) {
    result.budgetReason = `${provider.name} does not serve per-event markets`;
    return result;
  }

  // --- free half: reconcile our fixtures to the provider's event ids --------
  const leagues = await prisma.league.findMany({
    where: {
      active: true,
      oddsApiKey: { not: null },
      matches: {
        some: {
          status: 'SCHEDULED',
          scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
          oddsEventExternalId: null,
        },
      },
    },
    select: { oddsApiKey: true },
  });

  for (const league of leagues) {
    const key = league.oddsApiKey;
    if (!key) continue;

    result.competitionsScanned++;
    const events = await provider.listEvents(key);
    result.eventsListed += events.length;

    for (const event of events) {
      if (event.commenceTimeUtc < window.startUtc || event.commenceTimeUtc >= window.endUtc) {
        continue;
      }
      const matchId = await resolveEventToMatch(event, window);
      if (matchId) result.fixturesReconciled++;
    }
  }

  // --- metered half: buy the half-time markets for what is worth it ---------
  const maxFixtures =
    options.maxFixtures ?? (await getAppSetting<number>('hayal.maxFixturesPerRun', 8));
  const refreshAfterHours = await getAppSetting<number>('hayal.refreshAfterHours', 24);

  const candidates = await prisma.match.findMany({
    where: {
      status: 'SCHEDULED',
      scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
      oddsEventExternalId: { not: null },
      league: { active: true, oddsApiKey: { not: null } },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: {
      id: true,
      oddsEventExternalId: true,
      scheduledKickoffUtc: true,
      league: { select: { oddsApiKey: true } },
    },
  });

  // A fixture already carrying a recent half-time price is not worth four more
  // credits; the signal is a price level, not a tick-by-tick series.
  const recent = await prisma.odds.groupBy({
    by: ['matchId'],
    where: {
      matchId: { in: candidates.map((m) => m.id) },
      source: THE_ODDS_API,
      market: { code: { in: ['HALF_TIME_CORRECT_SCORE', 'BTTS_FIRST_HALF', 'BTTS_SECOND_HALF'] } },
      capturedAt: { gte: new Date(now.getTime() - refreshAfterHours * 3600 * 1000) },
    },
    _max: { capturedAt: true },
  });
  const priced = new Set(recent.map((row) => row.matchId));

  const eligible = candidates.filter((match) => !priced.has(match.id));
  result.fixturesEligible = eligible.length;

  const policy = oddsQuotaPolicy();
  const reserve = Math.ceil(policy.budget * (policy.reserveRatio ?? 0.15));
  const openingQuota = await getQuotaSnapshot(policy, now);
  const spendable = Math.max(0, openingQuota.remaining - reserve);

  // One fixture must be affordable even in the worst case before starting.
  const budget = spendable < MAX_CREDITS_PER_FIXTURE ? 0 : Math.min(maxFixtures, eligible.length);

  result.creditBudget = spendable;
  result.budgetReason = openingQuota.exhausted
    ? 'odds api budget exhausted'
    : budget === 0
      ? `remaining ${openingQuota.remaining} is inside the ${reserve}-credit reserve`
      : `${budget} of ${eligible.length} eligible fixtures, ${spendable} credits spendable ` +
        `(<= ${MAX_CREDITS_PER_FIXTURE} each, usually 0 — an unpriced event is not charged)`;

  if (budget === 0) {
    log.info('no hayal odds fetched', { ...result });
    return result;
  }

  const [marketIds, selectionIds] = await Promise.all([loadMarketIds(), loadSelectionIds()]);
  const bookmakerCache = new Map<string, string>();
  const markets = new Set<string>();

  for (const match of eligible.slice(0, budget)) {
    const competitionKey = match.league.oddsApiKey;
    const eventId = match.oddsEventExternalId;
    if (!competitionKey || !eventId) continue;

    /**
     * Re-read the budget between fixtures rather than assuming the worst case.
     *
     * Most of these fetches cost nothing, so a fixed per-fixture estimate would
     * stop the run long before the credits ran out. Reading what the provider
     * actually charged keeps the sweep going while there is room, and stops it
     * the moment there is not.
     */
    const current = await getQuotaSnapshot(policy);
    if (current.exhausted || current.remaining - reserve < MAX_CREDITS_PER_FIXTURE) {
      result.budgetReason = `stopped after ${result.fixturesFetched} fixtures: ${current.remaining} credits left`;
      break;
    }

    const event = await provider.getEventMarkets(competitionKey, eventId, HALF_TIME_MARKETS);
    result.fixturesFetched++;
    // Spend is the difference the provider itself reports, not an estimate.
    const after = await getQuotaSnapshot(policy);
    result.creditsSpent += Math.max(0, current.remaining - after.remaining);
    if (!event) continue;

    const rows: Prisma.OddsCreateManyInput[] = [];
    for (const price of event.odds) {
      const marketId = marketIds.get(price.marketCode);
      const selectionId = selectionIds.get(`${price.marketCode}:${price.selectionCode}`);
      // A market we do not model is dropped, never invented.
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

  result.marketsSeen = [...markets].sort();
  log.info('hayal odds sync complete', { ...result });
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
