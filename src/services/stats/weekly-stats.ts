import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { getBulletinSchedule } from '@/lib/config/settings-service';
import {
  bulletinWeek,
  previousBulletinWeek,
  todayInSchedule,
  type BulletinWeek,
} from '@/lib/schedule/bulletin-schedule';
import { COUPON_CATEGORIES, type CouponCategory } from '@/lib/config/coupon-settings';
import { dateKeyToUtcMidnight } from '@/lib/time/zoned';
import { dec, toMoney, type Decimal } from '@/lib/math/decimal';

/**
 * Weekly bulletin reporting (§40).
 *
 * The reporting unit is the week, because that is the unit the bulletin works
 * in — a Monday and a Thursday publication together cover one week of football.
 *
 * Pending items are never counted in a hit rate (§40). A week still in progress
 * reports what has settled and says how much is outstanding.
 */

export interface SelectionAccuracy {
  settled: number;
  correct: number;
  incorrect: number;
  /** Void/pushed legs: neither right nor wrong. */
  neutral: number;
  pending: number;
  /** correct / (correct + incorrect); null until something has settled. */
  hitRate: number | null;
}

export interface CategoryPerformance {
  category: CouponCategory;
  generated: number;
  pending: number;
  won: number;
  lost: number;
  partial: number;
  voided: number;
  hitRate: number | null;
  /** Product of odds across won coupons — what the week actually returned. */
  averageOdds: number | null;
}

export interface WeeklyStats {
  week: BulletinWeek;
  isCurrentWeek: boolean;
  matchesTotal: number;
  matchesFinished: number;
  matchesPending: number;
  selections: SelectionAccuracy;
  categories: CategoryPerformance[];
  couponsGenerated: number;
  couponsSettled: number;
}

/**
 * Whether a week has anything worth showing yet: a finished match, or a coupon
 * that has been graded. A week of fixtures that have not kicked off is a
 * schedule, not a summary.
 */
async function weekHasActivity(week: {
  startUtc: Date;
  endUtc: Date;
  startDate: string;
  endDate: string;
}): Promise<boolean> {
  const [finished, settled] = await Promise.all([
    prisma.match.count({
      where: {
        scheduledKickoffUtc: { gte: week.startUtc, lt: week.endUtc },
        status: { in: ['FINISHED', 'AWARDED'] },
      },
    }),
    prisma.coupon.count({
      where: {
        targetDate: {
          gte: dateKeyToUtcMidnight(week.startDate),
          lte: dateKeyToUtcMidnight(week.endDate),
        },
        resultStatus: { not: 'PENDING' },
      },
    }),
  ]);
  return finished > 0 || settled > 0;
}

function ratio(correct: number, incorrect: number): number | null {
  const decided = correct + incorrect;
  return decided === 0 ? null : correct / decided;
}

export async function getWeeklyStats(weekOffset = 0): Promise<WeeklyStats> {
  const schedule = await getBulletinSchedule();
  const today = todayInSchedule(schedule);

  let week = bulletinWeek(today, schedule);
  for (let i = 0; i < Math.abs(weekOffset); i++) {
    week = previousBulletinWeek(week, schedule);
  }

  /**
   * Do not empty the board the moment the week rolls.
   *
   * The week starts on Monday, and Sunday is the biggest slate of it — so at
   * local midnight the summary switched to a week with nothing in it yet and
   * the day that had just finished disappeared. Nothing was lost; it had simply
   * moved into a bucket the page was no longer showing.
   *
   * When the current week has produced nothing to report, the last week that
   * did is shown instead. `isCurrentWeek` already travels with the payload, so
   * the page can say which week it is looking at rather than implying it is
   * this one.
   */
  if (weekOffset === 0 && !(await weekHasActivity(week))) {
    const previous = previousBulletinWeek(week, schedule);
    if (await weekHasActivity(previous)) week = previous;
  }

  const [matchesTotal, matchesFinished, predictionGroups, coupons] = await Promise.all([
    prisma.match.count({
      where: { scheduledKickoffUtc: { gte: week.startUtc, lt: week.endUtc } },
    }),
    prisma.match.count({
      where: {
        scheduledKickoffUtc: { gte: week.startUtc, lt: week.endUtc },
        status: { in: ['FINISHED', 'AWARDED'] },
      },
    }),
    // Selection-level accuracy: what did the model actually get right?
    prisma.prediction.groupBy({
      by: ['status'],
      where: {
        recommended: true,
        match: { scheduledKickoffUtc: { gte: week.startUtc, lt: week.endUtc } },
      },
      _count: true,
    }),
    prisma.coupon.findMany({
      where: {
        targetDate: {
          gte: dateKeyToUtcMidnight(week.startDate),
          lte: dateKeyToUtcMidnight(week.endDate),
        },
      },
      select: { category: true, resultStatus: true, totalOdds: true, effectiveOdds: true },
    }),
  ]);

  const countByStatus = (status: string) =>
    predictionGroups.find((g) => g.status === status)?._count ?? 0;

  const correct = countByStatus('WON') + countByStatus('HALF_WON');
  const incorrect = countByStatus('LOST') + countByStatus('HALF_LOST');
  const neutral = countByStatus('PUSHED') + countByStatus('VOID') + countByStatus('CANCELED');
  const pending = countByStatus('PENDING');

  const categories: CategoryPerformance[] = COUPON_CATEGORIES.map((category) => {
    const rows = coupons.filter((c) => c.category === category);
    const won = rows.filter((c) => c.resultStatus === 'WON').length;
    const lost = rows.filter((c) => c.resultStatus === 'LOST').length;
    const partial = rows.filter((c) => c.resultStatus === 'PARTIAL_WIN').length;
    const voided = rows.filter((c) => c.resultStatus === 'VOID').length;
    const stillOpen = rows.filter((c) => c.resultStatus === 'PENDING').length;

    const settledOdds = rows
      .filter((c) => c.resultStatus !== 'PENDING')
      .map((c) => Number(c.totalOdds))
      .filter((n) => Number.isFinite(n));

    return {
      category,
      generated: rows.length,
      pending: stillOpen,
      won,
      lost,
      partial,
      voided,
      // A partial win counts as a win for hit rate; its financial outcome is
      // reported separately by the system-coupon figures.
      hitRate: ratio(won + partial, lost),
      averageOdds:
        settledOdds.length > 0
          ? settledOdds.reduce((a, b) => a + b, 0) / settledOdds.length
          : null,
    };
  });

  return {
    week,
    isCurrentWeek: weekOffset === 0,
    matchesTotal,
    matchesFinished,
    matchesPending: matchesTotal - matchesFinished,
    selections: {
      settled: correct + incorrect + neutral,
      correct,
      incorrect,
      neutral,
      pending,
      hitRate: ratio(correct, incorrect),
    },
    categories,
    couponsGenerated: coupons.length,
    couponsSettled: coupons.filter((c) => c.resultStatus !== 'PENDING').length,
  };
}

/** Highest return a coupon could still produce, for the locked summary. */
export function maxPotentialReturn(totalOdds: Decimal[], stake: Decimal): Decimal {
  if (totalOdds.length === 0) return dec(0);
  const best = totalOdds.reduce((max, odds) => (odds.greaterThan(max) ? odds : max), dec(0));
  return toMoney(best.times(stake));
}

export interface NotableWin {
  reference: string;
  category: CouponCategory;
  totalOdds: number;
  selectionCount: number;
  targetDate: Date;
  settledAt: Date | null;
}

/**
 * The shop window: the biggest settled win and the most recent one.
 *
 * Both are real settled coupons with their dates attached — a claim a reader
 * can check against the prediction history, not a marketing number.
 */
export async function getNotableWins(): Promise<{
  biggest: NotableWin | null;
  latest: NotableWin | null;
}> {
  const select = {
    reference: true,
    category: true,
    totalOdds: true,
    selectionCount: true,
    targetDate: true,
    settledAt: true,
  } as const;

  // PARTIAL_WIN counts: a system coupon that returned a profit did win.
  const where: Prisma.CouponWhereInput = {
    resultStatus: { in: ['WON', 'PARTIAL_WIN'] },
  };

  const [biggest, latest] = await Promise.all([
    prisma.coupon.findFirst({ where, orderBy: { totalOdds: 'desc' }, select }),
    prisma.coupon.findFirst({ where, orderBy: { settledAt: 'desc' }, select }),
  ]);

  const map = (row: typeof biggest): NotableWin | null =>
    row
      ? {
          reference: row.reference,
          category: row.category as CouponCategory,
          totalOdds: Number(row.totalOdds),
          selectionCount: row.selectionCount,
          targetDate: row.targetDate,
          settledAt: row.settledAt,
        }
      : null;

  return { biggest: map(biggest), latest: map(latest) };
}
