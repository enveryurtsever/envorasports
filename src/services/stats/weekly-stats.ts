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
   * The week is Monday to Sunday and it resets on Monday, empty or not.
   *
   * An earlier version fell back to the last week with results when the current
   * one had none — which meant that on Monday morning the page still showed the
   * week before, under a heading that said "this week". Carrying yesterday's
   * numbers into today is worse than showing a fresh board: the reader cannot
   * tell which week they are looking at, and a zero on Monday is the truth.
   * Past weeks remain reachable through `weekOffset`.
   */

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
    /**
     * Accuracy over what was actually backed, not over everything eligible.
     *
     * This counted every `recommended` prediction — thousands of selections a
     * week that no coupon ever carried. A reader judging the product by that
     * number is judging a shortlist they were never shown; the coupon legs are
     * the claims that were actually made.
     */
    prisma.couponSelection.groupBy({
      by: ['resultStatus'],
      where: {
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
    predictionGroups.find((g) => g.resultStatus === status)?._count ?? 0;

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
