import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getOddsProvider, THE_ODDS_API } from '@/lib/providers';
import type { ProviderOddsEvent } from '@/lib/providers/types';
import { getAppSetting } from '@/lib/config/settings-service';
import { normalizeTeamName, similarity } from './team-resolver';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';

const log = createLogger('ingestion:bulletin');

/**
 * Pulls the bulletin: which markets are actually priced right now (§41).
 *
 * A market absent from here is not eligible for a coupon, no matter what the
 * model thinks of it. This is also the most expensive job we run — The Odds API
 * charges `markets × regions` credits per competition — so the competition list
 * is capped and prioritised rather than "fetch everything".
 */

export interface BulletinSyncResult {
  competitionsRequested: number;
  eventsSeen: number;
  eventsMatched: number;
  eventsUnmatched: number;
  pricesStored: number;
  quotaRemaining: number | null;
}

/** Kickoffs may disagree slightly between providers; this is the tolerance. */
const KICKOFF_TOLERANCE_MS = 3 * 60 * 60 * 1000;
/** Both team names must clear this to accept an event↔fixture pairing. */
const EVENT_MATCH_THRESHOLD = 0.8;

export async function syncBulletinForWindow(window: CoverageWindow): Promise<BulletinSyncResult> {
  const maxCompetitions = await getAppSetting<number>('odds.maxCompetitionsPerRun', 6);

  // Only competitions that actually have fixtures in the window are worth
  // spending credits on.
  const leagues = await prisma.league.findMany({
    where: {
      active: true,
      oddsApiKey: { not: null },
      matches: { some: { scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc } } },
    },
    select: { id: true, oddsApiKey: true, tier: true, dataQuality: true },
    orderBy: [{ tier: 'asc' }, { dataQuality: 'desc' }],
    take: maxCompetitions,
  });

  const result: BulletinSyncResult = {
    competitionsRequested: leagues.length,
    eventsSeen: 0,
    eventsMatched: 0,
    eventsUnmatched: 0,
    pricesStored: 0,
    quotaRemaining: null,
  };

  if (leagues.length === 0) {
    log.info('no priced competitions have fixtures in this window');
    return result;
  }

  const bulletin = await getOddsProvider().getBulletin(
    leagues.map((l) => l.oddsApiKey).filter((key): key is string => key !== null),
  );
  result.quotaRemaining = bulletin.quotaRemaining;
  result.eventsSeen = bulletin.events.length;

  const [marketIds, selectionIds] = await Promise.all([loadMarketIds(), loadSelectionIds()]);
  const bookmakerCache = new Map<string, string>();

  for (const event of bulletin.events) {
    const matchId = await resolveEventToMatch(event, window);
    if (!matchId) {
      result.eventsUnmatched++;
      continue;
    }
    result.eventsMatched++;

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

      rows.push({
        matchId,
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
      // Append-only: an unchanged price at the same instant is a duplicate and
      // is skipped, but a new capture time is always a new row (§22).
      const written = await prisma.odds.createMany({ data: rows, skipDuplicates: true });
      result.pricesStored += written.count;
    }
  }

  log.info('bulletin sync complete', { ...result });
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

/**
 * Links an odds-provider event to one of our fixtures.
 *
 * The two providers share no ids, so the first match is done on team names plus
 * kickoff time and then cached on the fixture — later syncs are a direct lookup
 * and cost nothing.
 */
export async function resolveEventToMatch(
  event: ProviderOddsEvent,
  window: CoverageWindow,
): Promise<string | null> {
  const known = await prisma.match.findFirst({
    where: { oddsEventExternalId: event.externalId },
    select: { id: true },
  });
  if (known) return known.id;

  const candidates = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: {
        gte: new Date(event.commenceTimeUtc.getTime() - KICKOFF_TOLERANCE_MS),
        lte: new Date(event.commenceTimeUtc.getTime() + KICKOFF_TOLERANCE_MS),
      },
      oddsEventExternalId: null,
    },
    select: {
      id: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
    },
    take: 200,
  });

  const home = normalizeTeamName(event.homeTeamName);
  const away = normalizeTeamName(event.awayTeamName);

  let best: { id: string; score: number } | null = null;
  for (const candidate of candidates) {
    const homeScore = similarity(home, normalizeTeamName(candidate.homeTeam.name));
    const awayScore = similarity(away, normalizeTeamName(candidate.awayTeam.name));
    // Both sides must agree — a strong home match with a weak away match is a
    // different fixture, not a spelling variant.
    const score = Math.min(homeScore, awayScore);
    if (!best || score > best.score) best = { id: candidate.id, score };
  }

  if (!best || best.score < EVENT_MATCH_THRESHOLD) {
    log.warn('unmatched bulletin event', {
      event: `${event.homeTeamName} v ${event.awayTeamName}`,
      commenceTime: event.commenceTimeUtc.toISOString(),
      bestScore: best?.score ?? 0,
      windowStart: window.startUtc.toISOString(),
    });
    return null;
  }

  await prisma.match.update({
    where: { id: best.id },
    data: { oddsEventExternalId: event.externalId },
  });
  return best.id;
}
