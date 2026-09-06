import { createApiFootballClient, API_FOOTBALL } from './client';
import { createLogger } from '@/lib/logging/logger';
import type { QuotaPolicy } from '../quota';
import type {
  FootballDataProvider,
  ProviderFixture,
  ProviderInjury,
  ProviderLeague,
  ProviderLineup,
  ProviderMatchStatistics,
  ProviderMatchStatus,
  ProviderSeason,
  ProviderTeam,
  ProviderTeamMatchStatistics,
} from '../types';

// --- raw response shapes (only the fields we consume) ----------------------

interface RawLeague {
  league: { id: number; name: string; type: string | null; logo: string | null };
  country: { name: string | null; code: string | null };
  seasons: Array<{ year: number; start: string | null; end: string | null; current: boolean }>;
}

interface RawTeam {
  team: {
    id: number;
    name: string;
    code: string | null;
    country: string | null;
    founded: number | null;
    logo: string | null;
  };
  venue: { name: string | null } | null;
}

interface RawFixture {
  fixture: {
    id: number;
    referee: string | null;
    timezone: string | null;
    date: string;
    timestamp: number;
    status: { long: string; short: string; elapsed: number | null };
    venue: { name: string | null } | null;
  };
  league: { id: number; season: number; round: string | null };
  teams: {
    home: { id: number; name: string; logo: string | null };
    away: { id: number; name: string; logo: string | null };
  };
  goals: { home: number | null; away: number | null };
  score: {
    halftime: { home: number | null; away: number | null };
    fulltime: { home: number | null; away: number | null };
  };
}

interface RawStatisticsEntry {
  team: { id: number };
  statistics: Array<{ type: string; value: number | string | null }>;
}

interface RawLineup {
  team: { id: number };
  formation: string | null;
  startXI: Array<{ player: { id: number; name: string; number: number | null; pos: string | null } }>;
  substitutes: Array<{ player: { id: number; name: string; number: number | null; pos: string | null } }>;
}

interface RawInjury {
  player: { id: number; name: string; type: string | null; reason: string | null };
  team: { id: number };
  fixture: { id: number; date: string };
}

// --- mapping ---------------------------------------------------------------

/**
 * API-Football's short status codes. Anything unrecognised falls back to
 * SCHEDULED rather than silently becoming FINISHED — a wrong FINISHED would
 * settle coupons against a match that never ended (§31).
 */
const STATUS_MAP: Record<string, ProviderMatchStatus> = {
  TBD: 'SCHEDULED',
  NS: 'SCHEDULED',
  '1H': 'LIVE',
  '2H': 'LIVE',
  ET: 'LIVE',
  BT: 'LIVE',
  P: 'LIVE',
  INT: 'LIVE',
  LIVE: 'LIVE',
  HT: 'HALF_TIME',
  FT: 'FINISHED',
  AET: 'FINISHED',
  PEN: 'FINISHED',
  PST: 'POSTPONED',
  CANC: 'CANCELED',
  SUSP: 'SUSPENDED',
  ABD: 'ABANDONED',
  AWD: 'AWARDED',
  WO: 'AWARDED',
};

function mapStatus(short: string): ProviderMatchStatus {
  return STATUS_MAP[short] ?? 'SCHEDULED';
}

function toNumber(value: number | string | null): number | null {
  if (value === null) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // "63%" -> 63
  const parsed = Number.parseFloat(value.replace('%', '').trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function mapFixture(raw: RawFixture): ProviderFixture {
  return {
    externalId: String(raw.fixture.id),
    source: API_FOOTBALL,
    leagueExternalId: String(raw.league.id),
    seasonExternalId: String(raw.league.season),
    homeTeamExternalId: String(raw.teams.home.id),
    awayTeamExternalId: String(raw.teams.away.id),
    homeTeamName: raw.teams.home.name,
    awayTeamName: raw.teams.away.name,
    homeTeamLogo: raw.teams.home.logo,
    awayTeamLogo: raw.teams.away.logo,
    kickoffUtc: new Date(raw.fixture.timestamp * 1000),
    venueTimezone: raw.fixture.timezone,
    status: mapStatus(raw.fixture.status.short),
    rawStatus: raw.fixture.status.short,
    round: raw.league.round,
    venue: raw.fixture.venue?.name ?? null,
    referee: raw.fixture.referee,
    homeScore: raw.goals.home,
    awayScore: raw.goals.away,
    halfTimeHomeScore: raw.score.halftime.home,
    halfTimeAwayScore: raw.score.halftime.away,
    providerUpdatedAt: null,
  };
}

/** Maps API-Football's free-text statistic labels onto our fields. */
const STAT_KEYS: Record<string, keyof ProviderTeamMatchStatistics> = {
  'Ball Possession': 'possession',
  'Total Shots': 'shots',
  'Shots on Goal': 'shotsOnTarget',
  'Shots off Goal': 'shotsOffTarget',
  'Blocked Shots': 'blockedShots',
  'Corner Kicks': 'corners',
  Fouls: 'fouls',
  Offsides: 'offsides',
  'Yellow Cards': 'yellowCards',
  'Red Cards': 'redCards',
  'Goalkeeper Saves': 'saves',
  'Total passes': 'passes',
  'Passes %': 'passAccuracy',
  expected_goals: 'expectedGoals',
};

function mapTeamStatistics(entry: RawStatisticsEntry): ProviderTeamMatchStatistics {
  const stats: ProviderTeamMatchStatistics = {
    teamExternalId: String(entry.team.id),
    possession: null,
    shots: null,
    shotsOnTarget: null,
    shotsOffTarget: null,
    blockedShots: null,
    corners: null,
    fouls: null,
    offsides: null,
    yellowCards: null,
    redCards: null,
    saves: null,
    passes: null,
    passAccuracy: null,
    expectedGoals: null,
    expectedGoalsAgainst: null,
    extra: null,
  };

  const extra: Record<string, unknown> = {};
  for (const item of entry.statistics) {
    const key = STAT_KEYS[item.type];
    if (key && key !== 'teamExternalId' && key !== 'extra') {
      // Every mapped field is `number | null`.
      (stats[key] as number | null) = toNumber(item.value);
    } else {
      // Keep unmapped provider stats rather than dropping them (§12).
      extra[item.type] = item.value;
    }
  }
  stats.extra = Object.keys(extra).length > 0 ? extra : null;
  return stats;
}

// --- provider --------------------------------------------------------------

const log = createLogger('provider:api-football');

/**
 * True when the provider refused because of the plan, not because of the data.
 *
 * Worth distinguishing: a plan restriction is permanent and needs a different
 * request shape, whereas a transient error should just be retried.
 */
function isPlanRestriction(error: unknown): boolean {
  return error instanceof Error && /do not have access|not available for your plan/i.test(error.message);
}

export function createApiFootballProvider(config: {
  apiKey: string;
  baseUrl: string;
  quota: QuotaPolicy;
}): FootballDataProvider {
  const client = createApiFootballClient(config);

  /**
   * Remembered per process: the Free plan refuses the batched `ids` parameter,
   * and finding that out again on every run costs a request we cannot spare.
   */
  let idsParameterUnavailable = false;

  return {
    name: API_FOOTBALL,

    async getLeagues(): Promise<ProviderLeague[]> {
      const raw = await client.fetch<RawLeague[]>('/leagues', undefined, { respectReserve: true });
      return raw.map((item) => ({
        externalId: String(item.league.id),
        source: API_FOOTBALL,
        name: item.league.name,
        country: item.country.name,
        countryCode: item.country.code,
        type: item.league.type,
        logo: item.league.logo,
      }));
    },

    async getSeasons(leagueExternalId: string): Promise<ProviderSeason[]> {
      const raw = await client.fetch<RawLeague[]>('/leagues', { id: leagueExternalId });
      const entry = raw[0];
      if (!entry) return [];
      return entry.seasons.map((season) => ({
        externalId: String(season.year),
        source: API_FOOTBALL,
        leagueExternalId,
        name: String(season.year),
        startDate: season.start ? new Date(season.start) : null,
        endDate: season.end ? new Date(season.end) : null,
        current: season.current,
      }));
    },

    async getTeams(leagueExternalId: string, seasonExternalId: string): Promise<ProviderTeam[]> {
      const raw = await client.fetch<RawTeam[]>('/teams', {
        league: leagueExternalId,
        season: seasonExternalId,
      });
      return raw.map((item) => ({
        externalId: String(item.team.id),
        source: API_FOOTBALL,
        name: item.team.name,
        shortName: item.team.code,
        country: item.team.country,
        logo: item.team.logo,
        founded: item.team.founded,
        venue: item.venue?.name ?? null,
      }));
    },

    async getFixturesByDate(date: Date): Promise<ProviderFixture[]> {
      const raw = await client.fetch<RawFixture[]>(
        '/fixtures',
        { date: date.toISOString().slice(0, 10) },
        // Results are what this budget is for; an unsettled coupon is worse
        // than a stale price, so this may spend the probe a held budget allows.
        { allowProbe: true },
      );
      return raw.map(mapFixture);
    },

    async getFixturesByIds(matchExternalIds: string[]): Promise<ProviderFixture[]> {
      if (matchExternalIds.length === 0) return [];

      // The endpoint accepts 20 dash-separated ids per call, but only on a paid
      // plan — Free rejects `ids` outright ("Free plans do not have access to
      // the Ids parameter"), which silently broke result sync entirely. Try the
      // cheap batched form first and fall back to one call per fixture, which
      // every plan allows.
      const batches: string[][] = [];
      for (let i = 0; i < matchExternalIds.length; i += 20) {
        batches.push(matchExternalIds.slice(i, i + 20));
      }

      const results: ProviderFixture[] = [];
      for (const batch of batches) {
        /**
         * Do not re-learn a plan restriction on every run.
         *
         * The batched `ids` form is refused outright on the Free plan, and
         * asking anyway spent the single probe a held budget allows — so the
         * per-fixture fallback that follows was then blocked by the gate and
         * result sync did nothing at all. Once refused, it stays refused for
         * the life of the process.
         */
        if (idsParameterUnavailable) {
          for (const [index, id] of batch.entries()) {
            const raw = await client.fetch<RawFixture[]>(
              '/fixtures',
              { id },
              { allowProbe: index === 0 },
            );
            results.push(...raw.map(mapFixture));
          }
          continue;
        }

        try {
          /**
           * Results are the one thing worth probing a closed budget for.
           *
           * An unsettled coupon is worse than a slightly stale price: the
           * reader is left with a slip that never resolves. So this call may
           * spend the one probe a held budget allows, which is how the day's
           * results get in the moment the provider's window rolls.
           */
          const raw = await client.fetch<RawFixture[]>(
            '/fixtures',
            { ids: batch.join('-') },
            { allowProbe: true },
          );
          results.push(...raw.map(mapFixture));
        } catch (error) {
          if (!isPlanRestriction(error)) throw error;

          idsParameterUnavailable = true;
          log.info('ids parameter unavailable on this plan, fetching individually', {
            fixtures: batch.length,
          });
          for (const [index, id] of batch.entries()) {
            const raw = await client.fetch<RawFixture[]>(
              '/fixtures',
              { id },
              { allowProbe: index === 0 },
            );
            results.push(...raw.map(mapFixture));
          }
        }
      }
      return results;
    },

    async getFixturesBySeason(
      leagueExternalId: string,
      seasonExternalId: string,
    ): Promise<ProviderFixture[]> {
      const raw = await client.fetch<RawFixture[]>(
        '/fixtures',
        { league: leagueExternalId, season: seasonExternalId },
        { respectReserve: true },
      );
      return raw.map(mapFixture);
    },

    async getMatchStatistics(matchExternalId: string): Promise<ProviderMatchStatistics | null> {
      const raw = await client.fetch<RawStatisticsEntry[]>('/fixtures/statistics', {
        fixture: matchExternalId,
      });
      if (raw.length === 0) return null;
      return { matchExternalId, teams: raw.map(mapTeamStatistics) };
    },

    async getHeadToHead(
      homeTeamExternalId: string,
      awayTeamExternalId: string,
    ): Promise<ProviderFixture[]> {
      const raw = await client.fetch<RawFixture[]>(
        '/fixtures/headtohead',
        { h2h: `${homeTeamExternalId}-${awayTeamExternalId}`, last: 20 },
        { respectReserve: true },
      );
      return raw.map(mapFixture);
    },

    async getLineups(matchExternalId: string): Promise<ProviderLineup[]> {
      const raw = await client.fetch<RawLineup[]>('/fixtures/lineups', {
        fixture: matchExternalId,
      });
      // The endpoint only returns confirmed lineups, and only once published —
      // so "now" is a truthful publication time for leakage purposes.
      const publishedAt = new Date();
      return raw.map((item) => ({
        matchExternalId,
        teamExternalId: String(item.team.id),
        type: 'CONFIRMED' as const,
        formation: item.formation,
        publishedAt,
        players: [
          ...item.startXI.map((p) => ({
            playerExternalId: String(p.player.id),
            playerName: p.player.name,
            starter: true,
            position: p.player.pos,
            shirtNumber: p.player.number,
          })),
          ...item.substitutes.map((p) => ({
            playerExternalId: String(p.player.id),
            playerName: p.player.name,
            starter: false,
            position: p.player.pos,
            shirtNumber: p.player.number,
          })),
        ],
      }));
    },

    async getInjuries(matchExternalId: string): Promise<ProviderInjury[]> {
      const raw = await client.fetch<RawInjury[]>('/injuries', { fixture: matchExternalId });
      return raw.map((item) => ({
        playerExternalId: String(item.player.id),
        playerName: item.player.name,
        teamExternalId: String(item.team.id),
        status: item.player.type?.toLowerCase().includes('question') ? 'DOUBTFUL' : 'OUT',
        reason: item.player.reason,
        publishedAt: new Date(item.fixture.date),
      }));
    },
  };
}
