import { prisma } from '@/lib/db/prisma';

/**
 * League tables computed from stored results.
 *
 * Nothing is fetched for this — it is derived from the matches already
 * ingested, so it costs no provider quota and cannot disagree with the results
 * the settlement engine used.
 */

export interface StandingRow {
  position: number;
  teamId: string;
  teamName: string;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDifference: number;
  points: number;
  /** Most recent results first: 'W' | 'D' | 'L'. */
  form: Array<'W' | 'D' | 'L'>;
}

export interface LeagueStandings {
  leagueId: string;
  leagueName: string;
  country: string | null;
  seasonName: string | null;
  rows: StandingRow[];
  matchesPlayed: number;
}

const FORM_LENGTH = 5;

/**
 * League tables only change when a result lands, but computing one reads a
 * season of matches. Recomputing six of them on every front-page request cost
 * more than the rest of the page put together, so they are held briefly in
 * process. A stale table for a minute is invisible; a slow front page is not.
 */
const STANDINGS_TTL_MS = 60_000;
const standingsCache = new Map<string, { at: number; value: LeagueStandings | null }>();

function cached(leagueId: string): LeagueStandings | null | undefined {
  const entry = standingsCache.get(leagueId);
  if (!entry) return undefined;
  if (Date.now() - entry.at > STANDINGS_TTL_MS) {
    standingsCache.delete(leagueId);
    return undefined;
  }
  return entry.value;
}

/** Drops the cache so a settlement run is reflected immediately. */
export function invalidateStandingsCache(): void {
  standingsCache.clear();
}

/**
 * Three points for a win. Real competitions add deductions and tie-break rules
 * we do not model, so this is a computed table, not an official one.
 */
export async function getLeagueStandings(leagueId: string): Promise<LeagueStandings | null> {
  const hit = cached(leagueId);
  if (hit !== undefined) return hit;

  const value = await computeLeagueStandings(leagueId);
  standingsCache.set(leagueId, { at: Date.now(), value });
  return value;
}

async function computeLeagueStandings(leagueId: string): Promise<LeagueStandings | null> {
  const league = await prisma.league.findUnique({
    where: { id: leagueId },
    select: { id: true, name: true, country: true },
  });
  if (!league) return null;

  // The most recent season that actually has finished matches.
  const latest = await prisma.match.findFirst({
    where: { leagueId, status: { in: ['FINISHED', 'AWARDED'] } },
    orderBy: { scheduledKickoffUtc: 'desc' },
    select: { seasonId: true, season: { select: { name: true } } },
  });
  if (!latest) {
    return {
      leagueId: league.id,
      leagueName: league.name,
      country: league.country,
      seasonName: null,
      rows: [],
      matchesPlayed: 0,
    };
  }

  const matches = await prisma.match.findMany({
    where: {
      leagueId,
      seasonId: latest.seasonId,
      status: { in: ['FINISHED', 'AWARDED'] },
      homeScore: { not: null },
      awayScore: { not: null },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: {
      homeScore: true,
      awayScore: true,
      homeTeam: { select: { id: true, name: true } },
      awayTeam: { select: { id: true, name: true } },
    },
  });

  const table = new Map<string, StandingRow>();

  const ensure = (id: string, name: string): StandingRow => {
    let row = table.get(id);
    if (!row) {
      row = {
        position: 0,
        teamId: id,
        teamName: name,
        played: 0,
        won: 0,
        drawn: 0,
        lost: 0,
        goalsFor: 0,
        goalsAgainst: 0,
        goalDifference: 0,
        points: 0,
        form: [],
      };
      table.set(id, row);
    }
    return row;
  };

  for (const match of matches) {
    const homeGoals = match.homeScore as number;
    const awayGoals = match.awayScore as number;

    const home = ensure(match.homeTeam.id, match.homeTeam.name);
    const away = ensure(match.awayTeam.id, match.awayTeam.name);

    home.played++;
    away.played++;
    home.goalsFor += homeGoals;
    home.goalsAgainst += awayGoals;
    away.goalsFor += awayGoals;
    away.goalsAgainst += homeGoals;

    if (homeGoals > awayGoals) {
      home.won++;
      home.points += 3;
      away.lost++;
      home.form.unshift('W');
      away.form.unshift('L');
    } else if (homeGoals < awayGoals) {
      away.won++;
      away.points += 3;
      home.lost++;
      home.form.unshift('L');
      away.form.unshift('W');
    } else {
      home.drawn++;
      away.drawn++;
      home.points += 1;
      away.points += 1;
      home.form.unshift('D');
      away.form.unshift('D');
    }
  }

  const rows = [...table.values()]
    .map((row) => ({
      ...row,
      goalDifference: row.goalsFor - row.goalsAgainst,
      form: row.form.slice(0, FORM_LENGTH),
    }))
    .sort(
      (a, b) =>
        b.points - a.points ||
        b.goalDifference - a.goalDifference ||
        b.goalsFor - a.goalsFor ||
        a.teamName.localeCompare(b.teamName),
    )
    .map((row, index) => ({ ...row, position: index + 1 }));

  return {
    leagueId: league.id,
    leagueName: league.name,
    country: league.country,
    seasonName: latest.season?.name ?? null,
    rows,
    matchesPlayed: matches.length,
  };
}

/** Leagues that actually have a table worth showing, richest first. */
export async function getLeaguesWithResults(limit = 6) {
  const grouped = await prisma.match.groupBy({
    by: ['leagueId'],
    where: { status: { in: ['FINISHED', 'AWARDED'] } },
    _count: true,
    orderBy: { _count: { leagueId: 'desc' } },
    take: limit,
  });

  const leagues = await prisma.league.findMany({
    where: { id: { in: grouped.map((g) => g.leagueId) } },
    select: { id: true, name: true, country: true, tier: true },
  });

  const countById = new Map(grouped.map((g) => [g.leagueId, g._count]));
  return leagues
    .map((league) => ({ ...league, finishedMatches: countById.get(league.id) ?? 0 }))
    .sort((a, b) => (a.tier ?? 9) - (b.tier ?? 9) || b.finishedMatches - a.finishedMatches);
}

/**
 * The week's matches the market has priced most heavily — a decent proxy for
 * "big game", and derived from data we already hold rather than an opinion.
 */
export async function getMostPricedMatches(range: { from: Date; to: Date }, limit = 6) {
  const matches = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: { gte: range.from, lt: range.to },
      odds: { some: {} },
    },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      status: true,
      homeScore: true,
      awayScore: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true, country: true } },
      _count: { select: { odds: true } },
    },
  });

  return matches
    .sort((a, b) => b._count.odds - a._count.odds)
    .slice(0, limit)
    .map((match) => ({
      id: match.id,
      kickoffUtc: match.scheduledKickoffUtc,
      status: match.status,
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      league: match.league.name,
      country: match.league.country,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      priceCount: match._count.odds,
    }));
}

/**
 * The tables worth putting on the front page: Europe's big five plus the
 * Süper Lig. Ordered deliberately rather than by row count, so the tab order is
 * stable from day to day.
 */
export const FEATURED_DIVISIONS = ['E0', 'SP1', 'D1', 'I1', 'F1', 'T1'] as const;

export async function getFeaturedStandings(): Promise<LeagueStandings[]> {
  const leagues = await prisma.league.findMany({
    where: { csvDivision: { in: [...FEATURED_DIVISIONS] } },
    select: { id: true, csvDivision: true },
  });

  const byDivision = new Map(leagues.map((l) => [l.csvDivision, l.id]));
  const ordered = FEATURED_DIVISIONS.map((division) => byDivision.get(division)).filter(
    (id): id is string => Boolean(id),
  );

  const tables = await Promise.all(ordered.map((id) => getLeagueStandings(id)));
  // A league with no imported results yet is dropped rather than shown empty.
  return tables.filter((table): table is LeagueStandings => table !== null && table.rows.length > 0);
}
