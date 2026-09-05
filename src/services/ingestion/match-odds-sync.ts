import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getMatchOddsProvider, API_FOOTBALL_ODDS } from '@/lib/providers';
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
  fixturesRequested: number;
  fixturesPriced: number;
  pricesStored: number;
  marketsSeen: string[];
  quotaRemaining: number | null;
}

export async function syncMatchOddsForWindow(
  window: CoverageWindow,
  options: { maxFixtures?: number } = {},
): Promise<MatchOddsSyncResult> {
  const maxFixtures =
    options.maxFixtures ?? (await getAppSetting<number>('odds.maxFixturesPerRun', 30));

  const candidates = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
      status: 'SCHEDULED',
      league: { active: true },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: { id: true, externalId: true, scheduledKickoffUtc: true },
  });

  const result: MatchOddsSyncResult = {
    fixturesConsidered: candidates.length,
    fixturesRequested: 0,
    fixturesPriced: 0,
    pricesStored: 0,
    marketsSeen: [],
    quotaRemaining: null,
  };

  if (candidates.length === 0) {
    log.info('no fixtures in window to price');
    return result;
  }

  const provider = getMatchOddsProvider();

  // Bulk pages a whole date, so the request cap no longer limits how many
  // fixtures can be priced — every candidate in the window is fair game.
  const bulkAvailable = provider.getBulletinByDate !== undefined && candidates.length >= 12;
  const requested = bulkAvailable ? candidates : candidates.slice(0, maxFixtures);
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
  const dates = [...new Set(requested.map((m) => m.scheduledKickoffUtc.toISOString().slice(0, 10)))];
  const useDateBulk = bulkAvailable;

  let bulletin;
  if (useDateBulk) {
    const perDate = Math.max(1, Math.floor(maxFixtures / dates.length));
    const events = [];
    let quotaRemaining: number | null = null;

    for (const date of dates) {
      const page = await provider.getBulletinByDate!(date, perDate);
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
