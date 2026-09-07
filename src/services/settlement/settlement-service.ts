import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getAppSetting } from '@/lib/config/settings-service';
import { settleSelection } from '@/lib/settlement/evaluators';
import type { MatchResultInput, SettlementOutcome } from '@/lib/settlement/types';
import { Decimal, dec, toMoney, toOdds } from '@/lib/math/decimal';
import { settleSystem, type ColumnResult } from '@/lib/coupons/system-math';
import { invalidateStandingsCache } from '@/services/stats/standings';
import { invalidate } from '@/lib/cache/ttl-cache';

const log = createLogger('settlement');

/**
 * Turns confirmed match results into settled predictions, coupons and system
 * columns (§32, §33, §34).
 *
 * Everything here is idempotent: it only ever moves rows out of PENDING, and
 * re-running it over already-settled rows is a no-op. That matters because the
 * result-sync job can legitimately fire twice for the same match.
 */

export interface SettlementSummary {
  predictionsSettled: number;
  couponsSettled: number;
  systemCouponsSettled: number;
  columnsSettled: number;
}

/**
 * How much of a stake a settled leg returns, as a multiplier.
 *
 * Asian handicap quarter lines really do half-win and half-lose, so an
 * accumulator leg is not binary. Collapsing HALF_WON to WON would overpay and
 * HALF_LOST to LOST would underpay.
 */
export function settlementMultiplier(status: SettlementOutcome, odds: Decimal): Decimal {
  switch (status) {
    case 'WON':
      return odds;
    case 'HALF_WON':
      // Half the stake wins at full odds, half is returned.
      return odds.plus(1).dividedBy(2);
    case 'HALF_LOST':
      // Half the stake wins at full odds, half is lost.
      return odds.dividedBy(2);
    case 'PUSHED':
    case 'VOID':
    case 'CANCELED':
      // Neutralised: removed from the accumulator, stake returned (§33).
      return dec(1);
    case 'LOST':
      return dec(0);
    case 'PENDING':
      return dec(1);
  }
}

function isResolved(status: SettlementOutcome): boolean {
  return status !== 'PENDING';
}

function isNeutral(status: SettlementOutcome): boolean {
  return status === 'PUSHED' || status === 'VOID' || status === 'CANCELED';
}

async function matchResultFor(matchId: string): Promise<MatchResultInput | null> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      homeScore: true,
      awayScore: true,
      halfTimeHomeScore: true,
      halfTimeAwayScore: true,
      statistics: { select: { corners: true, yellowCards: true, redCards: true } },
    },
  });
  if (!match) return null;

  // Corner and card markets need the official statistics, which arrive on their
  // own schedule. Absent statistics leave those markets PENDING, not lost.
  const stats = match.statistics;
  const totalCorners = stats.length > 0 && stats.every((s) => s.corners !== null)
    ? stats.reduce((sum, s) => sum + (s.corners ?? 0), 0)
    : null;
  const totalCards = stats.length > 0 && stats.every((s) => s.yellowCards !== null)
    ? stats.reduce((sum, s) => sum + (s.yellowCards ?? 0) + (s.redCards ?? 0), 0)
    : null;

  return {
    status: match.status,
    homeScore: match.homeScore,
    awayScore: match.awayScore,
    halfTimeHomeScore: match.halfTimeHomeScore,
    halfTimeAwayScore: match.halfTimeAwayScore,
    totalCorners,
    totalCards,
  };
}

/** Settles every open prediction on one match. */
export async function settleMatchPredictions(matchId: string): Promise<number> {
  const result = await matchResultFor(matchId);
  if (!result) return 0;

  const settlementVersion = await getAppSetting<number>('settlement.version', 1);

  const predictions = await prisma.prediction.findMany({
    where: { matchId, status: 'PENDING' },
    select: {
      id: true,
      market: { select: { code: true } },
      selection: { select: { code: true, parameters: true } },
    },
  });

  let settled = 0;
  for (const prediction of predictions) {
    const outcome = settleSelection(
      {
        marketCode: prediction.market.code,
        selectionCode: prediction.selection.code,
        parameters: prediction.selection.parameters as Record<string, unknown> | null,
        handicap: 0,
      },
      result,
    );

    if (!isResolved(outcome)) continue;

    await prisma.prediction.update({
      where: { id: prediction.id },
      data: {
        status: outcome,
        settledAt: new Date(),
        settlementVersion,
        // The exact result used, kept for audit. Original inputs untouched (§41).
        settlementSnapshot: result as unknown as Prisma.InputJsonValue,
      },
    });
    settled++;
  }

  if (settled > 0) log.info('predictions settled', { matchId, settled });
  return settled;
}

/**
 * Mirrors settled predictions onto the coupon selections that reference them,
 * then grades any coupon whose selections are all resolved.
 */
/**
 * Settles predictions for finished matches that nothing settled at the time.
 *
 * `settleMatchPredictions` only ever runs for matches that *transitioned* into
 * a final state inside a result-sync run. Anything else was left behind: a
 * prediction written after its match had already finished, a transition missed
 * while the provider budget was spent, a re-run that replaced a settled
 * generation with a fresh pending one. Those rows then sat PENDING forever, and
 * the coupons resting on them could never be graded — which is exactly how a
 * day of finished football produced eleven coupons stuck at 0/4.
 *
 * Bounded per run so a large backlog is worked through over several ticks
 * rather than in one long transaction.
 */
export async function settlePendingPredictions(
  options: { limit?: number } = {},
): Promise<{ matches: number; predictions: number }> {
  const matches = await prisma.match.findMany({
    where: {
      status: { in: ['FINISHED', 'AWARDED'] },
      homeScore: { not: null },
      awayScore: { not: null },
      predictions: { some: { status: 'PENDING' } },
    },
    orderBy: { scheduledKickoffUtc: 'desc' },
    take: options.limit ?? 200,
    select: { id: true },
  });

  let predictions = 0;
  for (const match of matches) {
    predictions += await settleMatchPredictions(match.id);
  }

  if (predictions > 0) {
    log.info('pending predictions swept', { matches: matches.length, predictions });
  }
  return { matches: matches.length, predictions };
}

export async function settleCoupons(): Promise<{ coupons: number; selections: number }> {
  const settlementVersion = await getAppSetting<number>('settlement.version', 1);

  // 1. Copy prediction outcomes down onto coupon selections.
  const openSelections = await prisma.couponSelection.findMany({
    where: { resultStatus: 'PENDING', prediction: { status: { not: 'PENDING' } } },
    select: { id: true, prediction: { select: { status: true } } },
  });

  for (const selection of openSelections) {
    await prisma.couponSelection.update({
      where: { id: selection.id },
      data: { resultStatus: selection.prediction.status, settledAt: new Date() },
    });
  }

  // 2. Grade coupons that have no unresolved selection left.
  const candidates = await prisma.coupon.findMany({
    where: { resultStatus: 'PENDING', selections: { none: { resultStatus: 'PENDING' } } },
    select: {
      id: true,
      kind: true,
      selections: { select: { resultStatus: true, odds: true } },
    },
  });

  let graded = 0;
  for (const coupon of candidates) {
    if (coupon.selections.length === 0) continue;

    const statuses = coupon.selections.map((s) => s.resultStatus as SettlementOutcome);
    const lost = statuses.some((s) => s === 'LOST');
    const allNeutral = statuses.every(isNeutral);

    let effectiveOdds = dec(1);
    for (const selection of coupon.selections) {
      effectiveOdds = effectiveOdds.times(
        settlementMultiplier(selection.resultStatus as SettlementOutcome, dec(selection.odds)),
      );
    }

    const resultStatus = lost ? 'LOST' : allNeutral ? 'VOID' : 'WON';

    await prisma.coupon.update({
      where: { id: coupon.id },
      data: {
        resultStatus,
        settledAt: new Date(),
        settlementVersion,
        winningSelectionCount: statuses.filter((s) => s === 'WON' || s === 'HALF_WON').length,
        losingSelectionCount: statuses.filter((s) => s === 'LOST' || s === 'HALF_LOST').length,
        voidSelectionCount: statuses.filter(isNeutral).length,
        effectiveOdds: lost ? new Prisma.Decimal(0) : new Prisma.Decimal(toOdds(effectiveOdds).toFixed(4)),
      },
    });
    graded++;
  }

  if (graded > 0) log.info('coupons settled', { coupons: graded, selections: openSelections.length });
  return { coupons: graded, selections: openSelections.length };
}

/**
 * Settles system coupons column by column (§34).
 *
 * A system coupon is not simply won or lost: it reports the financial outcome
 * of the columns that actually came in, which is normally a PARTIAL_WIN.
 */
export async function settleSystemCoupons(): Promise<{ systems: number; columns: number }> {
  const settlementVersion = await getAppSetting<number>('settlement.version', 1);

  const systems = await prisma.systemCoupon.findMany({
    where: {
      resultStatus: 'PENDING',
      coupon: { selections: { none: { resultStatus: 'PENDING' } } },
    },
    select: {
      id: true,
      columns: {
        select: {
          id: true,
          columnIndex: true,
          stake: true,
          combinedOdds: true,
          selections: {
            select: { couponSelection: { select: { resultStatus: true, odds: true } } },
          },
        },
      },
    },
  });

  let systemsSettled = 0;
  let columnsSettled = 0;

  for (const system of systems) {
    if (system.columns.length === 0) continue;

    const graded = system.columns.map((column) => {
      const statuses = column.selections.map(
        (s) => s.couponSelection.resultStatus as SettlementOutcome,
      );

      const lost = statuses.some((s) => s === 'LOST');
      const allNeutral = statuses.length > 0 && statuses.every(isNeutral);

      // Effective odds for this column only — a void leg neutralises inside the
      // column it belongs to, not across the whole coupon.
      let effectiveOdds = dec(1);
      for (const selection of column.selections) {
        effectiveOdds = effectiveOdds.times(
          settlementMultiplier(
            selection.couponSelection.resultStatus as SettlementOutcome,
            dec(selection.couponSelection.odds),
          ),
        );
      }

      const result: ColumnResult = lost ? 'LOST' : allNeutral ? 'VOID' : 'WON';
      return { column, result, effectiveOdds: toOdds(effectiveOdds) };
    });

    const settlement = settleSystem(
      graded.map((g) => ({
        columnIndex: g.column.columnIndex,
        combinedOdds: g.effectiveOdds,
        stake: g.column.stake,
        result: g.result,
      })),
    );

    await prisma.$transaction([
      ...settlement.columns.map((column, index) =>
        prisma.systemCouponColumn.update({
          where: { id: graded[index]!.column.id },
          data: {
            resultStatus: column.result === 'PENDING' ? 'PENDING' : column.result,
            returnAmount: new Prisma.Decimal(column.returnAmount.toFixed(2)),
            netProfit: new Prisma.Decimal(column.netProfit.toFixed(2)),
            settledAt: new Date(),
          },
        }),
      ),
      prisma.systemCoupon.update({
        where: { id: system.id },
        data: {
          resultStatus: settlement.status,
          winningColumns: settlement.winningColumns,
          losingColumns: settlement.losingColumns,
          voidColumns: settlement.voidColumns,
          totalReturn: new Prisma.Decimal(settlement.totalReturn.toFixed(2)),
          netProfit: new Prisma.Decimal(settlement.netProfit.toFixed(2)),
          roi: new Prisma.Decimal(settlement.roi.toFixed(6)),
          settledAt: new Date(),
          settlementVersion,
        },
      }),
    ]);

    systemsSettled++;
    columnsSettled += settlement.columns.length;
  }

  if (systemsSettled > 0) {
    log.info('system coupons settled', { systems: systemsSettled, columns: columnsSettled });
  }
  return { systems: systemsSettled, columns: columnsSettled };
}

/** The whole settlement chain for a set of newly finished matches. */
export async function runSettlement(finishedMatchIds: string[]): Promise<SettlementSummary> {
  let predictionsSettled = 0;
  for (const matchId of finishedMatchIds) {
    predictionsSettled += await settleMatchPredictions(matchId);
  }

  const coupons = await settleCoupons();
  const systems = await settleSystemCoupons();

  // Results have moved, so every cached view of them is out of date.
  invalidateStandingsCache();
  invalidate('home:');

  return {
    predictionsSettled,
    couponsSettled: coupons.coupons,
    systemCouponsSettled: systems.systems,
    columnsSettled: systems.columns,
  };
}

export { toMoney };
