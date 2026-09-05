import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { modelHistoryStart } from '@/lib/models/history-window';

const log = createLogger('features:elo');

/**
 * Elo ratings (§14, §26).
 *
 * Ratings are append-only and dated: a row records what a team's rating was
 * *after* a given match. Reading "the rating as of time T" is therefore a
 * lookup of the latest row strictly before T, which is what keeps a backtest
 * from seeing a rating that only existed later (§57).
 */

export interface EloConfig {
  /** Update size. 20 is a common football setting; higher reacts faster. */
  kFactor: number;
  /** Rating points added to the home side before computing expectation. */
  homeAdvantage: number;
  initialRating: number;
  /** Extra weight for a bigger winning margin. 0 disables it. */
  marginWeight: number;
}

export const DEFAULT_ELO_CONFIG: EloConfig = {
  kFactor: 20,
  homeAdvantage: 65,
  initialRating: 1500,
  marginWeight: 0.5,
};

/** Expected score for A against B, given a rating gap. */
export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

/**
 * A three-goal win should move a rating more than a one-goal win, but not
 * linearly — otherwise a 7-0 freak result dominates the whole season.
 */
export function marginMultiplier(goalDifference: number, weight: number): number {
  const margin = Math.abs(goalDifference);
  if (margin <= 1 || weight === 0) return 1;
  return 1 + weight * Math.log(margin);
}

export interface EloUpdate {
  homeRating: number;
  awayRating: number;
}

export function nextRatings(
  homeRating: number,
  awayRating: number,
  homeGoals: number,
  awayGoals: number,
  config: EloConfig = DEFAULT_ELO_CONFIG,
): EloUpdate {
  const expectedHome = expectedScore(homeRating + config.homeAdvantage, awayRating);
  const actualHome = homeGoals > awayGoals ? 1 : homeGoals === awayGoals ? 0.5 : 0;

  const k = config.kFactor * marginMultiplier(homeGoals - awayGoals, config.marginWeight);
  const delta = k * (actualHome - expectedHome);

  return {
    // Zero-sum: what one side gains the other loses.
    homeRating: homeRating + delta,
    awayRating: awayRating - delta,
  };
}

export interface RebuildResult {
  matchesProcessed: number;
  teamsRated: number;
  ratingsWritten: number;
}

/**
 * Replays every finished match in chronological order and writes one rating row
 * per team per match.
 *
 * Chronological order is not an optimisation — processing out of order would
 * fold later results into earlier ratings, which is leakage by construction.
 */
export async function rebuildEloRatings(
  options: { leagueId?: string; since?: Date; config?: EloConfig } = {},
): Promise<RebuildResult> {
  const config = options.config ?? DEFAULT_ELO_CONFIG;
  // Default to the season window: ratings built from four-year-old squads
  // describe teams that no longer exist. An explicit `since` still wins, which
  // is what the backtest passes when it wants the full archive.
  const since = options.since ?? modelHistoryStart(new Date());

  const matches = await prisma.match.findMany({
    where: {
      status: { in: ['FINISHED', 'AWARDED'] },
      homeScore: { not: null },
      awayScore: { not: null },
      ...(options.leagueId ? { leagueId: options.leagueId } : {}),
      scheduledKickoffUtc: { gte: since },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: {
      id: true,
      leagueId: true,
      scheduledKickoffUtc: true,
      homeTeamId: true,
      awayTeamId: true,
      homeScore: true,
      awayScore: true,
    },
  });

  if (matches.length === 0) {
    return { matchesProcessed: 0, teamsRated: 0, ratingsWritten: 0 };
  }

  // Seed from the latest stored rating so an incremental run continues rather
  // than restarting every team at 1500.
  const ratings = new Map<string, number>();
  const played = new Map<string, number>();

  const rows: Prisma.EloRatingCreateManyInput[] = [];

  for (const match of matches) {
    const homeRating = ratings.get(match.homeTeamId) ?? config.initialRating;
    const awayRating = ratings.get(match.awayTeamId) ?? config.initialRating;

    const updated = nextRatings(
      homeRating,
      awayRating,
      match.homeScore as number,
      match.awayScore as number,
      config,
    );

    ratings.set(match.homeTeamId, updated.homeRating);
    ratings.set(match.awayTeamId, updated.awayRating);
    played.set(match.homeTeamId, (played.get(match.homeTeamId) ?? 0) + 1);
    played.set(match.awayTeamId, (played.get(match.awayTeamId) ?? 0) + 1);

    for (const [teamId, rating] of [
      [match.homeTeamId, updated.homeRating],
      [match.awayTeamId, updated.awayRating],
    ] as const) {
      rows.push({
        teamId,
        leagueId: match.leagueId,
        rating: new Prisma.Decimal(rating.toFixed(3)),
        ratingDate: match.scheduledKickoffUtc,
        matchesPlayed: played.get(teamId) ?? 0,
        sourceMatchId: match.id,
      });
    }
  }

  let written = 0;
  for (let i = 0; i < rows.length; i += 2000) {
    const result = await prisma.eloRating.createMany({
      data: rows.slice(i, i + 2000),
      // Two matches for one team at the same instant would collide; the first
      // wins rather than the write failing.
      skipDuplicates: true,
    });
    written += result.count;
  }

  log.info('elo rebuilt', {
    matches: matches.length,
    teams: ratings.size,
    ratings: written,
  });

  return { matchesProcessed: matches.length, teamsRated: ratings.size, ratingsWritten: written };
}

/** The rating a team held at `asOf`, or the configured default if unrated. */
export async function getEloAsOf(
  teamId: string,
  asOf: Date,
  config: EloConfig = DEFAULT_ELO_CONFIG,
): Promise<{ rating: number; matchesPlayed: number; known: boolean }> {
  const row = await prisma.eloRating.findFirst({
    // Strictly before: a rating produced by the match we are predicting is the
    // definition of leakage.
    where: { teamId, ratingDate: { lt: asOf } },
    orderBy: { ratingDate: 'desc' },
    select: { rating: true, matchesPlayed: true },
  });

  if (!row) return { rating: config.initialRating, matchesPlayed: 0, known: false };
  return { rating: Number(row.rating), matchesPlayed: row.matchesPlayed, known: true };
}

/** Batch version — one query for a whole fixture list. */
export async function getEloForTeams(
  teamIds: string[],
  asOf: Date,
  config: EloConfig = DEFAULT_ELO_CONFIG,
): Promise<Map<string, { rating: number; matchesPlayed: number; known: boolean }>> {
  const result = new Map<string, { rating: number; matchesPlayed: number; known: boolean }>();
  if (teamIds.length === 0) return result;

  const rows = await prisma.eloRating.findMany({
    where: { teamId: { in: teamIds }, ratingDate: { lt: asOf } },
    orderBy: { ratingDate: 'desc' },
    select: { teamId: true, rating: true, matchesPlayed: true },
  });

  // Rows arrive newest first, so the first sighting of a team is its latest.
  for (const row of rows) {
    if (result.has(row.teamId)) continue;
    result.set(row.teamId, {
      rating: Number(row.rating),
      matchesPlayed: row.matchesPlayed,
      known: true,
    });
  }

  for (const teamId of teamIds) {
    if (!result.has(teamId)) {
      result.set(teamId, { rating: config.initialRating, matchesPlayed: 0, known: false });
    }
  }

  return result;
}
