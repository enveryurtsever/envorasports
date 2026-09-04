/**
 * Provider-agnostic contracts (§39).
 *
 * Nothing above this layer knows that API-Football exists. Swapping providers
 * means writing a new adapter that satisfies these interfaces — no changes to
 * ingestion, features, models, coupons or UI.
 */

export type ProviderName = string;

export interface ProviderRef {
  /** The provider's own id, kept for idempotent upserts. */
  externalId: string;
  source: ProviderName;
}

export interface ProviderLeague extends ProviderRef {
  name: string;
  country: string | null;
  countryCode: string | null;
  type: string | null;
  logo: string | null;
}

export interface ProviderSeason extends ProviderRef {
  leagueExternalId: string;
  name: string;
  startDate: Date | null;
  endDate: Date | null;
  current: boolean;
}

export interface ProviderTeam extends ProviderRef {
  name: string;
  shortName: string | null;
  country: string | null;
  logo: string | null;
  founded: number | null;
  venue: string | null;
}

export type ProviderMatchStatus =
  | 'SCHEDULED'
  | 'LIVE'
  | 'HALF_TIME'
  | 'FINISHED'
  | 'POSTPONED'
  | 'CANCELED'
  | 'SUSPENDED'
  | 'ABANDONED'
  | 'AWARDED';

export interface ProviderFixture extends ProviderRef {
  leagueExternalId: string;
  seasonExternalId: string;
  homeTeamExternalId: string;
  awayTeamExternalId: string;
  /** Carried so the team resolver has something to match on across sources. */
  homeTeamName: string;
  awayTeamName: string;
  homeTeamLogo: string | null;
  awayTeamLogo: string | null;
  /** Always UTC. Local kickoff times are a display concern only (§31). */
  kickoffUtc: Date;
  venueTimezone: string | null;
  status: ProviderMatchStatus;
  /** Raw provider status string, preserved for audit. */
  rawStatus: string | null;
  round: string | null;
  venue: string | null;
  referee: string | null;
  homeScore: number | null;
  awayScore: number | null;
  halfTimeHomeScore: number | null;
  halfTimeAwayScore: number | null;
  /** Provider's own last-modified marker, when it exposes one. */
  providerUpdatedAt: Date | null;
}

export interface ProviderTeamMatchStatistics {
  teamExternalId: string;
  possession: number | null;
  shots: number | null;
  shotsOnTarget: number | null;
  shotsOffTarget: number | null;
  blockedShots: number | null;
  corners: number | null;
  fouls: number | null;
  offsides: number | null;
  yellowCards: number | null;
  redCards: number | null;
  saves: number | null;
  passes: number | null;
  passAccuracy: number | null;
  expectedGoals: number | null;
  expectedGoalsAgainst: number | null;
  extra: Record<string, unknown> | null;
}

export interface ProviderMatchStatistics {
  matchExternalId: string;
  teams: ProviderTeamMatchStatistics[];
}

export interface ProviderPlayer extends ProviderRef {
  teamExternalId: string | null;
  name: string;
  position: string | null;
  nationality: string | null;
  birthDate: Date | null;
}

export interface ProviderInjury {
  playerExternalId: string;
  playerName: string;
  teamExternalId: string;
  status: 'OUT' | 'DOUBTFUL' | 'SUSPENDED' | 'AVAILABLE';
  reason: string | null;
  /** When the provider published this. Required for leakage-safe backtests. */
  publishedAt: Date;
}

export interface ProviderLineupPlayer {
  playerExternalId: string;
  playerName: string;
  starter: boolean;
  position: string | null;
  shirtNumber: number | null;
}

export interface ProviderLineup {
  matchExternalId: string;
  teamExternalId: string;
  type: 'CONFIRMED' | 'PREDICTED';
  formation: string | null;
  players: ProviderLineupPlayer[];
  publishedAt: Date;
}

// ---------------------------------------------------------------------------
// Odds / bulletin
// ---------------------------------------------------------------------------

export interface ProviderBookmaker extends ProviderRef {
  name: string;
}

/**
 * One price. `marketCode` / `selectionCode` are already normalised to
 * EnvoraSports' internal vocabulary by the adapter — the rest of the system
 * never sees a provider's market naming.
 */
export interface ProviderOdds {
  /** The odds provider's own event id — NOT the football provider's fixture id. */
  eventExternalId: string;
  bookmakerExternalId: string;
  bookmakerName: string;
  marketCode: string;
  selectionCode: string;
  /** Extra market parameters, e.g. { line: 2.5 } or { goals: 6 }. */
  parameters: Record<string, unknown> | null;
  price: number;
  handicap: number;
  capturedAt: Date;
}

/**
 * A priced event as the odds provider sees it.
 *
 * The odds provider and the football provider are different companies with
 * different ids, so the ingestion layer has to reconcile them. Team names and
 * kickoff time are carried here precisely so that resolver has something to
 * match on.
 */
export interface ProviderOddsEvent {
  externalId: string;
  sportKey: string;
  commenceTimeUtc: Date;
  homeTeamName: string;
  awayTeamName: string;
  odds: ProviderOdds[];
}

/**
 * The bulletin: which matches and which markets are actually priced right now.
 * A market missing from here is not eligible for a coupon (§41).
 */
export interface ProviderBulletin {
  capturedAt: Date;
  events: ProviderOddsEvent[];
  /** Credits the provider says are left, when it reports them. */
  quotaRemaining: number | null;
}

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface FootballDataProvider {
  readonly name: ProviderName;

  getLeagues(): Promise<ProviderLeague[]>;
  getSeasons(leagueExternalId: string): Promise<ProviderSeason[]>;
  getTeams(leagueExternalId: string, seasonExternalId: string): Promise<ProviderTeam[]>;

  /** Fixtures for a single UTC calendar day. */
  getFixturesByDate(date: Date): Promise<ProviderFixture[]>;
  /** Refreshed status/score for specific fixtures — the result-sync path. */
  getFixturesByIds(matchExternalIds: string[]): Promise<ProviderFixture[]>;
  getFixturesBySeason(leagueExternalId: string, seasonExternalId: string): Promise<ProviderFixture[]>;

  getMatchStatistics(matchExternalId: string): Promise<ProviderMatchStatistics | null>;
  getHeadToHead(homeTeamExternalId: string, awayTeamExternalId: string): Promise<ProviderFixture[]>;
  getLineups(matchExternalId: string): Promise<ProviderLineup[]>;
  getInjuries(matchExternalId: string): Promise<ProviderInjury[]>;
}

export interface OddsProvider {
  readonly name: ProviderName;

  /** Competitions the provider prices, in its own key space. */
  getSupportedCompetitions(): Promise<Array<{ key: string; title: string; active: boolean }>>;
  /** Every priced market for one event. */
  getOdds(eventExternalId: string, competitionKey: string): Promise<ProviderOdds[]>;
  /**
   * The whole bulletin for a set of competitions. Bulk is the only affordable
   * shape on a metered plan — one call per competition, not one per match.
   */
  getBulletin(competitionKeys: string[]): Promise<ProviderBulletin>;
}

/** Thrown when a provider cannot answer; never crashes the pipeline (§43). */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly options: {
      provider: string;
      endpoint: string;
      statusCode?: number;
      retryable: boolean;
      cause?: unknown;
    },
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export class QuotaExceededError extends ProviderError {
  constructor(provider: string, used: number, budget: number) {
    super(`Daily request budget exhausted for ${provider}: ${used}/${budget}`, {
      provider,
      endpoint: '-',
      retryable: false,
    });
    this.name = 'QuotaExceededError';
  }
}
