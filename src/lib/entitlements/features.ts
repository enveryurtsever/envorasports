/**
 * Centralised entitlements (§16, §23).
 *
 * Plan checks live here and nowhere else. A `if (plan === 'ELITE')` scattered
 * through a route handler is how a paywall ends up with a hole in it.
 */

export const FEATURE = {
  COUPON_HIGH_CONFIDENCE: 'COUPON_HIGH_CONFIDENCE',
  COUPON_BALANCED_PICKS: 'COUPON_BALANCED_PICKS',
  COUPON_HIGH_VALUE: 'COUPON_HIGH_VALUE',
  COUPON_COMBINATION_SYSTEM: 'COUPON_COMBINATION_SYSTEM',
} as const;

export type FeatureCode = (typeof FEATURE)[keyof typeof FEATURE];

export type PlanCode = 'PLUS' | 'PREMIUM' | 'ELITE';

export type CouponCategory =
  | 'HIGH_CONFIDENCE'
  | 'BALANCED_PICKS'
  | 'HIGH_VALUE'
  | 'COMBINATION_SYSTEM';

/** The §16 matrix: Plus < Premium < Elite, each a superset of the last. */
export const PLAN_FEATURES: Record<PlanCode, FeatureCode[]> = {
  PLUS: [FEATURE.COUPON_HIGH_CONFIDENCE],
  PREMIUM: [FEATURE.COUPON_HIGH_CONFIDENCE, FEATURE.COUPON_BALANCED_PICKS],
  ELITE: [
    FEATURE.COUPON_HIGH_CONFIDENCE,
    FEATURE.COUPON_BALANCED_PICKS,
    FEATURE.COUPON_HIGH_VALUE,
    FEATURE.COUPON_COMBINATION_SYSTEM,
  ],
};

export const CATEGORY_FEATURE: Record<CouponCategory, FeatureCode> = {
  HIGH_CONFIDENCE: FEATURE.COUPON_HIGH_CONFIDENCE,
  BALANCED_PICKS: FEATURE.COUPON_BALANCED_PICKS,
  HIGH_VALUE: FEATURE.COUPON_HIGH_VALUE,
  COMBINATION_SYSTEM: FEATURE.COUPON_COMBINATION_SYSTEM,
};

/** The cheapest plan that unlocks a feature — drives the upgrade CTA. */
export const PLAN_ORDER: PlanCode[] = ['PLUS', 'PREMIUM', 'ELITE'];

export function requiredPlanFor(feature: FeatureCode): PlanCode | null {
  return PLAN_ORDER.find((plan) => PLAN_FEATURES[plan].includes(feature)) ?? null;
}

export type SubscriptionStatus =
  | 'TRIALING'
  | 'ACTIVE'
  | 'PAST_DUE'
  | 'CANCELED'
  | 'UNPAID'
  | 'INCOMPLETE'
  | 'INCOMPLETE_EXPIRED';

export interface SubscriptionSnapshot {
  planCode: PlanCode;
  status: SubscriptionStatus;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface AccessDecision {
  active: boolean;
  planCode: PlanCode | null;
  features: FeatureCode[];
  reason:
    | 'no_subscription'
    | 'active'
    | 'trialing'
    | 'grace_period'
    | 'period_ended'
    | 'payment_failed'
    | 'incomplete';
}

const NO_ACCESS: AccessDecision = {
  active: false,
  planCode: null,
  features: [],
  reason: 'no_subscription',
};

/**
 * Pure access evaluation — no database, so it is exhaustively testable.
 *
 * `cancel_at_period_end` keeps access until the period actually ends (§16);
 * `past_due` keeps it too, because a failed card retry should not lock a paying
 * member out mid-period. Both stop the moment the period is over.
 */
export function evaluateAccess(
  subscription: SubscriptionSnapshot | null,
  now: Date = new Date(),
): AccessDecision {
  if (!subscription) return NO_ACCESS;

  const grant = (reason: AccessDecision['reason']): AccessDecision => ({
    active: true,
    planCode: subscription.planCode,
    features: PLAN_FEATURES[subscription.planCode],
    reason,
  });

  const periodStillOpen =
    subscription.currentPeriodEnd !== null && subscription.currentPeriodEnd.getTime() > now.getTime();

  switch (subscription.status) {
    case 'TRIALING':
      return periodStillOpen || subscription.currentPeriodEnd === null
        ? grant('trialing')
        : { ...NO_ACCESS, reason: 'period_ended' };

    case 'ACTIVE':
      // A null period end means "no end recorded"; treat it as open.
      return periodStillOpen || subscription.currentPeriodEnd === null
        ? grant(subscription.cancelAtPeriodEnd ? 'grace_period' : 'active')
        : { ...NO_ACCESS, reason: 'period_ended' };

    case 'PAST_DUE':
      return periodStillOpen
        ? grant('grace_period')
        : { ...NO_ACCESS, reason: 'payment_failed' };

    case 'CANCELED':
      // Stripe leaves the subscription ACTIVE until it truly ends, so CANCELED
      // normally means over. Honour a future period end defensively.
      return periodStillOpen ? grant('grace_period') : { ...NO_ACCESS, reason: 'period_ended' };

    case 'UNPAID':
      return { ...NO_ACCESS, reason: 'payment_failed' };

    case 'INCOMPLETE':
    case 'INCOMPLETE_EXPIRED':
      return { ...NO_ACCESS, reason: 'incomplete' };
  }
}

export function hasFeature(decision: AccessDecision, feature: FeatureCode): boolean {
  return decision.active && decision.features.includes(feature);
}

export function canAccessCategory(decision: AccessDecision, category: CouponCategory): boolean {
  return hasFeature(decision, CATEGORY_FEATURE[category]);
}

/**
 * The free shop window.
 *
 * Visitors without a membership see a couple of real predictions from the entry
 * category, so the product can be judged before it is bought. Everything else
 * stays server-side behind the paywall (§23).
 */
export interface FreePreviewPolicy {
  category: CouponCategory;
  count: number;
}

export const DEFAULT_FREE_PREVIEW: FreePreviewPolicy = {
  category: 'HIGH_CONFIDENCE',
  count: 2,
};
