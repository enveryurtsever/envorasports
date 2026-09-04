import { MARKET, overUnderCode } from '@/lib/markets/registry';
import type {
  FootballDataProvider,
  OddsProvider,
  ProviderBulletin,
  ProviderFixture,
  ProviderInjury,
  ProviderLeague,
  ProviderLineup,
  ProviderMatchStatistics,
  ProviderOdds,
  ProviderOddsEvent,
  ProviderSeason,
  ProviderTeam,
} from '../types';

/**
 * Deterministic offline providers.
 *
 * They exist so the whole pipeline — ingestion, features, models, coupons,
 * settlement — can be developed and tested without spending a single request
 * from a 100/day or 500/month budget. Set FOOTBALL_PROVIDER=mock to use them.
 */

const MOCK = 'mock';

const TEAMS = [
  'Envora United',
  'Northbridge FC',
  'Riverside Athletic',
  'Kingsport City',
  'Westfield Rovers',
  'Ashford Town',
  'Highgate Wanderers',
  'Marchmont FC',
] as const;

/** Small deterministic hash so the same input always yields the same output. */
function seededUnit(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 10_000) / 10_000;
}

function utcMidnight(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function buildFixtures(date: Date): ProviderFixture[] {
  const day = utcMidnight(date);
  const dayKey = day.toISOString().slice(0, 10);

  return Array.from({ length: 4 }, (_, i) => {
    const home = TEAMS[i * 2] as string;
    const kickoff = new Date(day.getTime() + (18 + i) * 3600 * 1000);

    return {
      externalId: `${dayKey}-${i}`,
      source: MOCK,
      leagueExternalId: 'mock-league-1',
      seasonExternalId: String(day.getUTCFullYear()),
      homeTeamExternalId: `team-${i * 2}`,
      awayTeamExternalId: `team-${i * 2 + 1}`,
      homeTeamName: home,
      awayTeamName: TEAMS[i * 2 + 1] as string,
      homeTeamLogo: null,
      awayTeamLogo: null,
      kickoffUtc: kickoff,
      venueTimezone: 'Europe/London',
      status: 'SCHEDULED' as const,
      rawStatus: 'NS',
      round: 'Regular Season - 1',
      venue: `${home} Stadium`,
      referee: 'M. Referee',
      homeScore: null,
      awayScore: null,
      halfTimeHomeScore: null,
      halfTimeAwayScore: null,
      providerUpdatedAt: null,
    };
  });
}

export function createMockFootballProvider(): FootballDataProvider {
  return {
    name: MOCK,

    async getLeagues(): Promise<ProviderLeague[]> {
      return [
        {
          externalId: 'mock-league-1',
          source: MOCK,
          name: 'Envora Test League',
          country: 'Testland',
          countryCode: 'TL',
          type: 'League',
          logo: null,
        },
      ];
    },

    async getSeasons(leagueExternalId: string): Promise<ProviderSeason[]> {
      const year = new Date().getUTCFullYear();
      return [
        {
          externalId: String(year),
          source: MOCK,
          leagueExternalId,
          name: String(year),
          startDate: new Date(Date.UTC(year, 7, 1)),
          endDate: new Date(Date.UTC(year + 1, 4, 31)),
          current: true,
        },
      ];
    },

    async getTeams(): Promise<ProviderTeam[]> {
      return TEAMS.map((name, i) => ({
        externalId: `team-${i}`,
        source: MOCK,
        name,
        shortName: name.slice(0, 3).toUpperCase(),
        country: 'Testland',
        logo: null,
        founded: 1900 + i,
        venue: `${name} Stadium`,
      }));
    },

    async getFixturesByDate(date: Date): Promise<ProviderFixture[]> {
      return buildFixtures(date);
    },

    async getFixturesByIds(matchExternalIds: string[]): Promise<ProviderFixture[]> {
      // Replay the day encoded in the id and mark those fixtures finished, so
      // the result-sync and settlement paths have something to chew on.
      return matchExternalIds.flatMap((id) => {
        const dayKey = id.slice(0, 10);
        const parsed = new Date(`${dayKey}T00:00:00Z`);
        if (Number.isNaN(parsed.getTime())) return [];

        const fixture = buildFixtures(parsed).find((f) => f.externalId === id);
        if (!fixture) return [];

        const homeScore = Math.floor(seededUnit(`${id}-h`) * 4);
        const awayScore = Math.floor(seededUnit(`${id}-a`) * 3);
        return [
          {
            ...fixture,
            status: 'FINISHED' as const,
            rawStatus: 'FT',
            homeScore,
            awayScore,
            halfTimeHomeScore: Math.floor(homeScore / 2),
            halfTimeAwayScore: Math.floor(awayScore / 2),
            finishedAt: null,
          } as ProviderFixture,
        ];
      });
    },

    async getFixturesBySeason(): Promise<ProviderFixture[]> {
      const today = new Date();
      return [-2, -1, 0, 1, 2].flatMap((offset) =>
        buildFixtures(new Date(today.getTime() + offset * 86_400_000)),
      );
    },

    async getMatchStatistics(matchExternalId: string): Promise<ProviderMatchStatistics | null> {
      return {
        matchExternalId,
        teams: ['home', 'away'].map((side, i) => ({
          teamExternalId: `team-${i}`,
          possession: 45 + Math.round(seededUnit(`${matchExternalId}-${side}-pos`) * 10),
          shots: 8 + Math.round(seededUnit(`${matchExternalId}-${side}-s`) * 10),
          shotsOnTarget: 3 + Math.round(seededUnit(`${matchExternalId}-${side}-sot`) * 5),
          shotsOffTarget: null,
          blockedShots: null,
          corners: 3 + Math.round(seededUnit(`${matchExternalId}-${side}-c`) * 6),
          fouls: 8 + Math.round(seededUnit(`${matchExternalId}-${side}-f`) * 6),
          offsides: null,
          yellowCards: Math.round(seededUnit(`${matchExternalId}-${side}-y`) * 4),
          redCards: 0,
          saves: null,
          passes: null,
          passAccuracy: null,
          expectedGoals: Number((0.8 + seededUnit(`${matchExternalId}-${side}-xg`) * 1.6).toFixed(2)),
          expectedGoalsAgainst: null,
          extra: null,
        })),
      };
    },

    async getHeadToHead(): Promise<ProviderFixture[]> {
      return [];
    },

    async getLineups(): Promise<ProviderLineup[]> {
      return [];
    },

    async getInjuries(): Promise<ProviderInjury[]> {
      return [];
    },
  };
}

export function createMockOddsProvider(): OddsProvider {
  return {
    name: MOCK,

    async getSupportedCompetitions() {
      return [{ key: 'soccer_mock_league', title: 'Envora Test League', active: true }];
    },

    async getOdds(eventExternalId: string): Promise<ProviderOdds[]> {
      return buildOdds(eventExternalId, new Date());
    },

    async getBulletin(): Promise<ProviderBulletin> {
      const capturedAt = new Date();
      const fixtures = buildFixtures(capturedAt);

      const events: ProviderOddsEvent[] = fixtures.map((fixture, i) => ({
        externalId: fixture.externalId,
        sportKey: 'soccer_mock_league',
        commenceTimeUtc: fixture.kickoffUtc,
        homeTeamName: TEAMS[i * 2] as string,
        awayTeamName: TEAMS[i * 2 + 1] as string,
        odds: buildOdds(fixture.externalId, capturedAt),
      }));

      return { capturedAt, events, quotaRemaining: null };
    },
  };
}

function buildOdds(eventExternalId: string, capturedAt: Date): ProviderOdds[] {
  const base = (suffix: string) => 1.4 + seededUnit(`${eventExternalId}-${suffix}`) * 3.6;
  const price = (suffix: string) => Number(base(suffix).toFixed(2));

  const common = {
    eventExternalId,
    bookmakerExternalId: 'mockbook',
    bookmakerName: 'Mock Bookmaker',
    handicap: 0,
    capturedAt,
  };

  return [
    { ...common, marketCode: MARKET.MATCH_RESULT, selectionCode: 'MS_1', parameters: { outcome: 'HOME' }, price: price('1') },
    { ...common, marketCode: MARKET.MATCH_RESULT, selectionCode: 'MS_X', parameters: { outcome: 'DRAW' }, price: price('X') },
    { ...common, marketCode: MARKET.MATCH_RESULT, selectionCode: 'MS_2', parameters: { outcome: 'AWAY' }, price: price('2') },
    {
      ...common,
      marketCode: MARKET.OVER_UNDER,
      selectionCode: overUnderCode('OVER', 2.5),
      parameters: { line: 2.5, side: 'OVER', subject: 'total' },
      price: price('o25'),
    },
    {
      ...common,
      marketCode: MARKET.OVER_UNDER,
      selectionCode: overUnderCode('UNDER', 2.5),
      parameters: { line: 2.5, side: 'UNDER', subject: 'total' },
      price: price('u25'),
    },
    { ...common, marketCode: MARKET.BTTS, selectionCode: 'BTTS_YES', parameters: { value: true }, price: price('bttsy') },
    { ...common, marketCode: MARKET.BTTS, selectionCode: 'BTTS_NO', parameters: { value: false }, price: price('bttsn') },
  ];
}
