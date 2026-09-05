import { HttpClient } from '../http';
import type { QuotaPolicy } from '../quota';
import { createLogger } from '@/lib/logging/logger';
import {
  ASIAN_HANDICAP_LINES,
  GOAL_LINES,
  MARKET,
  asianHandicapCode,
  goalsPlusCode,
  htftCode,
  overUnderCode,
} from '@/lib/markets/registry';
import type { OddsProvider, ProviderBulletin, ProviderOdds, ProviderOddsEvent } from '../types';

export const API_FOOTBALL_ODDS = 'api-football';

const log = createLogger('provider:api-football:odds');

/**
 * API-Football as an odds source.
 *
 * The Odds API's free plan serves three markets — h2h, totals and spreads —
 * which is why coupons could only ever offer MS and the 2.5/3.5 goal lines.
 * API-Football prices the rest of a Turkish bulletin on the same free plan:
 * first-half result (İY), both teams to score (KG), double chance and the whole
 * goal ladder up to 6+.
 *
 * It is also the football provider, so a fixture id here *is* our
 * `matches.external_id`. No name-and-kickoff reconciliation is needed, which is
 * the fragile part of the other adapter.
 *
 * Cost: one request per fixture. Fetching a whole day in bulk is offered by the
 * provider but paginates ten fixtures at a time — 67 pages for a Saturday —
 * against a 100/day allowance, so per-fixture for the bulletin window is both
 * cheaper and more predictable.
 */

interface RawValue {
  /** Not always a string: "Exact Goals Number" reports 0, 1, 2 as numbers. */
  value: string | number;
  odd: string | number;
}

interface RawBet {
  id: number;
  name: string;
  values: RawValue[];
}

interface RawBookmaker {
  id: number;
  name: string;
  bets: RawBet[];
}

interface RawOddsEntry {
  fixture: { id: number; date: string };
  update?: string;
  bookmakers: RawBookmaker[];
}

/** API-Football bet ids we understand. Everything else is dropped, not guessed. */
const BET = {
  MATCH_WINNER: 1,
  GOALS_OVER_UNDER: 5,
  BOTH_TEAMS_SCORE: 8,
  DOUBLE_CHANCE: 12,
  FIRST_HALF_WINNER: 13,
  ASIAN_HANDICAP: 4,
  HALF_TIME_FULL_TIME: 7,
} as const;

/** "Home"/"Draw"/"Away" as the registry's 1 / X / 2. */
const OUTCOME_CODE: Record<string, '1' | 'X' | '2'> = {
  home: '1',
  draw: 'X',
  away: '2',
};

/**
 * Lines carried as OVER_UNDER. 5.5 and above are deliberately absent: "Over 5.5"
 * and "6+ goals" are the same event, and giving one event two codes would let a
 * coupon count it twice. The high lines are mapped to the 6+/7+ codes below,
 * which is the form a Turkish bulletin actually prints.
 */
const OVER_UNDER_LINES = GOAL_LINES.filter((line) => line < 5);

/** "Over 5.5" is exactly "6 or more goals" — an identity, not an approximation. */
const GOALS_PLUS_FROM_LINE: Record<string, number> = { '5.5': 6, '6.5': 7 };

type Mapped = {
  marketCode: string;
  selectionCode: string;
  parameters: Record<string, unknown> | null;
  handicap: number;
};

function parseLine(value: string): { side: 'OVER' | 'UNDER'; line: number } | null {
  const match = /^(over|under)\s+([\d.]+)$/i.exec(value.trim());
  if (!match) return null;

  const line = Number(match[2]);
  if (!Number.isFinite(line)) return null;

  return { side: match[1]!.toLowerCase() === 'over' ? 'OVER' : 'UNDER', line };
}

/** One provider value in our vocabulary, or null when we do not model it. */
export function mapBetValue(betId: number, value: string | number): Mapped | null {
  const raw = String(value).trim();

  switch (betId) {
    case BET.MATCH_WINNER:
    case BET.FIRST_HALF_WINNER: {
      const half = betId === BET.FIRST_HALF_WINNER;
      const marketCode = half ? MARKET.HALF_TIME_RESULT : MARKET.MATCH_RESULT;
      const prefix = half ? 'HT' : 'MS';

      const outcome =
        raw.toLowerCase() === 'home'
          ? { code: `${prefix}_1`, outcome: 'HOME' }
          : raw.toLowerCase() === 'draw'
            ? { code: `${prefix}_X`, outcome: 'DRAW' }
            : raw.toLowerCase() === 'away'
              ? { code: `${prefix}_2`, outcome: 'AWAY' }
              : null;

      if (!outcome) return null;
      return {
        marketCode,
        selectionCode: outcome.code,
        parameters: { outcome: outcome.outcome },
        handicap: 0,
      };
    }

    case BET.GOALS_OVER_UNDER: {
      const parsed = parseLine(raw);
      if (!parsed) return null;

      // High lines become the 6+/7+ codes, but only on the Over side: "Under
      // 5.5" is a normal under and has no threshold equivalent.
      const threshold = GOALS_PLUS_FROM_LINE[String(parsed.line)];
      if (threshold !== undefined) {
        if (parsed.side !== 'OVER') return null;
        return {
          marketCode: MARKET.TOTAL_GOALS_THRESHOLD,
          selectionCode: goalsPlusCode(threshold),
          parameters: { goals: threshold },
          handicap: 0,
        };
      }

      if (!OVER_UNDER_LINES.includes(parsed.line as (typeof GOAL_LINES)[number])) return null;
      return {
        marketCode: MARKET.OVER_UNDER,
        selectionCode: overUnderCode(parsed.side, parsed.line),
        parameters: { line: parsed.line, side: parsed.side, subject: 'total' },
        handicap: 0,
      };
    }

    case BET.HALF_TIME_FULL_TIME: {
      // "Home/Draw" is leading at the break and drawing at the end. Both halves
      // of the pair are needed, so an unrecognised side drops the whole value
      // rather than guessing at the other.
      const [firstHalf, fullTime] = raw.toLowerCase().split('/').map((part) => part.trim());
      const half = firstHalf ? OUTCOME_CODE[firstHalf] : undefined;
      const full = fullTime ? OUTCOME_CODE[fullTime] : undefined;
      if (!half || !full) return null;

      return {
        marketCode: MARKET.HALF_TIME_FULL_TIME,
        selectionCode: htftCode(half, full),
        parameters: { half, full },
        handicap: 0,
      };
    }

    case BET.BOTH_TEAMS_SCORE: {
      const yes = raw.toLowerCase() === 'yes';
      const no = raw.toLowerCase() === 'no';
      if (!yes && !no) return null;
      return {
        marketCode: MARKET.BTTS,
        selectionCode: yes ? 'BTTS_YES' : 'BTTS_NO',
        parameters: { value: yes },
        handicap: 0,
      };
    }

    case BET.DOUBLE_CHANCE: {
      const mapping: Record<string, string> = {
        'home/draw': 'DOUBLE_CHANCE_1X',
        'draw/home': 'DOUBLE_CHANCE_1X',
        'draw/away': 'DOUBLE_CHANCE_X2',
        'away/draw': 'DOUBLE_CHANCE_X2',
        'home/away': 'DOUBLE_CHANCE_12',
        'away/home': 'DOUBLE_CHANCE_12',
      };
      const selectionCode = mapping[raw.toLowerCase()];
      if (!selectionCode) return null;
      return { marketCode: MARKET.DOUBLE_CHANCE, selectionCode, parameters: null, handicap: 0 };
    }

    case BET.ASIAN_HANDICAP: {
      const match = /^(home|away)\s+([+-]?[\d.]+)$/i.exec(raw);
      if (!match) return null;

      const side = match[1]!.toLowerCase() === 'home' ? 'HOME' : 'AWAY';
      const line = Number(match[2]);
      if (!Number.isFinite(line)) return null;

      /**
       * The line is quoted from the home team's perspective and the same number
       * is repeated on the away row: "Away -1.5" is the away side of a line
       * where the home team gives 1.5, so the away team *receives* +1.5.
       *
       * Taking the sign literally stored every away handicap inverted, and the
       * damage was not visible as a bad price — it was visible as a huge edge,
       * because an ~80% model probability got paired with the price of the
       * other side. (The Odds API differs: its `point` is already side-specific,
       * so that adapter must not do this.)
       */
      const handicap = side === 'HOME' ? line : -line;

      // Only lines the model actually prices; quarter-goal lines are not
      // modelled, so a price for one would have nothing to compare against.
      if (!ASIAN_HANDICAP_LINES.includes(handicap as (typeof ASIAN_HANDICAP_LINES)[number])) {
        return null;
      }

      return {
        marketCode: MARKET.ASIAN_HANDICAP,
        selectionCode: asianHandicapCode(side, handicap),
        parameters: { side, handicap },
        handicap,
      };
    }

    default:
      return null;
  }
}

function mapEntry(raw: RawOddsEntry, capturedAt: Date): ProviderOddsEvent {
  const odds: ProviderOdds[] = [];
  const externalId = String(raw.fixture.id);
  // The provider stamps its own update time; prefer it over "now".
  const updatedAt = raw.update ? new Date(raw.update) : capturedAt;

  for (const bookmaker of raw.bookmakers ?? []) {
    for (const bet of bookmaker.bets ?? []) {
      for (const value of bet.values ?? []) {
        const mapped = mapBetValue(bet.id, value.value);
        if (!mapped) continue;

        const price = Number(value.odd);
        if (!Number.isFinite(price) || price <= 1) continue;

        odds.push({
          eventExternalId: externalId,
          bookmakerExternalId: String(bookmaker.id),
          bookmakerName: bookmaker.name,
          marketCode: mapped.marketCode,
          selectionCode: mapped.selectionCode,
          parameters: mapped.parameters,
          price,
          handicap: mapped.handicap,
          capturedAt: Number.isNaN(updatedAt.getTime()) ? capturedAt : updatedAt,
        });
      }
    }
  }

  return {
    externalId,
    sportKey: 'football',
    commenceTimeUtc: new Date(raw.fixture.date),
    // The fixture id already identifies the match, so no names are needed for
    // reconciliation. They are left blank rather than filled with guesses.
    homeTeamName: '',
    awayTeamName: '',
    odds,
  };
}

interface ApiFootballEnvelope<T> {
  response: T;
  errors?: unknown;
  paging?: { current: number; total: number };
}

export function createApiFootballOddsProvider(config: {
  apiKey: string;
  baseUrl: string;
  quota: QuotaPolicy;
  /** Restrict to one bookmaker; fewer, more consistent prices per request. */
  bookmakerId?: number;
}): OddsProvider {
  const http = new HttpClient({
    provider: API_FOOTBALL_ODDS,
    baseUrl: config.baseUrl,
    timeoutMs: 20_000,
    maxRetries: 3,
    quota: config.quota,
    headers: { 'x-apisports-key': config.apiKey },
    // Free plan: ten a minute, shared with the fixture client's allowance.
    requestsPerMinute: 10,
  });

  async function fetchFixture(fixtureId: string, capturedAt: Date): Promise<ProviderOddsEvent | null> {
    const query: Record<string, string> = { fixture: fixtureId };
    if (config.bookmakerId !== undefined) query.bookmaker = String(config.bookmakerId);

    const envelope = await http.get<ApiFootballEnvelope<RawOddsEntry[]>>({
      path: '/odds',
      query,
      cost: 1,
    });

    const entry = envelope.response?.[0];
    return entry ? mapEntry(entry, capturedAt) : null;
  }

  return {
    name: API_FOOTBALL_ODDS,

    async getSupportedCompetitions() {
      // Odds are addressed by fixture here, so there is no competition key to
      // enumerate. The bulletin sync drives the fixture list instead.
      return [];
    },

    async getOdds(eventExternalId: string): Promise<ProviderOdds[]> {
      const event = await fetchFixture(eventExternalId, new Date());
      return event?.odds ?? [];
    },

    /**
     * Here `competitionKeys` carries fixture external ids — this provider is
     * addressed per fixture, and the caller decides which fixtures are worth
     * spending the daily allowance on.
     */
    async getBulletin(fixtureExternalIds: string[]): Promise<ProviderBulletin> {
      const capturedAt = new Date();
      const events: ProviderOddsEvent[] = [];

      for (const fixtureId of fixtureExternalIds) {
        try {
          const event = await fetchFixture(fixtureId, capturedAt);
          if (event) events.push(event);
        } catch (error) {
          // One unpriced fixture must not empty the bulletin (§43).
          log.warn('fixture odds fetch failed, continuing', {
            fixture: fixtureId,
            error: String(error),
          });
        }
      }

      return { capturedAt, events, quotaRemaining: http.reportedQuotaRemaining };
    },
  };
}
