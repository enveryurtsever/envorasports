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
