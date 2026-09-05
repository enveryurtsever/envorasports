import { prisma } from '@/lib/db/prisma';
import { modelHistoryStart } from '@/lib/models/history-window';

/**
 * Team form (§13).
 *
 * Form is computed from matches that finished strictly before a cutoff, so the
 * same function serves live prediction and backtesting without a second code
 * path — the only difference is the cutoff you pass (§57).
 *
 * Windows are configurable rather than a hard-coded "last 5" (§13).
 */

export type FormWindow = 'LAST_5' | 'LAST_10' | 'LAST_20' | 'SEASON';
export type VenueScope = 'ALL' | 'HOME' | 'AWAY';

export const FORM_WINDOWS: Record<FormWindow, number | null> = {
  LAST_5: 5,
  LAST_10: 10,
  LAST_20: 20,
  SEASON: null,
};

export interface TeamForm {
  teamId: string;
  window: FormWindow;
  venueScope: VenueScope;
  asOf: Date;
  matchesPlayed: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  averageGoalsFor: number;
  averageGoalsAgainst: number;
  averageXg: number | null;
  averageXga: number | null;
  cleanSheetRate: number;
  bttsRate: number;
  over15Rate: number;
  over25Rate: number;
  over35Rate: number;
  /** How many matches actually backed the numbers. Feeds data quality (§44). */
  sampleSize: number;
  /** Most recent first. */
  results: Array<'W' | 'D' | 'L'>;
}

interface FormMatch {
  scheduledKickoffUtc: Date;
  homeTeamId: string;
  homeScore: number | null;
  awayScore: number | null;
  statistics: Array<{ teamId: string; expectedGoals: unknown }>;
}

function emptyForm(teamId: string, window: FormWindow, venueScope: VenueScope, asOf: Date): TeamForm {
  return {
    teamId,
    window,
    venueScope,
    asOf,
    matchesPlayed: 0,
    wins: 0,
    draws: 0,
    losses: 0,
    goalsFor: 0,
    goalsAgainst: 0,
    averageGoalsFor: 0,
    averageGoalsAgainst: 0,
    averageXg: null,
    averageXga: null,
    cleanSheetRate: 0,
    bttsRate: 0,
    over15Rate: 0,
    over25Rate: 0,
    over35Rate: 0,
    sampleSize: 0,
    results: [],
  };
}

/**
 * Loads a team's recent finished matches once; the caller then slices it into
 * every window and venue scope without touching the database again.
 */
export async function loadRecentMatches(
  teamId: string,
  asOf: Date,
  limit = 40,
  seasonId?: string,
): Promise<FormMatch[]> {
  return prisma.match.findMany({
    where: {
      status: { in: ['FINISHED', 'AWARDED'] },
      homeScore: { not: null },
      awayScore: { not: null },
      // Strictly before the cutoff: the match being predicted is excluded.
      // Bounded below too — a side's form two seasons ago is a different side.
      scheduledKickoffUtc: { lt: asOf, gte: modelHistoryStart(asOf) },
      OR: [{ homeTeamId: teamId }, { awayTeamId: teamId }],
      ...(seasonId ? { seasonId } : {}),
    },
    orderBy: { scheduledKickoffUtc: 'desc' },
    take: limit,
    select: {
      scheduledKickoffUtc: true,
      homeTeamId: true,
      homeScore: true,
      awayScore: true,
      statistics: { select: { teamId: true, expectedGoals: true } },
    },
  });
}

export function computeForm(
  teamId: string,
  matches: FormMatch[],
  window: FormWindow,
  venueScope: VenueScope,
  asOf: Date,
): TeamForm {
  const scoped = matches.filter((match) => {
    const isHome = match.homeTeamId === teamId;
    if (venueScope === 'HOME') return isHome;
    if (venueScope === 'AWAY') return !isHome;
    return true;
  });

  const size = FORM_WINDOWS[window];
  const selected = size === null ? scoped : scoped.slice(0, size);

  if (selected.length === 0) return emptyForm(teamId, window, venueScope, asOf);

  const form = emptyForm(teamId, window, venueScope, asOf);
  let xgSum = 0;
  let xgaSum = 0;
  let xgCount = 0;
  let cleanSheets = 0;
  let btts = 0;
  let over15 = 0;
  let over25 = 0;
  let over35 = 0;

  for (const match of selected) {
    const isHome = match.homeTeamId === teamId;
    const scored = (isHome ? match.homeScore : match.awayScore) as number;
    const conceded = (isHome ? match.awayScore : match.homeScore) as number;
    const total = scored + conceded;

    form.matchesPlayed++;
    form.goalsFor += scored;
    form.goalsAgainst += conceded;

    if (scored > conceded) {
      form.wins++;
      form.results.push('W');
    } else if (scored === conceded) {
      form.draws++;
      form.results.push('D');
    } else {
      form.losses++;
      form.results.push('L');
    }

    if (conceded === 0) cleanSheets++;
    if (scored > 0 && conceded > 0) btts++;
    if (total > 1.5) over15++;
    if (total > 2.5) over25++;
    if (total > 3.5) over35++;

    // xG is optional: the CSV archive has none, so many leagues will never
    // populate it. Averaging over only the matches that have it, and reporting
    // null when none do, is the honest treatment (§12, §44).
    const own = match.statistics.find((s) => s.teamId === teamId);
    const opponent = match.statistics.find((s) => s.teamId !== teamId);
    if (own?.expectedGoals != null) {
      xgSum += Number(own.expectedGoals);
      if (opponent?.expectedGoals != null) xgaSum += Number(opponent.expectedGoals);
      xgCount++;
    }
  }

  const n = form.matchesPlayed;
  form.averageGoalsFor = form.goalsFor / n;
  form.averageGoalsAgainst = form.goalsAgainst / n;
  form.cleanSheetRate = cleanSheets / n;
  form.bttsRate = btts / n;
  form.over15Rate = over15 / n;
  form.over25Rate = over25 / n;
  form.over35Rate = over35 / n;
  form.sampleSize = n;
  form.averageXg = xgCount > 0 ? xgSum / xgCount : null;
  form.averageXga = xgCount > 0 ? xgaSum / xgCount : null;

  return form;
}

export interface TeamFormBundle {
  teamId: string;
  asOf: Date;
  windows: Record<FormWindow, TeamForm>;
  home: TeamForm;
  away: TeamForm;
  /** True when the team has enough history for the numbers to mean anything. */
  hasUsableSample: boolean;
}

const MIN_USABLE_SAMPLE = 5;

export async function getTeamForm(
  teamId: string,
  asOf: Date,
  seasonId?: string,
): Promise<TeamFormBundle> {
  const matches = await loadRecentMatches(teamId, asOf, 40, seasonId);

  const windows = {
    LAST_5: computeForm(teamId, matches, 'LAST_5', 'ALL', asOf),
    LAST_10: computeForm(teamId, matches, 'LAST_10', 'ALL', asOf),
    LAST_20: computeForm(teamId, matches, 'LAST_20', 'ALL', asOf),
    SEASON: computeForm(teamId, matches, 'SEASON', 'ALL', asOf),
  } satisfies Record<FormWindow, TeamForm>;

  return {
    teamId,
    asOf,
    windows,
    home: computeForm(teamId, matches, 'LAST_10', 'HOME', asOf),
    away: computeForm(teamId, matches, 'LAST_10', 'AWAY', asOf),
    hasUsableSample: windows.LAST_10.sampleSize >= MIN_USABLE_SAMPLE,
  };
}

/**
 * Persists a form snapshot so a historical prediction can be re-read exactly as
 * it was computed. Append-only and keyed on the cutoff (§13).
 */
export async function persistFormSnapshot(form: TeamForm, leagueId?: string): Promise<void> {
  await prisma.teamFormSnapshot
    .upsert({
      where: {
        teamId_snapshotDate_window_venueScope: {
          teamId: form.teamId,
          snapshotDate: form.asOf,
          window: form.window,
          venueScope: form.venueScope,
        },
      },
      update: {},
      create: {
        teamId: form.teamId,
        leagueId: leagueId ?? null,
        snapshotDate: form.asOf,
        window: form.window,
        venueScope: form.venueScope,
        matchesPlayed: form.matchesPlayed,
        wins: form.wins,
        draws: form.draws,
        losses: form.losses,
        goalsFor: form.goalsFor,
        goalsAgainst: form.goalsAgainst,
        averageGoalsFor: form.averageGoalsFor.toFixed(3),
        averageGoalsAgainst: form.averageGoalsAgainst.toFixed(3),
        averageXg: form.averageXg === null ? null : form.averageXg.toFixed(3),
        averageXga: form.averageXga === null ? null : form.averageXga.toFixed(3),
        cleanSheetRate: form.cleanSheetRate.toFixed(4),
        bttsRate: form.bttsRate.toFixed(4),
        over15Rate: form.over15Rate.toFixed(4),
        over25Rate: form.over25Rate.toFixed(4),
        over35Rate: form.over35Rate.toFixed(4),
        sampleSize: form.sampleSize,
      },
    })
    .catch(() => undefined);
}

/**
 * League-wide scoring baseline at a point in time, used to normalise attack and
 * defence strength in the Poisson model.
 */
export async function getLeagueAverages(
  leagueId: string,
  asOf: Date,
): Promise<{ homeGoals: number; awayGoals: number; sampleSize: number }> {
  const matches = await prisma.match.findMany({
    where: {
      leagueId,
      status: { in: ['FINISHED', 'AWARDED'] },
      homeScore: { not: null },
      awayScore: { not: null },
      // Scoring rates drift between seasons; the baseline every attack and
      // defence strength is measured against has to be the current one.
      scheduledKickoffUtc: { lt: asOf, gte: modelHistoryStart(asOf) },
    },
    orderBy: { scheduledKickoffUtc: 'desc' },
    take: 400,
    select: { homeScore: true, awayScore: true },
  });

  if (matches.length === 0) {
    // Long-run football averages, used only until a league has its own history.
    return { homeGoals: 1.5, awayGoals: 1.15, sampleSize: 0 };
  }

  const homeGoals = matches.reduce((sum, m) => sum + (m.homeScore as number), 0) / matches.length;
  const awayGoals = matches.reduce((sum, m) => sum + (m.awayScore as number), 0) / matches.length;

  return { homeGoals, awayGoals, sampleSize: matches.length };
}
