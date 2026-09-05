import { prisma } from '@/lib/db/prisma';
import {
  CATEGORY_FEATURE,
  DEFAULT_FREE_PREVIEW,
  canAccessCategory,
  requiredPlanFor,
  type FreePreviewPolicy,
} from '@/lib/entitlements/features';
import type { CouponCategory } from '@/lib/config/coupon-settings';
import type { Viewer } from '@/lib/auth/session';
import { getAppSetting } from '@/lib/config/settings-service';
import { dec, toMoney, toOdds } from '@/lib/math/decimal';

/**
 * Entitlement-aware coupon loading (§23, §25).
 *
 * The lock is enforced in the query. A viewer without the entitlement never
 * receives the selections, so the blurred panel in the UI is a placeholder over
 * data that was never sent — not a CSS filter over real content.
 *
 * Three states:
 *   full    — admin, or a plan that covers the category
 *   preview — no membership: a couple of real coupons from the entry category
 *   locked  — aggregate only: how many, the odds band, the best possible return
 */

export type AccessLevel = 'full' | 'preview' | 'locked';

export interface HiddenSummary {
  count: number;
  selectionCount: number;
  minTotalOdds: number | null;
  maxTotalOdds: number | null;
  maxPotentialReturn: number;
  referenceStake: number;
  requiredPlan: string | null;
}

export interface CouponSystemInfo {
  systemType: string;
  /** "4,5,6" — how a Turkish slip reads. */
  systemLabel: string;
  systemSizes: number[];
  baseSelectionCount: number;
  columnCount: number;
  stakePerColumn: number;
  /** columnCount x stakePerColumn, computed by the engine and stored. */
  totalStake: number;
  /** What every column landing would pay. */
  maxReturn: number;
  /** What the columns that actually won returned. */
  totalReturn: number;
  winningColumns: number;
  currency: string;
}

export interface UnlockedCoupon {
  id: string;
  reference: string;
  category: CouponCategory;
  kind: string;
  system: CouponSystemInfo | null;
  totalOdds: number;
  estimatedProbability: number;
  expectedValue: number;
  confidenceScore: number;
  riskScore: number;
  resultStatus: string;
  /** Accumulator odds after void legs are neutralised; null until settled. */
  effectiveOdds: number | null;
  settledAt: Date | null;
  targetDate: Date;
  firstKickoffUtc: Date;
  lastKickoffUtc: Date;
  selections: Array<{
    id: string;
    marketCode: string;
    selectionCode: string;
    odds: number;
    probability: number;
    impliedProbability: number;
    edge: number;
    resultStatus: string;
    match: {
      id: string;
      kickoffUtc: Date;
      homeTeam: string;
      awayTeam: string;
      league: string;
      status: string;
      homeScore: number | null;
      awayScore: number | null;
    };
  }>;
}

export interface CategoryView {
  category: CouponCategory;
  access: AccessLevel;
  /** Coupons the viewer is actually allowed to see. */
  coupons: UnlockedCoupon[];
  /** Aggregate for what is withheld; null when nothing is. */
  hidden: HiddenSummary | null;
}

/** Stake used to express "max winnings" in the locked view. */
export const REFERENCE_STAKE = 100;

export async function getFreePreviewPolicy(): Promise<FreePreviewPolicy> {
  const [category, count] = await Promise.all([
    getAppSetting<string>('access.freePreviewCategory', DEFAULT_FREE_PREVIEW.category),
    getAppSetting<number>('access.freePreviewCount', DEFAULT_FREE_PREVIEW.count),
  ]);

  return {
    category: (category as CouponCategory) ?? DEFAULT_FREE_PREVIEW.category,
    count: Number.isInteger(count) && count >= 0 ? count : DEFAULT_FREE_PREVIEW.count,
  };
}

const COUPON_SELECT = {
  id: true,
  reference: true,
  category: true,
  kind: true,
  systemCoupon: {
    select: {
      systemType: true,
      systemSizes: true,
      baseSelectionCount: true,
      columnCount: true,
      stakePerColumn: true,
      totalStake: true,
      maxReturn: true,
      totalReturn: true,
      winningColumns: true,
      currency: true,
    },
  },
  effectiveOdds: true,
  settledAt: true,
  totalOdds: true,
  estimatedProbability: true,
  expectedValue: true,
  confidenceScore: true,
  riskScore: true,
  resultStatus: true,
  targetDate: true,
  firstKickoffUtc: true,
  lastKickoffUtc: true,
  selections: {
    // Kickoff order, the way a slip reads: the match being played next is at
    // the top. sortOrder is the generator's assembly order, which is the order
    // the legs were picked in and means nothing to a reader.
    orderBy: { match: { scheduledKickoffUtc: 'asc' } },
    select: {
      id: true,
      marketCode: true,
      selectionCode: true,
      odds: true,
      probability: true,
      impliedProbability: true,
      edge: true,
      resultStatus: true,
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
  },
} as const;

type CouponRow = Awaited<ReturnType<typeof fetchCoupons>>[number];

async function fetchCoupons(
  category: CouponCategory,
  range: { from: Date; to: Date },
  take?: number,
) {
  return prisma.coupon.findMany({
    where: { category, targetDate: { gte: range.from, lte: range.to } },
    orderBy: [{ targetDate: 'asc' }, { score: 'desc' }],
    select: COUPON_SELECT,
    ...(take === undefined ? {} : { take }),
  });
}

function toUnlocked(coupon: CouponRow): UnlockedCoupon {
  return {
    id: coupon.id,
    reference: coupon.reference,
    category: coupon.category as CouponCategory,
    kind: coupon.kind,
    system: coupon.systemCoupon
      ? {
          systemType: coupon.systemCoupon.systemType,
          systemLabel: coupon.systemCoupon.systemSizes.join(','),
          systemSizes: coupon.systemCoupon.systemSizes,
          baseSelectionCount: coupon.systemCoupon.baseSelectionCount,
          columnCount: coupon.systemCoupon.columnCount,
          stakePerColumn: Number(coupon.systemCoupon.stakePerColumn),
          totalStake: Number(coupon.systemCoupon.totalStake),
          maxReturn: Number(coupon.systemCoupon.maxReturn),
          totalReturn: Number(coupon.systemCoupon.totalReturn),
          winningColumns: coupon.systemCoupon.winningColumns,
          currency: coupon.systemCoupon.currency,
        }
      : null,
    totalOdds: Number(coupon.totalOdds),
    estimatedProbability: Number(coupon.estimatedProbability),
    expectedValue: Number(coupon.expectedValue),
    confidenceScore: Number(coupon.confidenceScore),
    riskScore: Number(coupon.riskScore),
    resultStatus: coupon.resultStatus,
    effectiveOdds: coupon.effectiveOdds === null ? null : Number(coupon.effectiveOdds),
    settledAt: coupon.settledAt,
    targetDate: coupon.targetDate,
    firstKickoffUtc: coupon.firstKickoffUtc,
    lastKickoffUtc: coupon.lastKickoffUtc,
    selections: coupon.selections.map((selection) => ({
      id: selection.id,
      marketCode: selection.marketCode,
      selectionCode: selection.selectionCode,
      odds: Number(selection.odds),
      probability: Number(selection.probability),
      impliedProbability: Number(selection.impliedProbability),
      edge: Number(selection.edge),
      resultStatus: selection.resultStatus,
      match: {
        id: selection.match.id,
        kickoffUtc: selection.match.scheduledKickoffUtc,
        homeTeam: selection.match.homeTeam.name,
        awayTeam: selection.match.awayTeam.name,
        league: selection.match.league.name,
        status: selection.match.status,
        homeScore: selection.match.homeScore,
        awayScore: selection.match.awayScore,
      },
    })),
  };
}

/** Aggregate for withheld coupons. Selects no selection data at all. */
async function summariseHidden(
  category: CouponCategory,
  range: { from: Date; to: Date },
  skip: number,
): Promise<HiddenSummary> {
  const rows = await prisma.coupon.findMany({
    where: { category, targetDate: { gte: range.from, lte: range.to } },
    orderBy: [{ targetDate: 'asc' }, { score: 'desc' }],
    select: { totalOdds: true, selectionCount: true },
    skip,
  });

  const odds = rows.map((r) => dec(r.totalOdds));
  const best = odds.reduce((max, o) => (o.greaterThan(max) ? o : max), dec(0));
  const worst = odds.length > 0 ? odds.reduce((min, o) => (o.lessThan(min) ? o : min), odds[0]!) : null;

  return {
    count: rows.length,
    selectionCount: rows.reduce((sum, r) => sum + r.selectionCount, 0),
    minTotalOdds: worst ? Number(toOdds(worst).toFixed(2)) : null,
    maxTotalOdds: odds.length > 0 ? Number(toOdds(best).toFixed(2)) : null,
    maxPotentialReturn: Number(toMoney(best.times(REFERENCE_STAKE)).toFixed(2)),
    referenceStake: REFERENCE_STAKE,
    requiredPlan: requiredPlanFor(CATEGORY_FEATURE[category]),
  };
}

export async function getCategoryView(
  viewer: Viewer,
  category: CouponCategory,
  range: { from: Date; to: Date },
  preview?: FreePreviewPolicy,
): Promise<CategoryView> {
  // Admins operate the product and see every category unlocked.
  const entitled = viewer.isAdmin || canAccessCategory(viewer.entitlements, category);

  if (entitled) {
    const coupons = await fetchCoupons(category, range);
    return { category, access: 'full', coupons: coupons.map(toUnlocked), hidden: null };
  }

  const policy = preview ?? (await getFreePreviewPolicy());
  const previewCount = policy.category === category ? policy.count : 0;

  if (previewCount > 0) {
    const visible = await fetchCoupons(category, range, previewCount);
    const hidden = await summariseHidden(category, range, visible.length);
    return {
      category,
      access: 'preview',
      coupons: visible.map(toUnlocked),
      hidden: hidden.count > 0 ? hidden : null,
    };
  }

  return {
    category,
    access: 'locked',
    coupons: [],
    hidden: await summariseHidden(category, range, 0),
  };
}
