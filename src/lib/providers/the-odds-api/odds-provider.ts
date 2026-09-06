import { HttpClient } from '../http';
import type { QuotaPolicy } from '../quota';
import { createLogger } from '@/lib/logging/logger';
import {
  HALF_TIME_CORRECT_SCORE_MAX,
  HALF_TIME_GOAL_LINES,
  MARKET,
  asianHandicapCode,
  halfTimeCorrectScoreCode,
  halfTimeOverUnderCode,
  overUnderCode,
} from '@/lib/markets/registry';
import type {
  OddsProvider,
  ProviderBulletin,
  ProviderOdds,
  ProviderOddsEvent,
} from '../types';

export const THE_ODDS_API = 'the-odds-api';

const log = createLogger('provider:the-odds-api');

interface RawOutcome {
  name: string;
  price: number;
  point?: number;
  description?: string;
}

interface RawMarket {
  key: string;
  last_update: string;
  outcomes: RawOutcome[];
}

interface RawBookmaker {
  key: string;
  title: string;
  last_update: string;
  markets: RawMarket[];
}

interface RawEvent {
  id: string;
  sport_key: string;
  sport_title: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: RawBookmaker[];
}

interface RawSport {
  key: string;
  group: string;
  title: string;
  description: string;
  active: boolean;
  has_outrights: boolean;
}

/**
 * Markets the Free plan actually returns. Requesting more silently costs extra
 * credits and returns nothing, so the default list stays honest (§40: never
 * fake a market the provider does not support).
 */
/**
 * Markets the competition-wide endpoint will actually serve.
 *
 * Measured, not assumed: `btts` and `double_chance` are valid market names but
 * answer 422 "Markets not supported by this endpoint" in bulk — and, usefully,
 * cost nothing to be refused. Anything beyond this list has to be bought per
 * event, at roughly twenty times the price per fixture.
 *
 * Bulk is the whole economic case for this provider. One call returned 22
 * events, all 22 priced, across 256 bookmaker blocks, for 2 credits. The same
 * fixtures per-event cost 44.
 */
export const DEFAULT_MARKETS = ['h2h', 'totals'] as const;
export const BULK_SUPPORTED_MARKETS = ['h2h', 'totals', 'spreads'] as const;
export const DEFAULT_REGIONS = ['eu'] as const;

/**
 * The half-time markets, and where they can be asked for.
 *
 * These are served only by the per-event endpoint — the competition-wide one
 * answers 422 "Markets not supported by this endpoint" and, usefully, charges
 * nothing for saying so. They are what the HAYAL signal is stated in.
 *
 * `btts_both_halves` is not in this list because the provider does not offer
 * it. The two halves are quoted separately and their product is not the same
 * bet: the halves are positively correlated, so multiplying them understates
 * the true chance and therefore overstates the price.
 */
export const HALF_TIME_MARKETS = [
  'correct_score_h1',
  'totals_h1',
  'btts_h1',
  'btts_h2',
] as const;

/**
 * The Odds API prices credits as `markets x regions` per call. Getting this
 * wrong exhausts a 500-credit month in a couple of days.
 */
export function creditCost(markets: readonly string[], regions: readonly string[]): number {
  return Math.max(1, markets.length * regions.length);
}

/**
 * Translates one provider outcome into our vocabulary.
 * Returns null for anything unrecognised — an unmapped price is dropped, never
 * guessed at.
 */
function normaliseOutcome(
  marketKey: string,
  outcome: RawOutcome,
  homeTeam: string,
  awayTeam: string,
): { marketCode: string; selectionCode: string; parameters: Record<string, unknown> | null; handicap: number } | null {
  const name = outcome.name.trim();

  switch (marketKey) {
    case 'h2h': {
      if (name === homeTeam) {
        return { marketCode: MARKET.MATCH_RESULT, selectionCode: 'MS_1', parameters: { outcome: 'HOME' }, handicap: 0 };
      }
      if (name === awayTeam) {
        return { marketCode: MARKET.MATCH_RESULT, selectionCode: 'MS_2', parameters: { outcome: 'AWAY' }, handicap: 0 };
      }
      if (name.toLowerCase() === 'draw') {
        return { marketCode: MARKET.MATCH_RESULT, selectionCode: 'MS_X', parameters: { outcome: 'DRAW' }, handicap: 0 };
      }
      return null;
    }

    case 'totals': {
      if (outcome.point === undefined) return null;
      const side = name.toLowerCase() === 'over' ? 'OVER' : name.toLowerCase() === 'under' ? 'UNDER' : null;
      if (!side) return null;
      return {
        marketCode: MARKET.OVER_UNDER,
        selectionCode: overUnderCode(side, outcome.point),
        parameters: { line: outcome.point, side, subject: 'total' },
        handicap: 0,
      };
    }

    case 'spreads': {
      if (outcome.point === undefined) return null;
      const side = name === homeTeam ? 'HOME' : name === awayTeam ? 'AWAY' : null;
      if (!side) return null;
      return {
        marketCode: MARKET.ASIAN_HANDICAP,
        selectionCode: asianHandicapCode(side, outcome.point),
        parameters: { side, handicap: outcome.point },
        handicap: outcome.point,
      };
    }

    case 'btts': {
      const yes = name.toLowerCase() === 'yes';
      const no = name.toLowerCase() === 'no';
      if (!yes && !no) return null;
      return {
        marketCode: MARKET.BTTS,
        selectionCode: yes ? 'BTTS_YES' : 'BTTS_NO',
        parameters: { value: yes },
        handicap: 0,
      };
    }

    /**
     * Half-time markets, served only by the per-event endpoint.
     *
     * These are what the HAYAL signal is stated in — the half-time score being
     * 2-2, and goals before the break. `btts_h1` and `btts_h2` are the two
     * halves priced separately; the combined "both halves" bet is not offered
     * here and is deliberately not synthesised from them.
     */
    case 'btts_h1':
    case 'btts_h2': {
      const yes = name.toLowerCase() === 'yes';
      const no = name.toLowerCase() === 'no';
      if (!yes && !no) return null;

      const firstHalf = marketKey === 'btts_h1';
      return {
        marketCode: firstHalf ? MARKET.BTTS_FIRST_HALF : MARKET.BTTS_SECOND_HALF,
        selectionCode: `${firstHalf ? 'BTTS_H1' : 'BTTS_H2'}_${yes ? 'YES' : 'NO'}`,
        parameters: { value: yes },
        handicap: 0,
      };
    }

    case 'correct_score_h1': {
      /**
       * The outcome is written as "Everton:2|Manchester United:2" — team names
       * rather than sides, so the home team has to be identified by name. A
       * name that does not match either side is dropped rather than assumed to
       * be the home one, because guessing here silently inverts the score.
       */
      const parts = name.split('|').map((part) => part.trim());
      if (parts.length !== 2) return null;

      const parsed = parts.map((part) => {
        const separator = part.lastIndexOf(':');
        if (separator < 0) return null;
        const team = part.slice(0, separator).trim();
        const goals = Number(part.slice(separator + 1).trim());
        return Number.isInteger(goals) ? { team, goals } : null;
      });
      if (parsed.some((entry) => entry === null)) return null;

      const entries = parsed as Array<{ team: string; goals: number }>;
      const home = entries.find((entry) => entry.team === homeTeam) ?? null;
      const away = entries.find((entry) => entry.team === awayTeam) ?? null;
      if (!home || !away) return null;

      // Outside the seeded grid there is no selection to hang the price on.
      if (home.goals > HALF_TIME_CORRECT_SCORE_MAX || away.goals > HALF_TIME_CORRECT_SCORE_MAX) {
        return null;
      }

      return {
        marketCode: MARKET.HALF_TIME_CORRECT_SCORE,
        selectionCode: halfTimeCorrectScoreCode(home.goals, away.goals),
        parameters: { home: home.goals, away: away.goals },
        handicap: 0,
      };
    }

    case 'totals_h1': {
      if (outcome.point === undefined) return null;
      const side = name.toLowerCase() === 'over' ? 'OVER' : name.toLowerCase() === 'under' ? 'UNDER' : null;
      if (!side) return null;

      // Asian half-time lines like 1.25 have no seeded selection; they are a
      // different bet from 1.5 and must not be rounded onto it.
      if (!HALF_TIME_GOAL_LINES.includes(outcome.point as (typeof HALF_TIME_GOAL_LINES)[number])) {
        return null;
      }

      return {
        marketCode: MARKET.HALF_TIME_OVER_UNDER,
        selectionCode: halfTimeOverUnderCode(side, outcome.point),
        parameters: { line: outcome.point, side },
        handicap: 0,
      };
    }

    case 'double_chance': {
      const parts = name.split('/').map((p) => p.trim());
      const codes = parts.map((p) => (p === homeTeam ? '1' : p === awayTeam ? '2' : p.toLowerCase() === 'draw' ? 'X' : null));
      if (codes.some((c) => c === null)) return null;
      const key = codes.join('');
      const mapping: Record<string, string> = {
        '1X': 'DOUBLE_CHANCE_1X',
        X1: 'DOUBLE_CHANCE_1X',
        X2: 'DOUBLE_CHANCE_X2',
        '2X': 'DOUBLE_CHANCE_X2',
        '12': 'DOUBLE_CHANCE_12',
        '21': 'DOUBLE_CHANCE_12',
      };
      const selectionCode = mapping[key];
      if (!selectionCode) return null;
      return { marketCode: MARKET.DOUBLE_CHANCE, selectionCode, parameters: null, handicap: 0 };
    }

    default:
      return null;
  }
}

function mapEvent(raw: RawEvent, capturedAt: Date): ProviderOddsEvent {
  const odds: ProviderOdds[] = [];

  for (const bookmaker of raw.bookmakers ?? []) {
    for (const market of bookmaker.markets ?? []) {
      for (const outcome of market.outcomes ?? []) {
        const normalised = normaliseOutcome(market.key, outcome, raw.home_team, raw.away_team);
        if (!normalised) continue;
        if (!Number.isFinite(outcome.price) || outcome.price <= 1) continue;

        odds.push({
          eventExternalId: raw.id,
          bookmakerExternalId: bookmaker.key,
          bookmakerName: bookmaker.title,
          marketCode: normalised.marketCode,
          selectionCode: normalised.selectionCode,
          parameters: normalised.parameters,
          price: outcome.price,
          handicap: normalised.handicap,
          // The bookmaker's own timestamp is more truthful than "now".
          capturedAt: market.last_update ? new Date(market.last_update) : capturedAt,
        });
      }
    }
  }

  return {
    externalId: raw.id,
    sportKey: raw.sport_key,
    commenceTimeUtc: new Date(raw.commence_time),
    homeTeamName: raw.home_team,
    awayTeamName: raw.away_team,
    odds,
  };
}

export function createTheOddsApiProvider(config: {
  apiKey: string;
  baseUrl: string;
  quota: QuotaPolicy;
  markets?: readonly string[];
  regions?: readonly string[];
}): OddsProvider {
  const markets = config.markets ?? DEFAULT_MARKETS;
  const regions = config.regions ?? DEFAULT_REGIONS;

  const http = new HttpClient({
    provider: THE_ODDS_API,
    baseUrl: config.baseUrl,
    timeoutMs: 20_000,
    maxRetries: 3,
    quota: config.quota,
  });

  return {
    name: THE_ODDS_API,

    async getSupportedCompetitions() {
      // /sports is not metered by the provider, so it costs us 0 credits.
      const raw = await http.get<RawSport[]>({
        path: '/sports',
        query: { apiKey: config.apiKey },
        cost: 0,
      });
      return raw
        .filter((s) => s.group === 'Soccer')
        .map((s) => ({ key: s.key, title: s.title, active: s.active }));
    },

    /**
     * Upcoming events for a competition, with no prices attached.
     *
     * The provider does not meter this endpoint, so enumerating a whole
     * weekend's fixtures across every competition costs nothing. That is what
     * makes reconciling our fixtures to their event ids affordable — and the
     * per-event market fetch impossible without.
     */
    async listEvents(competitionKey: string): Promise<ProviderOddsEvent[]> {
      const capturedAt = new Date();
      try {
        const raw = await http.get<RawEvent[]>({
          path: `/sports/${competitionKey}/events`,
          query: { apiKey: config.apiKey, dateFormat: 'iso' },
          cost: 0,
        });
        return raw.map((event) => mapEvent(event, capturedAt));
      } catch (error) {
        log.warn('event list failed, continuing', { competition: competitionKey, error: String(error) });
        return [];
      }
    },

    async getOdds(eventExternalId: string, competitionKey: string): Promise<ProviderOdds[]> {
      const capturedAt = new Date();
      const raw = await http.get<RawEvent>({
        path: `/sports/${competitionKey}/events/${eventExternalId}/odds`,
        query: {
          apiKey: config.apiKey,
          regions: regions.join(','),
          markets: markets.join(','),
          oddsFormat: 'decimal',
          dateFormat: 'iso',
        },
        cost: creditCost(markets, regions),
      });
      return mapEvent(raw, capturedAt).odds;
    },

    /**
     * One event's half-time markets.
     *
     * Costs `markets x regions` credits per event — four on the current list —
     * against a 500-credit month, so the caller decides which fixtures are
     * worth it rather than this looping over a slate.
     */
    async getEventMarkets(
      competitionKey: string,
      eventExternalId: string,
      requested: readonly string[] = HALF_TIME_MARKETS,
    ): Promise<ProviderOddsEvent | null> {
      const capturedAt = new Date();
      try {
        const raw = await http.get<RawEvent>({
          path: `/sports/${competitionKey}/events/${eventExternalId}/odds`,
          query: {
            apiKey: config.apiKey,
            regions: regions.join(','),
            markets: requested.join(','),
            oddsFormat: 'decimal',
            dateFormat: 'iso',
          },
          cost: creditCost(requested, regions),
          // The scarcer budget of the two; nothing here outranks settlement.
          respectReserve: true,
        });
        return mapEvent(raw, capturedAt);
      } catch (error) {
        log.warn('event market fetch failed', {
          competition: competitionKey,
          event: eventExternalId,
          error: String(error),
        });
        return null;
      }
    },

    async getBulletin(competitionKeys: string[]): Promise<ProviderBulletin> {
      const capturedAt = new Date();
      const events: ProviderOddsEvent[] = [];

      for (const key of competitionKeys) {
        try {
          const raw = await http.get<RawEvent[]>({
            path: `/sports/${key}/odds`,
            query: {
              apiKey: config.apiKey,
              regions: regions.join(','),
              markets: markets.join(','),
              oddsFormat: 'decimal',
              dateFormat: 'iso',
            },
            cost: creditCost(markets, regions),
            sportKey: key,
          });
          events.push(...raw.map((event) => mapEvent(event, capturedAt)));
        } catch (error) {
          // One dead competition must not empty the whole bulletin (§43).
          log.warn('competition fetch failed, continuing', { competition: key, error: String(error) });
        }
      }

      // The provider's own header is the authority on what is left.
      return { capturedAt, events, quotaRemaining: http.reportedQuotaRemaining };
    },
  };
}
