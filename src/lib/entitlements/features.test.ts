import { describe, expect, it } from 'vitest';
import {
  FEATURE,
  PLAN_FEATURES,
  canAccessCategory,
  evaluateAccess,
  hasFeature,
  requiredPlanFor,
  type PlanCode,
  type SubscriptionSnapshot,
  type SubscriptionStatus,
} from './features';

const NOW = new Date('2026-09-04T12:00:00Z');
const FUTURE = new Date('2026-10-01T00:00:00Z');
const PAST = new Date('2026-08-01T00:00:00Z');

function sub(
  planCode: PlanCode,
  status: SubscriptionStatus,
  overrides: Partial<SubscriptionSnapshot> = {},
): SubscriptionSnapshot {
  return {
    planCode,
    status,
    currentPeriodEnd: FUTURE,
    cancelAtPeriodEnd: false,
    ...overrides,
  };
}

describe('plan matrix (§16)', () => {
  const cases: Array<[PlanCode, Record<string, boolean>]> = [
    ['PLUS', { HIGH_CONFIDENCE: true, BALANCED_PICKS: false, HIGH_VALUE: false, COMBINATION_SYSTEM: false }],
    ['PREMIUM', { HIGH_CONFIDENCE: true, BALANCED_PICKS: true, HIGH_VALUE: false, COMBINATION_SYSTEM: false }],
    ['ELITE', { HIGH_CONFIDENCE: true, BALANCED_PICKS: true, HIGH_VALUE: true, COMBINATION_SYSTEM: true }],
  ];

  for (const [plan, expectations] of cases) {
    it(`grants ${plan} exactly its documented categories`, () => {
      const decision = evaluateAccess(sub(plan, 'ACTIVE'), NOW);
      for (const [category, expected] of Object.entries(expectations)) {
        expect(canAccessCategory(decision, category as never)).toBe(expected);
      }
    });
  }

  it('makes each tier a superset of the one below', () => {
    expect(PLAN_FEATURES.PREMIUM).toEqual(expect.arrayContaining(PLAN_FEATURES.PLUS));
    expect(PLAN_FEATURES.ELITE).toEqual(expect.arrayContaining(PLAN_FEATURES.PREMIUM));
  });

  it('names the cheapest plan that unlocks a feature', () => {
    expect(requiredPlanFor(FEATURE.COUPON_HIGH_CONFIDENCE)).toBe('PLUS');
    expect(requiredPlanFor(FEATURE.COUPON_BALANCED_PICKS)).toBe('PREMIUM');
    expect(requiredPlanFor(FEATURE.COUPON_HIGH_VALUE)).toBe('ELITE');
    expect(requiredPlanFor(FEATURE.COUPON_COMBINATION_SYSTEM)).toBe('ELITE');
  });
});

describe('subscription lifecycle', () => {
  it('denies everything without a subscription', () => {
    const decision = evaluateAccess(null, NOW);
    expect(decision.active).toBe(false);
    expect(decision.features).toEqual([]);
    expect(decision.reason).toBe('no_subscription');
  });

  it('grants access during a trial', () => {
    expect(evaluateAccess(sub('ELITE', 'TRIALING'), NOW).active).toBe(true);
  });

  it('keeps access until the period ends when cancel_at_period_end is set', () => {
    const decision = evaluateAccess(sub('PREMIUM', 'ACTIVE', { cancelAtPeriodEnd: true }), NOW);
    expect(decision.active).toBe(true);
    expect(decision.reason).toBe('grace_period');
  });

  it('revokes access once the period has passed', () => {
    const decision = evaluateAccess(sub('PREMIUM', 'ACTIVE', { currentPeriodEnd: PAST }), NOW);
    expect(decision.active).toBe(false);
    expect(decision.reason).toBe('period_ended');
  });

  it('keeps a past_due member in during the current period but not after', () => {
    expect(evaluateAccess(sub('PLUS', 'PAST_DUE'), NOW).active).toBe(true);
    expect(evaluateAccess(sub('PLUS', 'PAST_DUE', { currentPeriodEnd: PAST }), NOW).active).toBe(false);
  });

  it('denies unpaid and incomplete subscriptions outright', () => {
    for (const status of ['UNPAID', 'INCOMPLETE', 'INCOMPLETE_EXPIRED'] as const) {
      expect(evaluateAccess(sub('ELITE', status), NOW).active).toBe(false);
    }
  });

  it('denies a canceled subscription whose period is over', () => {
    expect(evaluateAccess(sub('ELITE', 'CANCELED', { currentPeriodEnd: PAST }), NOW).active).toBe(false);
  });
});

describe('feature checks', () => {
  it('never leaks a feature from an inactive decision', () => {
    const expired = evaluateAccess(sub('ELITE', 'ACTIVE', { currentPeriodEnd: PAST }), NOW);
    expect(hasFeature(expired, FEATURE.COUPON_HIGH_CONFIDENCE)).toBe(false);
  });
});
