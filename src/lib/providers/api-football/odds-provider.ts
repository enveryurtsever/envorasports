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
import { interpretApiFootballBody } from './envelope';

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
 * Cost: a day's odds paginate ten fixtures to a request, so a Sunday's 550
 * fixtures cost 55 requests rather than 550. Per-fixture is only cheaper when
 * a handful are wanted; for a whole bulletin it is ten times the price, which
 * is what kept the coupon pool at eleven usable matches on a day with hundreds.
 * Both shapes are offered and the caller picks by how many it needs.
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

/**
 * "Over 5.5" is exactly "6 or more goals" — an identity, not an approximation.
 *
 * "Over 6.5" would be 7+, which a Turkish bulletin does not carry, so it is
 * dropped rather than folded into 6+: the two are different events, and giving
 * them one code would store two prices for the same selection.
 */
const GOALS_PLUS_FROM_LINE: Record<string, number> = { '5.5': 6 };

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

/** True when the call failed because the day's allowance is gone. */
function isBudgetFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'QuotaExceededError' ||
    /budget exhausted|request limit for the day|upgrade your plan/i.test(error.message)
  );
}

export function createApiFootballOddsProvider(config: {
  apiKey: string;
  baseUrl: string;
  quota: QuotaPolicy;
  /**
   * Restrict to one bookmaker, or 0 for all of them.
   *
   * All of them costs the same single request and returns six books instead of
   * one, which is a better market price to calibrate against: removing the
   * overround from a consensus is more honest than removing it from whichever
   * book happened to be picked.
   */
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
    /**
     * The omission that cost the budget.
     *
     * This adapter built its own client and never read the envelope, so an
     * exhausted account produced fifty 200s an hour that looked like fixtures
     * simply having no prices. They were recorded as successes, the guard saw
     * a healthy header, and nothing ever stopped.
     */
    interpretBody: interpretApiFootballBody,
  });

  async function fetchFixture(
    fixtureId: string,
    capturedAt: Date,
    options: { allowProbe?: boolean } = {},
  ): Promise<ProviderOddsEvent | null> {
    const query: Record<string, string> = { fixture: fixtureId };
    if (config.bookmakerId) query.bookmaker = String(config.bookmakerId);

    const envelope = await http.get<ApiFootballEnvelope<RawOddsEntry[]>>({
      path: '/odds',
      query,
      cost: 1,
      /**
       * Odds are the lower priority of the two things this budget buys.
       *
       * A stale price makes a coupon less sharp; a missed result leaves it
       * unsettled. So pricing stops at the reserve and settlement keeps its
       * share, instead of the two racing for the same hundred requests.
       */
      respectReserve: true,
      allowProbe: options.allowProbe,
    });

    const entry = envelope.response?.[0];
    return entry ? mapEntry(entry, capturedAt) : null;
  }

  /**
   * Every priced fixture on one date, paged.
   *
   * `maxRequests` bounds the spend: the provider reports the page count on the
   * first response, so the caller learns the real cost after one request and
   * the rest stop at the budget rather than draining the day.
   */
  async function fetchDate(
    date: string,
    capturedAt: Date,
    maxRequests: number,
  ): Promise<{ events: ProviderOddsEvent[]; requestsUsed: number }> {
    const events: ProviderOddsEvent[] = [];
    let requestsUsed = 0;
    let page = 1;
    let totalPages = 1;

    while (page <= totalPages && requestsUsed < maxRequests) {
      const query: Record<string, string> = { date, page: String(page) };
      if (config.bookmakerId !== undefined) query.bookmaker = String(config.bookmakerId);

      const envelope = await http.get<ApiFootballEnvelope<RawOddsEntry[]>>({
        path: '/odds',
        query,
        cost: 1,
      });
      requestsUsed++;

      totalPages = envelope.paging?.total ?? 1;
      for (const entry of envelope.response ?? []) events.push(mapEntry(entry, capturedAt));
      page++;
    }

    return { events, requestsUsed };
  }

  return {
    name: API_FOOTBALL_ODDS,

    /**
     * One league's fixtures on one date.
     *
     * Cheaper again than asking for the whole date: a Sunday is 55 pages of ten
     * across every competition on earth, while a single league's four fixtures
     * are one page. Fourteen league-days cover a bulletin for about as many
     * requests as twenty fixtures cost individually.
     */
    async getBulletinByLeagueDate(
      leagueId: string,
      season: string,
      date: string,
      maxRequests: number,
    ): Promise<ProviderBulletin> {
      const capturedAt = new Date();
      const events: ProviderOddsEvent[] = [];
      let page = 1;
      let totalPages = 1;
      let used = 0;

      try {
        while (page <= totalPages && used < maxRequests) {
          const query: Record<string, string> = {
            league: leagueId,
            season,
            date,
            page: String(page),
          };
          if (config.bookmakerId) query.bookmaker = String(config.bookmakerId);

          const envelope = await http.get<ApiFootballEnvelope<RawOddsEntry[]>>({
            path: '/odds',
            query,
            cost: 1,
          });
          used++;
          totalPages = envelope.paging?.total ?? 1;
          for (const entry of envelope.response ?? []) events.push(mapEntry(entry, capturedAt));
          page++;
        }
      } catch (error) {
        log.warn('league odds fetch failed', { leagueId, date, error: String(error) });
      }

      return { capturedAt, events, quotaRemaining: http.reportedQuotaRemaining };
    },

    /** A whole date in pages of ten, for when most of a bulletin is wanted. */
    async getBulletinByDate(date: string, maxRequests: number): Promise<ProviderBulletin> {
      const capturedAt = new Date();
      try {
        const { events } = await fetchDate(date, capturedAt, maxRequests);
        return { capturedAt, events, quotaRemaining: http.reportedQuotaRemaining };
      } catch (error) {
        log.warn('date odds fetch failed', { date, error: String(error) });
        return { capturedAt, events: [], quotaRemaining: http.reportedQuotaRemaining };
      }
    },

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

      for (const [index, fixtureId] of fixtureExternalIds.entries()) {
        try {
          // Only the first call may probe a held budget; if the provider is
          // still spent it says so and the loop stops immediately below.
          const event = await fetchFixture(fixtureId, capturedAt, { allowProbe: index === 0 });
          if (event) events.push(event);
        } catch (error) {
          /**
           * A budget failure ends the run; anything else skips one fixture.
           *
           * Carrying on through an exhausted budget is what turned one refusal
           * into fifty identical ones per run — each logged, each pointless.
           * The first fixture's answer is the answer for all of them.
           */
          if (isBudgetFailure(error)) {
            log.warn('stopping bulletin: provider budget is spent', {
              priced: events.length,
              remaining: fixtureExternalIds.length - index,
            });
            break;
          }

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
