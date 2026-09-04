import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getFootballProvider, API_FOOTBALL } from '@/lib/providers';
import { ProviderError, type ProviderFixture } from '@/lib/providers/types';
import { normalizeTeamName, resolveOrCreateTeam } from './team-resolver';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';
import { CSV_DIVISIONS } from '@/lib/providers/football-data-csv/divisions';

const log = createLogger('ingestion:fixtures');

/**
 * Pulls the fixtures a publication needs to analyse (§42 step 1).
 *
 * The endpoint returns every competition for a date, so one request covers a
 * whole day regardless of how many leagues we track. With a 100-request daily
 * budget that difference is the difference between viable and not.
 */

export interface FixtureSyncResult {
  daysRequested: number;
  daysFetched: number;
  /**
   * Days the provider refused, typically because the plan's date range does
   * not reach that far ahead. They are retried by the top-up job once they
   * come into range — never silently dropped.
   */
  daysDeferred: string[];
  fixturesSeen: number;
  matchesUpserted: number;
  skippedUnmappedLeague: number;
  unresolvedTeams: number;
}

/**
 * Resolves our seeded leagues to API-Football ids, once, and caches them.
 * Costs a single request and then never runs again.
 */
export async function ensureLeagueMapping(): Promise<number> {
  const unmapped = await prisma.league.findMany({
    where: { active: true, apiFootballId: null },
    select: { id: true, name: true, country: true, csvDivision: true },
  });
  if (unmapped.length === 0) return 0;

  const provider = getFootballProvider();
  const providerLeagues = await provider.getLeagues();
  const overrides = new Map(CSV_DIVISIONS.map((d) => [d.code, d]));

  let mapped = 0;
  for (const league of unmapped) {
    // Some competitions are filed differently by the provider — a different
    // name ("Segunda División") or a different country spelling ("Turkey").
    const override = league.csvDivision ? overrides.get(league.csvDivision) : undefined;
    const target = normalizeTeamName(override?.apiFootballName ?? league.name);
    const country = (override?.apiFootballCountry ?? league.country)?.toLowerCase();

    const match = providerLeagues.find((candidate) => {
      if (normalizeTeamName(candidate.name) !== target) return false;
      if (!country || !candidate.country) return true;
      // Country must agree: "Premier League" exists in a dozen countries.
      return candidate.country.toLowerCase() === country;
    });

    if (!match) {
      log.warn('no API-Football league matched', { league: league.name, country: league.country });
      continue;
    }

    const apiFootballId = Number(match.externalId);
    if (!Number.isInteger(apiFootballId)) continue;

    // A unique collision means another row already claimed this id.
    await prisma.league
      .update({ where: { id: league.id }, data: { apiFootballId } })
      .then(() => {
        mapped++;
      })
      .catch(() => log.warn('league id already claimed', { league: league.name, apiFootballId }));
  }

  log.info('league mapping complete', { mapped, unmapped: unmapped.length });
  return mapped;
}

/** Every UTC calendar date the local window touches. */
export function utcDatesSpanning(startUtc: Date, endUtc: Date): string[] {
  const dates: string[] = [];
  const cursor = new Date(
    Date.UTC(startUtc.getUTCFullYear(), startUtc.getUTCMonth(), startUtc.getUTCDate()),
  );
  // endUtc is exclusive, but a kickoff at 23:59 on the last day still counts.
  while (cursor.getTime() < endUtc.getTime()) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

export async function syncFixturesForWindow(window: CoverageWindow): Promise<FixtureSyncResult> {
  await ensureLeagueMapping();

  const leagues = await prisma.league.findMany({
    where: { active: true, apiFootballId: { not: null } },
    select: { id: true, apiFootballId: true, country: true },
  });
  const leagueByApiId = new Map(leagues.map((l) => [String(l.apiFootballId), l]));

  const provider = getFootballProvider();
  const dates = utcDatesSpanning(window.startUtc, window.endUtc);

  const result: FixtureSyncResult = {
    daysRequested: dates.length,
    daysFetched: 0,
    daysDeferred: [],
    fixturesSeen: 0,
    matchesUpserted: 0,
    skippedUnmappedLeague: 0,
    unresolvedTeams: 0,
  };

  for (const date of dates) {
    let fixtures;
    try {
      fixtures = await provider.getFixturesByDate(new Date(`${date}T00:00:00Z`));
    } catch (error) {
      // One rejected day must not abort the window (§43). The API-Football
      // Free plan only serves a narrow date range, so days further ahead are
      // deferred until they come into range rather than failing the run.
      if (error instanceof ProviderError) {
        result.daysDeferred.push(date);
        log.warn('fixture day unavailable, deferring', { date, error: error.message });
        continue;
      }
      throw error;
    }

    result.daysFetched++;
    result.fixturesSeen += fixtures.length;

    for (const fixture of fixtures) {
      // Only kickoffs inside the local window, not the whole UTC day.
      if (
        fixture.kickoffUtc.getTime() < window.startUtc.getTime() ||
        fixture.kickoffUtc.getTime() >= window.endUtc.getTime()
      ) {
        continue;
      }

      const league = leagueByApiId.get(fixture.leagueExternalId);
      if (!league) {
        result.skippedUnmappedLeague++;
        continue;
      }

      const persisted = await upsertFixture(fixture, league.id, league.country);
      if (persisted) result.matchesUpserted++;
      else result.unresolvedTeams++;
    }
  }

  log.info('fixture sync complete', { ...result });
  return result;
}

/** Refreshes a specific set of fixtures — the result-sync path. */
export async function syncFixturesByExternalIds(externalIds: string[]): Promise<ProviderFixture[]> {
  if (externalIds.length === 0) return [];
  return getFootballProvider().getFixturesByIds(externalIds);
}

async function upsertFixture(
  fixture: ProviderFixture,
  leagueId: string,
  country: string | null,
): Promise<boolean> {
  const season = await prisma.season.upsert({
    // The year alone collides across leagues, so the key is league + year.
    where: {
      source_externalId: {
        source: API_FOOTBALL,
        externalId: `${fixture.leagueExternalId}-${fixture.seasonExternalId}`,
      },
    },
    update: {},
    create: {
      leagueId,
      source: API_FOOTBALL,
      externalId: `${fixture.leagueExternalId}-${fixture.seasonExternalId}`,
      name: fixture.seasonExternalId,
      current: true,
    },
    select: { id: true },
  });

  const [homeTeamId, awayTeamId] = await Promise.all([
    resolveOrCreateTeam({
      source: API_FOOTBALL,
      externalId: fixture.homeTeamExternalId,
      name: fixture.homeTeamName,
      logo: fixture.homeTeamLogo,
      country,
    }),
    resolveOrCreateTeam({
      source: API_FOOTBALL,
      externalId: fixture.awayTeamExternalId,
      name: fixture.awayTeamName,
      logo: fixture.awayTeamLogo,
      country,
    }),
  ]);

  if (homeTeamId === awayTeamId) {
    log.warn('fixture resolved both sides to one team, skipping', { fixture: fixture.externalId });
    return false;
  }

  await prisma.match.upsert({
    where: { source_externalId: { source: fixture.source, externalId: fixture.externalId } },
    update: {
      // Kickoff times move; status and score are owned by the result sync but
      // a fixture refresh may legitimately carry them too.
      scheduledKickoffUtc: fixture.kickoffUtc,
      status: fixture.status,
      providerStatus: fixture.rawStatus,
      venue: fixture.venue,
      referee: fixture.referee,
      round: fixture.round,
      fetchedAt: new Date(),
    },
    create: {
      source: fixture.source,
      externalId: fixture.externalId,
      leagueId,
      seasonId: season.id,
      homeTeamId,
      awayTeamId,
      scheduledKickoffUtc: fixture.kickoffUtc,
      venueTimezone: fixture.venueTimezone,
      status: fixture.status,
      providerStatus: fixture.rawStatus,
      round: fixture.round,
      venue: fixture.venue,
      referee: fixture.referee,
    },
  });

  // Keep the team<->season link so squad-scoped lookups work later.
  await Promise.all(
    [homeTeamId, awayTeamId].map((teamId) =>
      prisma.teamSeason
        .upsert({
          where: { teamId_seasonId: { teamId, seasonId: season.id } },
          update: {},
          create: { teamId, seasonId: season.id },
        })
        .catch(() => undefined),
    ),
  );

  return true;
}
