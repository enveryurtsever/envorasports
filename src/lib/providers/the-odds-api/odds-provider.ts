import { HttpClient } from '../http';
import type { QuotaPolicy } from '../quota';
import { createLogger } from '@/lib/logging/logger';
import {
  MARKET,
  asianHandicapCode,
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
export const DEFAULT_MARKETS = ['h2h', 'totals', 'spreads'] as const;
export const DEFAULT_REGIONS = ['eu'] as const;

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
