import { prisma } from '@/lib/db/prisma';
import { localDateKey } from '@/lib/time/zoned';

/**
 * The matches we actually put a pick on, and how those picks did.
 *
 * Distinct from the fixtures page: this is the record, not the schedule. A
 * fixture nobody backed does not belong here, and a fixture backed three times
 * appears once with its three picks.
 */

export interface PlayedPick {
  marketCode: string;
  selectionCode: string;
  odds: number;
  resultStatus: string;
  /** References of the coupons that carried it, for context. */
  coupons: string[];
}

/** The model's own call on one market, priced or not, with how it went. */
export interface AnalysisCall {
  marketCode: string;
  selectionCode: string;
  probability: number;
  /** PENDING until the match settles; then WON / LOST / PUSHED. */
  status: string;
}

export interface PlayedMatch {
  id: string;
  kickoffUtc: Date;
  status: string;
  homeTeam: string;
  awayTeam: string;
  league: string;
  homeScore: number | null;
  awayScore: number | null;
  picks: PlayedPick[];
  /**
   * The analysis report: the model's most likely outcome on the result, the
   * 2.5 line and the half-time result, by its own probability — not by
   * price, edge or value. Three calls a reader can check against the score.
   */
  analysis: AnalysisCall[];
}

export interface PlayedWeek {
  /** ISO date of the week's Monday, in schedule-local terms. */
  key: string;
  startDate: Date;
  endDate: Date;
  matches: PlayedMatch[];
  won: number;
  lost: number;
  pending: number;
}

export interface PlayedSummary {
  weeks: PlayedWeek[];
  totalPicks: number;
  won: number;
  lost: number;
  pending: number;
  /** Settled picks only — a pending pick is not a miss. */
  hitRate: number | null;
  matchesPlayed: number;
}

/** Result, the 2.5 line, half-time result: one call each, most likely wins. */
const ANALYSIS_GROUP: Record<string, 'result' | 'goals' | 'halfTime'> = {
  MS_1: 'result',
  MS_X: 'result',
  MS_2: 'result',
  OVER_2_5: 'goals',
  UNDER_2_5: 'goals',
  HT_1: 'halfTime',
  HT_X: 'halfTime',
  HT_2: 'halfTime',
};
const ANALYSIS_CODES = Object.keys(ANALYSIS_GROUP);
const ANALYSIS_ORDER = ['result', 'goals', 'halfTime'] as const;

const WON_STATUSES = new Set(['WON', 'HALF_WON']);
const LOST_STATUSES = new Set(['LOST', 'HALF_LOST']);

/** Monday of the week containing `date`, at local midnight. */
function weekStart(date: Date): Date {
  const day = date.getUTCDay();
  const daysSinceMonday = (day + 6) % 7;
  const start = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - daysSinceMonday),
  );
  return start;
}

export async function getPlayedMatches(
  from: Date,
  to: Date,
  timezone: string,
): Promise<PlayedSummary> {
  const selections = await prisma.couponSelection.findMany({
    where: { match: { scheduledKickoffUtc: { gte: from, lt: to } } },
    select: {
      marketCode: true,
      selectionCode: true,
      odds: true,
      resultStatus: true,
      coupon: { select: { reference: true } },
      match: {
        select: {
          id: true,
          scheduledKickoffUtc: true,
          status: true,
          homeScore: true,
          awayScore: true,
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
          league: { select: { name: true } },
        },
      },
    },
    orderBy: { match: { scheduledKickoffUtc: 'desc' } },
  });

  const byMatch = new Map<string, PlayedMatch>();
  const pickIndex = new Map<string, PlayedPick>();

  const entryFor = (match: {
    id: string;
    scheduledKickoffUtc: Date;
    status: string;
    homeScore: number | null;
    awayScore: number | null;
    homeTeam: { name: string };
    awayTeam: { name: string };
    league: { name: string };
  }): PlayedMatch => {
    let entry = byMatch.get(match.id);
    if (!entry) {
      entry = {
        id: match.id,
        kickoffUtc: match.scheduledKickoffUtc,
        status: match.status,
        homeTeam: match.homeTeam.name,
        awayTeam: match.awayTeam.name,
        league: match.league.name,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        picks: [],
        analysis: [],
      };
      byMatch.set(match.id, entry);
    }
    return entry;
  };

  for (const selection of selections) {
    const match = selection.match;
    const entry = entryFor(match);

    // The same pick on several coupons is one pick with several references —
    // otherwise a leg that happened to be popular counts three times.
    const key = `${match.id}:${selection.marketCode}:${selection.selectionCode}`;
    const existing = pickIndex.get(key);
    if (existing) {
      existing.coupons.push(selection.coupon.reference);
      continue;
    }

    const pick: PlayedPick = {
      marketCode: selection.marketCode,
      selectionCode: selection.selectionCode,
      odds: Number(selection.odds),
      resultStatus: selection.resultStatus,
      coupons: [selection.coupon.reference],
    };
    pickIndex.set(key, pick);
    entry.picks.push(pick);
  }

  /**
   * Every match the model priced is listed, on a coupon or not: the report is
   * the model's opinion, and a reader judging the model needs the ones it
   * chose not to play as much as the ones it did.
   */
  const predictions = await prisma.prediction.findMany({
    where: {
      supersededAt: null,
      selection: { code: { in: ANALYSIS_CODES } },
      match: { scheduledKickoffUtc: { gte: from, lt: to } },
    },
    select: {
      probability: true,
      status: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
      match: {
        select: {
          id: true,
          scheduledKickoffUtc: true,
          status: true,
          homeScore: true,
          awayScore: true,
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
          league: { select: { name: true } },
        },
      },
    },
  });

  const callsByMatch = new Map<string, Map<string, AnalysisCall>>();
  for (const row of predictions) {
    const entry = entryFor(row.match);
    const group = ANALYSIS_GROUP[row.selection.code];
    if (!group) continue;
    const calls = callsByMatch.get(entry.id) ?? new Map<string, AnalysisCall>();
    const current = calls.get(group);
    const probability = Number(row.probability);
    if (!current || probability > current.probability) {
      calls.set(group, {
        marketCode: row.market.code,
        selectionCode: row.selection.code,
        probability,
        status: row.status,
      });
    }
    callsByMatch.set(entry.id, calls);
  }
  for (const [matchId, calls] of callsByMatch) {
    const entry = byMatch.get(matchId);
    if (!entry) continue;
    entry.analysis = ANALYSIS_ORDER.map((group) => calls.get(group)).filter(
      (call): call is AnalysisCall => call !== undefined,
    );
  }

  const weeks = new Map<string, PlayedWeek>();
  let won = 0;
  let lost = 0;
  let pending = 0;

  for (const match of byMatch.values()) {
    const start = weekStart(new Date(`${localDateKey(match.kickoffUtc, timezone)}T00:00:00Z`));
    const key = start.toISOString().slice(0, 10);

    let week = weeks.get(key);
    if (!week) {
      week = {
        key,
        startDate: start,
        endDate: new Date(start.getTime() + 6 * 864e5),
        matches: [],
        won: 0,
        lost: 0,
        pending: 0,
      };
      weeks.set(key, week);
    }
    week.matches.push(match);

    for (const pick of match.picks) {
      if (WON_STATUSES.has(pick.resultStatus)) {
        won++;
        week.won++;
      } else if (LOST_STATUSES.has(pick.resultStatus)) {
        lost++;
        week.lost++;
      } else {
        pending++;
        week.pending++;
      }
    }
  }

  for (const week of weeks.values()) {
    week.matches.sort((a, b) => b.kickoffUtc.getTime() - a.kickoffUtc.getTime());
  }

  const settled = won + lost;

  return {
    weeks: [...weeks.values()].sort((a, b) => b.startDate.getTime() - a.startDate.getTime()),
    totalPicks: won + lost + pending,
    won,
    lost,
    pending,
    hitRate: settled > 0 ? won / settled : null,
    matchesPlayed: byMatch.size,
  };
}
