import { prisma } from '@/lib/db/prisma';
import {
  CATEGORY_FEATURE,
  evaluateAccess,
  hasFeature,
  requiredPlanFor,
  type AccessDecision,
  type CouponCategory,
  type FeatureCode,
  type PlanCode,
  type SubscriptionStatus,
} from './features';

/**
 * Database-backed entitlement service (§16).
 *
 * These are the only functions a route handler should call. The UI may also
 * hide locked content, but this layer is what actually keeps it out of the
 * JSON response (§23).
 */

export class UnauthenticatedError extends Error {
  readonly status = 401;
  constructor() {
    super('Authentication required');
    this.name = 'UnauthenticatedError';
  }
}

export class ForbiddenError extends Error {
  readonly status = 403;
  constructor(
    readonly feature: FeatureCode,
    readonly requiredPlan: PlanCode | null,
  ) {
    super(`Missing entitlement ${feature}`);
    this.name = 'ForbiddenError';
  }
}

/** Statuses that could still grant access; anything else can be skipped. */
const CANDIDATE_STATUSES: SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED'];

export async function getCurrentSubscription(userId: string) {
  return prisma.subscription.findFirst({
    where: { userId, status: { in: CANDIDATE_STATUSES } },
    include: { plan: true },
    // The most recently started subscription wins if data is ever ambiguous.
    orderBy: [{ currentPeriodEnd: 'desc' }, { createdAt: 'desc' }],
  });
}

export async function getUserEntitlements(
  userId: string | null,
  now: Date = new Date(),
): Promise<AccessDecision> {
  if (!userId) return evaluateAccess(null, now);

  const subscription = await getCurrentSubscription(userId);
  if (!subscription) return evaluateAccess(null, now);

  return evaluateAccess(
    {
      planCode: subscription.plan.code as PlanCode,
      status: subscription.status as SubscriptionStatus,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    },
    now,
  );
}

export async function canAccessCouponType(
  userId: string | null,
  couponType: CouponCategory,
): Promise<boolean> {
  const decision = await getUserEntitlements(userId);
  return hasFeature(decision, CATEGORY_FEATURE[couponType]);
}

/**
 * Throws 401 when signed out and 403 when the plan is insufficient, which maps
 * straight onto the status codes §23 requires.
 */
export async function requireEntitlement(
  userId: string | null,
  feature: FeatureCode,
): Promise<AccessDecision> {
  if (!userId) throw new UnauthenticatedError();

  const decision = await getUserEntitlements(userId);
  if (!hasFeature(decision, feature)) {
    throw new ForbiddenError(feature, requiredPlanFor(feature));
  }
  return decision;
}

/** Categories the caller may actually be served, for list endpoints. */
export async function accessibleCategories(userId: string | null): Promise<CouponCategory[]> {
  const decision = await getUserEntitlements(userId);
  return (Object.keys(CATEGORY_FEATURE) as CouponCategory[]).filter((category) =>
    hasFeature(decision, CATEGORY_FEATURE[category]),
  );
}
