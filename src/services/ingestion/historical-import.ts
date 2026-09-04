import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getHistoricalProvider, FOOTBALL_DATA_CSV } from '@/lib/providers';
import type { HistoricalMatchRow } from '@/lib/providers/football-data-csv/parser';
import { normalizeTeamName, resolveTeam } from './team-resolver';

const log = createLogger('ingestion:historical');

/**
 * Bulk history from the football-data.co.uk archive.
 *
 * This is where the model's training data and the backtest's closing lines come
 * from. It is unmetered, so it can pull years at a time — which is exactly what
 * the metered live APIs cannot do.
 */

export interface HistoricalImportResult {
  division: string;
  seasonStartYear: number;
  rowsParsed: number;
  matchesImported: number;
  statisticsImported: number;
  oddsImported: number;
  unresolvedTeams: string[];
}

export async function importSeason(
  division: string,
  seasonStartYear: number,
): Promise<HistoricalImportResult> {
  const league = await prisma.league.findFirst({
    where: { csvDivision: division },
    select: { id: true, country: true },
  });
  if (!league) {
    throw new Error(`No league is mapped to CSV division "${division}"`);
  }

  const rows = await getHistoricalProvider().getSeason(division, seasonStartYear);

  const season = await prisma.season.upsert({
    where: {
      source_externalId: {
        source: FOOTBALL_DATA_CSV,
        externalId: `${division}-${seasonStartYear}`,
      },
    },
    update: {},
    create: {
      leagueId: league.id,
      source: FOOTBALL_DATA_CSV,
      externalId: `${division}-${seasonStartYear}`,
      name: `${seasonStartYear}/${String((seasonStartYear + 1) % 100).padStart(2, '0')}`,
      current: false,
    },
    select: { id: true },
  });

  const [markets, selections, bookmakers] = await Promise.all([
    prisma.bettingMarket.findMany({ select: { id: true, code: true } }),
    prisma.bettingSelection.findMany({
      select: { id: true, code: true, market: { select: { code: true } } },
    }),
    prisma.bookmaker.findMany({ where: { source: FOOTBALL_DATA_CSV }, select: { id: true, name: true } }),
  ]);

  const marketIds = new Map(markets.map((m) => [m.code, m.id]));
  const selectionIds = new Map(selections.map((s) => [`${s.market.code}:${s.code}`, s.id]));
  const bookmakerIds = new Map(bookmakers.map((b) => [b.name, b.id]));

  const result: HistoricalImportResult = {
    division,
    seasonStartYear,
    rowsParsed: rows.length,
    matchesImported: 0,
    statisticsImported: 0,
    oddsImported: 0,
    unresolvedTeams: [],
  };

  const teamCache = new Map<string, string>();

  /**
   * Batched import.
   *
   * The naive one-match-at-a-time version issued ~6 round trips per fixture,
   * which over a remote database turns a full season into minutes and a full
   * archive into hours. Everything below is grouped into a handful of bulk
   * statements instead.
   */
  interface PreparedRow {
    row: HistoricalMatchRow;
    externalId: string;
    homeTeamId: string;
    awayTeamId: string;
  }

  const prepared: PreparedRow[] = [];

  for (const row of rows) {
    const homeTeamId = await resolveHistoricalTeam(row.homeTeamName, league.country, teamCache);
    const awayTeamId = await resolveHistoricalTeam(row.awayTeamName, league.country, teamCache);

    if (!homeTeamId || !awayTeamId || homeTeamId === awayTeamId) {
      if (!homeTeamId) result.unresolvedTeams.push(row.homeTeamName);
      if (!awayTeamId) result.unresolvedTeams.push(row.awayTeamName);
      continue;
    }

    prepared.push({ row, externalId: buildExternalId(division, row), homeTeamId, awayTeamId });
  }

  if (prepared.length === 0) return result;

  // Historical results do not change, so anything already imported is skipped
  // outright rather than re-written. That makes a re-run nearly free.
  const existing = await prisma.match.findMany({
    where: {
      source: FOOTBALL_DATA_CSV,
      externalId: { in: prepared.map((p) => p.externalId) },
    },
    select: { id: true, externalId: true },
  });
  const idByExternal = new Map(existing.map((m) => [m.externalId, m.id]));
  const missing = prepared.filter((p) => !idByExternal.has(p.externalId));

  if (missing.length > 0) {
    await prisma.match.createMany({
      data: missing.map((p) => ({
        source: FOOTBALL_DATA_CSV,
        externalId: p.externalId,
        leagueId: league.id,
        seasonId: season.id,
        homeTeamId: p.homeTeamId,
        awayTeamId: p.awayTeamId,
        scheduledKickoffUtc: p.row.kickoffUtc,
        status: 'FINISHED' as const,
        providerStatus: 'FT',
        referee: p.row.referee,
        homeScore: p.row.homeScore,
        awayScore: p.row.awayScore,
        halfTimeHomeScore: p.row.halfTimeHomeScore,
        halfTimeAwayScore: p.row.halfTimeAwayScore,
        finishedAtUtc: p.row.kickoffUtc,
      })),
      skipDuplicates: true,
    });

    // Re-read to pick up the generated ids for the rows we just inserted.
    const inserted = await prisma.match.findMany({
      where: {
        source: FOOTBALL_DATA_CSV,
        externalId: { in: missing.map((p) => p.externalId) },
      },
      select: { id: true, externalId: true },
    });
    for (const match of inserted) idByExternal.set(match.externalId, match.id);
    result.matchesImported = inserted.length;
  }

  const newlyImported = new Set(missing.map((p) => p.externalId));
  const freshRows = prepared.filter((p) => newlyImported.has(p.externalId));
  if (freshRows.length === 0) return result;

  // Statistics: two rows per match, one per side.
  const statistics = freshRows.flatMap((p) => {
    const matchId = idByExternal.get(p.externalId);
    if (!matchId) return [];
    return [
      { matchId, teamId: p.homeTeamId, stats: p.row.homeStats },
      { matchId, teamId: p.awayTeamId, stats: p.row.awayStats },
    ].map((entry) => ({
      matchId: entry.matchId,
      teamId: entry.teamId,
      source: FOOTBALL_DATA_CSV,
      // The archive carries no xG; leaving it null is the honest answer (§12).
      shots: entry.stats.shots,
      shotsOnTarget: entry.stats.shotsOnTarget,
      fouls: entry.stats.fouls,
      corners: entry.stats.corners,
      yellowCards: entry.stats.yellowCards,
      redCards: entry.stats.redCards,
    }));
  });

  if (statistics.length > 0) {
    const written = await prisma.matchStatistic.createMany({
      data: statistics,
      skipDuplicates: true,
    });
    result.statisticsImported = written.count;
  }

  const oddsRows = freshRows.flatMap((p) => {
    const matchId = idByExternal.get(p.externalId);
    if (!matchId) return [];
    return buildOddsRows(matchId, p.row, marketIds, selectionIds, bookmakerIds);
  });

  // Chunked so one statement never carries tens of thousands of parameters.
  for (let i = 0; i < oddsRows.length; i += 2000) {
    const written = await prisma.odds.createMany({
      data: oddsRows.slice(i, i + 2000),
      skipDuplicates: true,
    });
    result.oddsImported += written.count;
  }

  log.info('season imported', {
    division,
    seasonStartYear,
    matches: result.matchesImported,
    odds: result.oddsImported,
  });
  return result;
}

/** Stable id from the fixture itself; the archive has no match ids. */
function buildExternalId(division: string, row: HistoricalMatchRow): string {
  const slug = (name: string) => normalizeTeamName(name).replace(/\s/g, '_');
  return `${division}-${row.kickoffUtc.toISOString().slice(0, 10)}-${slug(row.homeTeamName)}-${slug(
    row.awayTeamName,
  )}`;
}

async function resolveHistoricalTeam(
  name: string,
  country: string | null,
  cache: Map<string, string>,
): Promise<string | null> {
  const cached = cache.get(name);
  if (cached) return cached;

  const resolved = await resolveTeam({ source: FOOTBALL_DATA_CSV, name, country });
  if (resolved) {
    cache.set(name, resolved.teamId);
    return resolved.teamId;
  }

  // The archive carries no ids, so a genuinely new club is created keyed on its
  // normalised name — stable across seasons and re-imports.
  const normalized = normalizeTeamName(name);
  const created = await prisma.team.upsert({
    where: { source_externalId: { source: FOOTBALL_DATA_CSV, externalId: normalized } },
    update: {},
    create: {
      source: FOOTBALL_DATA_CSV,
      externalId: normalized,
      name,
      country,
      active: true,
    },
    select: { id: true },
  });

  await prisma.teamAlias
    .upsert({
      where: { source_normalized: { source: FOOTBALL_DATA_CSV, normalized } },
      update: {},
      create: {
        teamId: created.id,
        source: FOOTBALL_DATA_CSV,
        alias: name,
        normalized,
        confidence: 1,
        verified: true,
      },
    })
    .catch(() => undefined);

  cache.set(name, created.id);
  return created.id;
}

/**
 * The archive gives no capture timestamps, only "opening" and "closing"
 * columns. Rather than inventing precise times, opening prices are stamped 24h
 * before kickoff and closing prices at kickoff; both carry the explicit
 * `isOpening` / `isClosing` flags that backtests actually filter on.
 */
function buildOddsRows(
  matchId: string,
  row: HistoricalMatchRow,
  marketIds: Map<string, string>,
  selectionIds: Map<string, string>,
  bookmakerIds: Map<string, string>,
): Prisma.OddsCreateManyInput[] {
  const openingAt = new Date(row.kickoffUtc.getTime() - 24 * 60 * 60 * 1000);
  const data: Prisma.OddsCreateManyInput[] = [];

  for (const price of row.odds) {
    const marketId = marketIds.get(price.marketCode);
    const selectionId = selectionIds.get(`${price.marketCode}:${price.selectionCode}`);
    const bookmakerId = bookmakerIds.get(price.bookmakerName);
    if (!marketId || !selectionId || !bookmakerId) continue;

    data.push({
      matchId,
      bookmakerId,
      marketId,
      selectionId,
      price: new Prisma.Decimal(price.price.toFixed(3)),
      handicap: new Prisma.Decimal(price.handicap.toFixed(2)),
      isOpening: price.isOpening,
      isClosing: price.isClosing,
      capturedAt: price.isClosing ? row.kickoffUtc : openingAt,
      source: FOOTBALL_DATA_CSV,
    });
  }

  return data;
}

/** Imports several seasons of one division, newest first. */
export async function importSeasons(
  division: string,
  startYears: number[],
): Promise<HistoricalImportResult[]> {
  const results: HistoricalImportResult[] = [];
  for (const year of startYears) {
    try {
      results.push(await importSeason(division, year));
    } catch (error) {
      // A season file that does not exist yet must not abort the whole import.
      log.warn('season import failed, continuing', {
        division,
        year,
        error: String(error),
      });
    }
  }
  return results;
}
