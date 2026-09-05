import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { Decimal, dec, toOdds } from '@/lib/math/decimal';
import { combinedProbability } from '@/lib/math/probability';
import { DEFAULT_SCORING_WEIGHTS, type CouponScoringWeights } from '@/lib/config/coupon-settings';
import { getAppSetting, getSystemSettings } from '@/lib/config/settings-service';
import { couponCorrelation, loadCorrelationMatrix } from './correlation';
import { buildSystemPlan } from '@/lib/coupons/system-math';
import { parseSystemType } from '@/lib/math/combinatorics';
import { invalidate } from '@/lib/cache/ttl-cache';

const log = createLogger('coupons:editor');

/**
 * Operator editing of generated coupons.
 *
 * Every mutation goes through `recalculateCoupon`, so a coupon's totals can
 * never drift from its selections: the odds, probability, EV, confidence, risk
 * and correlation are always recomputed from what is actually on the slip.
 *
 * A settled coupon is never edited — its result is history (§41).
 */

export class CouponEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CouponEditError';
  }
}

/** Derived totals for a coupon, recomputed from its current selections. */
export interface CouponTotals {
  totalOdds: Decimal;
  estimatedProbability: Decimal;
  expectedValue: Decimal;
  confidence: number;
  risk: number;
  correlation: number;
  diversification: number;
  score: number;
  selectionCount: number;
  firstKickoffUtc: Date | null;
  lastKickoffUtc: Date | null;
}

export interface SelectionForTotals {
  matchId: string;
  marketCode: string;
  selectionCode: string;
  odds: Decimal;
  probability: Decimal;
  confidence: number;
  risk: number;
  kickoffUtc: Date;
}

/**
 * Pure totals calculation — no database, so it is directly testable and is the
 * single definition of what a coupon's numbers mean.
 */
export function computeTotals(
  selections: readonly SelectionForTotals[],
  correlation: number,
  weights: CouponScoringWeights,
): CouponTotals {
  if (selections.length === 0) {
    return {
      totalOdds: dec(1),
      estimatedProbability: dec(0),
      expectedValue: dec(-1),
      confidence: 0,
      risk: 0,
      correlation: 0,
      diversification: 0,
      score: 0,
      selectionCount: 0,
      firstKickoffUtc: null,
      lastKickoffUtc: null,
    };
  }

  const totalOdds = selections.reduce<Decimal>((product, s) => product.times(s.odds), dec(1));

  // Independent product, discounted for correlation: legs that move together
  // are less likely to all land than the raw product implies (§33).
  const naive = combinedProbability(selections.map((s) => s.probability));
  const estimatedProbability = naive.times(1 - correlation * 0.25);
  const expectedValue = estimatedProbability.times(totalOdds).minus(1);

  const confidence = selections.reduce((sum, s) => sum + s.confidence, 0) / selections.length;
  const risk = selections.reduce((sum, s) => sum + s.risk, 0) / selections.length;

  const distinctMarkets = new Set(selections.map((s) => s.marketCode)).size;
  const diversification = Math.min(1, distinctMarkets / selections.length);

  const kickoffs = selections.map((s) => s.kickoffUtc.getTime());

  return {
    totalOdds: toOdds(totalOdds),
    estimatedProbability,
    expectedValue,
    confidence,
    risk,
    correlation,
    diversification,
    score:
      Number(estimatedProbability) * weights.probabilityWeight +
      Number(expectedValue) * weights.valueWeight +
      confidence * weights.confidenceWeight +
      diversification * weights.diversificationWeight -
      correlation * weights.correlationPenalty -
      risk * weights.riskPenalty,
    selectionCount: selections.length,
    firstKickoffUtc: new Date(Math.min(...kickoffs)),
    lastKickoffUtc: new Date(Math.max(...kickoffs)),
  };
}

async function loadEditableCoupon(couponId: string) {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: {
      id: true,
      kind: true,
      resultStatus: true,
      selections: {
        orderBy: { sortOrder: 'asc' },
        select: {
          id: true,
          predictionId: true,
          matchId: true,
          marketCode: true,
          selectionCode: true,
          odds: true,
          probability: true,
          resultStatus: true,
          prediction: { select: { confidenceScore: true, riskScore: true } },
          match: { select: { scheduledKickoffUtc: true } },
        },
      },
      systemCoupon: { select: { id: true, systemType: true, stakePerColumn: true } },
    },
  });

  if (!coupon) throw new CouponEditError('Coupon not found');
  if (coupon.resultStatus !== 'PENDING') {
    // Editing a graded coupon would rewrite a result that already happened.
    throw new CouponEditError('A settled coupon cannot be edited');
  }
  return coupon;
}

/** Recomputes and persists every derived figure on a coupon. */
export async function recalculateCoupon(couponId: string): Promise<CouponTotals> {
  const coupon = await loadEditableCoupon(couponId);
  const weights = await getAppSetting<CouponScoringWeights>('scoring.weights', DEFAULT_SCORING_WEIGHTS);
  const matrix = await loadCorrelationMatrix();

  const selections: SelectionForTotals[] = coupon.selections.map((s) => ({
    matchId: s.matchId,
    marketCode: s.marketCode,
    selectionCode: s.selectionCode,
    odds: dec(s.odds),
    probability: dec(s.probability),
    confidence: Number(s.prediction.confidenceScore),
    risk: Number(s.prediction.riskScore),
    kickoffUtc: s.match.scheduledKickoffUtc,
  }));

  const correlation = couponCorrelation(
    matrix,
    selections.map((s) => ({
      matchId: s.matchId,
      marketCode: s.marketCode,
      selectionCode: s.selectionCode,
    })),
  );

  const totals = computeTotals(selections, correlation, weights);

  await prisma.coupon.update({
    where: { id: couponId },
    data: {
      totalOdds: new Prisma.Decimal(totals.totalOdds.toFixed(4)),
      estimatedProbability: new Prisma.Decimal(totals.estimatedProbability.toFixed(8)),
      expectedValue: new Prisma.Decimal(totals.expectedValue.toFixed(6)),
      confidenceScore: new Prisma.Decimal(totals.confidence.toFixed(4)),
      riskScore: new Prisma.Decimal(totals.risk.toFixed(4)),
      correlationScore: new Prisma.Decimal(totals.correlation.toFixed(4)),
      diversificationScore: new Prisma.Decimal(totals.diversification.toFixed(4)),
      score: new Prisma.Decimal(totals.score.toFixed(6)),
      selectionCount: totals.selectionCount,
      ...(totals.firstKickoffUtc && totals.lastKickoffUtc
        ? { firstKickoffUtc: totals.firstKickoffUtc, lastKickoffUtc: totals.lastKickoffUtc }
        : {}),
    },
  });

  // A system coupon's columns are a function of its base set, so changing the
  // set means rebuilding them rather than leaving stale columns behind.
  if (coupon.systemCoupon) {
    await rebuildSystemColumns(couponId);
  }

  // An edited coupon must show its new totals immediately.
  invalidate('home:');

  log.info('coupon recalculated', {
    couponId,
    selections: totals.selectionCount,
    totalOdds: totals.totalOdds.toFixed(2),
  });

  return totals;
}

async function rebuildSystemColumns(couponId: string): Promise<void> {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: {
      selections: { select: { id: true, matchId: true, odds: true } },
      systemCoupon: { select: { id: true, systemType: true, stakePerColumn: true } },
    },
  });
  if (!coupon?.systemCoupon) return;

  const settings = await getSystemSettings();
  const k = parseSystemType(coupon.systemCoupon.systemType) ?? 3;

  if (coupon.selections.length < k) {
    throw new CouponEditError(
      `A ${coupon.systemCoupon.systemType} needs at least ${k} selections; ${coupon.selections.length} remain`,
    );
  }

  const plan = buildSystemPlan({
    selections: coupon.selections.map((s) => ({ id: s.id, odds: dec(s.odds), matchId: s.matchId })),
    systemSelectionCount: k,
    stakePerColumn: dec(coupon.systemCoupon.stakePerColumn),
    maxTotalStake: settings.maxTotalStake,
  });

  await prisma.$transaction([
    prisma.systemCouponColumn.deleteMany({ where: { systemCouponId: coupon.systemCoupon.id } }),
    prisma.systemCoupon.update({
      where: { id: coupon.systemCoupon.id },
      data: {
        baseSelectionCount: plan.baseSelectionCount,
        systemSelectionCount: plan.systemSelectionCount,
        columnCount: plan.columnCount,
        totalStake: new Prisma.Decimal(plan.totalStake.toFixed(2)),
      },
    }),
  ]);

  await prisma.systemCouponColumn.createMany({
    data: plan.columns.map((column) => ({
      systemCouponId: coupon.systemCoupon!.id,
      columnIndex: column.columnIndex,
      combinedOdds: new Prisma.Decimal(column.combinedOdds.toFixed(4)),
      stake: new Prisma.Decimal(column.stake.toFixed(2)),
    })),
  });

  const columns = await prisma.systemCouponColumn.findMany({
    where: { systemCouponId: coupon.systemCoupon.id },
    select: { id: true, columnIndex: true },
  });
  const columnIdByIndex = new Map(columns.map((c) => [c.columnIndex, c.id]));

  const links = plan.columns.flatMap((column) => {
    const columnId = columnIdByIndex.get(column.columnIndex);
    if (!columnId) return [];
    // buildSystemPlan was given couponSelection ids, so they map straight back.
    return column.selectionIds.map((couponSelectionId) => ({ columnId, couponSelectionId }));
  });

  for (let i = 0; i < links.length; i += 2000) {
    await prisma.systemCouponColumnSelection.createMany({
      data: links.slice(i, i + 2000),
      skipDuplicates: true,
    });
  }
}

export async function removeSelection(couponId: string, selectionId: string): Promise<CouponTotals> {
  const coupon = await loadEditableCoupon(couponId);

  if (coupon.selections.length <= 1) {
    throw new CouponEditError('A coupon must keep at least one selection; delete it instead');
  }
  if (!coupon.selections.some((s) => s.id === selectionId)) {
    throw new CouponEditError('That selection is not on this coupon');
  }

  await prisma.couponSelection.delete({ where: { id: selectionId } });
  await resequence(couponId);
  return recalculateCoupon(couponId);
}

/**
 * Adds a prediction to a coupon.
 *
 * The prediction supplies the odds and probability, so an added leg carries the
 * same provenance as a generated one — the operator picks *which* selection,
 * not what it is worth.
 */
export async function addSelection(couponId: string, predictionId: string): Promise<CouponTotals> {
  const coupon = await loadEditableCoupon(couponId);

  if (coupon.selections.some((s) => s.predictionId === predictionId)) {
    throw new CouponEditError('That selection is already on this coupon');
  }

  const prediction = await prisma.prediction.findUnique({
    where: { id: predictionId },
    select: {
      id: true,
      matchId: true,
      probability: true,
      impliedProbability: true,
      oddsUsed: true,
      edge: true,
      expectedValue: true,
      status: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
    },
  });

  if (!prediction) throw new CouponEditError('Prediction not found');
  if (prediction.oddsUsed === null) throw new CouponEditError('That prediction has no price');
  if (prediction.status !== 'PENDING') throw new CouponEditError('That prediction is already settled');

  await prisma.couponSelection.create({
    data: {
      couponId,
      predictionId: prediction.id,
      matchId: prediction.matchId,
      marketCode: prediction.market.code,
      selectionCode: prediction.selection.code,
      odds: prediction.oddsUsed,
      probability: prediction.probability,
      impliedProbability: prediction.impliedProbability ?? new Prisma.Decimal(0),
      edge: prediction.edge ?? new Prisma.Decimal(0),
      expectedValue: prediction.expectedValue ?? new Prisma.Decimal(0),
      sortOrder: coupon.selections.length,
    },
  });

  await resequence(couponId);
  return recalculateCoupon(couponId);
}

async function resequence(couponId: string): Promise<void> {
  const selections = await prisma.couponSelection.findMany({
    where: { couponId },
    orderBy: [{ createdAt: 'asc' }],
    select: { id: true },
  });

  await prisma.$transaction(
    selections.map((selection, index) =>
      prisma.couponSelection.update({ where: { id: selection.id }, data: { sortOrder: index } }),
    ),
  );
}

export async function deleteCoupon(couponId: string): Promise<void> {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: { resultStatus: true },
  });
  if (!coupon) throw new CouponEditError('Coupon not found');
  if (coupon.resultStatus !== 'PENDING') {
    throw new CouponEditError('A settled coupon cannot be deleted');
  }

  // Cascades to selections, the system coupon, its columns and their links.
  await prisma.coupon.delete({ where: { id: couponId } });
  invalidate('home:');
  log.info('coupon deleted', { couponId });
}

/**
 * Candidate predictions the operator can add to a coupon: priced, unsettled,
 * on a match not already used, and not on an excluded match.
 */
export async function availableAdditions(couponId: string, limit = 40) {
  const coupon = await prisma.coupon.findUnique({
    where: { id: couponId },
    select: {
      targetDate: true,
      selections: { select: { matchId: true, predictionId: true } },
    },
  });
  if (!coupon) throw new CouponEditError('Coupon not found');

  const usedMatches = coupon.selections.map((s) => s.matchId);
  const dayStart = new Date(coupon.targetDate);
  const dayEnd = new Date(dayStart.getTime() + 3 * 24 * 60 * 60 * 1000);

  const predictions = await prisma.prediction.findMany({
    where: {
      status: 'PENDING',
      oddsUsed: { not: null },
      matchId: { notIn: usedMatches },
      match: {
        status: 'SCHEDULED',
        excludedFromGeneration: false,
        scheduledKickoffUtc: { gte: dayStart, lt: dayEnd },
      },
    },
    orderBy: [{ predictionTimestamp: 'desc' }, { expectedValue: 'desc' }],
    take: limit * 4,
    select: {
      id: true,
      matchId: true,
      probability: true,
      oddsUsed: true,
      edge: true,
      expectedValue: true,
      predictionTimestamp: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
      match: {
        select: {
          scheduledKickoffUtc: true,
          homeTeam: { select: { name: true } },
          awayTeam: { select: { name: true } },
          league: { select: { name: true } },
        },
      },
    },
  });

  // Predictions are append-only; show only the newest per selection.
  const latest = new Map<string, (typeof predictions)[number]>();
  for (const prediction of predictions) {
    const key = `${prediction.matchId}:${prediction.selection.code}`;
    if (!latest.has(key)) latest.set(key, prediction);
  }

  return [...latest.values()]
    .sort((a, b) => Number(b.expectedValue ?? 0) - Number(a.expectedValue ?? 0))
    .slice(0, limit)
    .map((p) => ({
      predictionId: p.id,
      matchId: p.matchId,
      label: `${p.match.homeTeam.name} – ${p.match.awayTeam.name}`,
      league: p.match.league.name,
      kickoffUtc: p.match.scheduledKickoffUtc,
      marketCode: p.market.code,
      selectionCode: p.selection.code,
      odds: Number(p.oddsUsed),
      probability: Number(p.probability),
      edge: Number(p.edge ?? 0),
      expectedValue: Number(p.expectedValue ?? 0),
    }));
}

/** Keeps a match out of generation without deleting its history. */
export async function setMatchExcluded(
  matchId: string,
  excluded: boolean,
  reason?: string,
): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: { excludedFromGeneration: excluded, exclusionReason: excluded ? (reason ?? null) : null },
  });
  log.info('match exclusion changed', { matchId, excluded, reason });
}
