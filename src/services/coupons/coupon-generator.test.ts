import { describe, expect, it } from 'vitest';
import { dec } from '@/lib/math/decimal';
import { DEFAULT_CATEGORY_SETTINGS, DEFAULT_SCORING_WEIGHTS } from '@/lib/config/coupon-settings';
import {
  buildCategoryCoupons,
  buildCoupon,
  expectedColumnProbability,
  filterForCategory,
  type Candidate,
} from './coupon-generator';
import type { CorrelationMatrix, SelectionRef } from './correlation';

/** A matrix with no rules: only the same-match baseline applies. */
const baselineMatrix: CorrelationMatrix = {
  rules: 0,
  between: (a: SelectionRef, b: SelectionRef) => (a.matchId === b.matchId ? 0.35 : 0),
};

function candidate(overrides: Partial<Candidate> & { id: string }): Candidate {
  const kickoff = new Date('2026-09-05T18:00:00Z');
  return {
    predictionId: overrides.id,
    matchId: overrides.matchId ?? `match-${overrides.id}`,
    marketCode: overrides.marketCode ?? 'MATCH_RESULT',
    selectionCode: overrides.selectionCode ?? 'MS_1',
    odds: overrides.odds ?? dec('1.80'),
    probability: overrides.probability ?? dec('0.62'),
    impliedProbability: overrides.impliedProbability ?? dec('0.5556'),
    edge: overrides.edge ?? dec('0.064'),
    expectedValue: overrides.expectedValue ?? dec('0.116'),
    confidence: overrides.confidence ?? 0.75,
    risk: overrides.risk ?? 0.3,
    dataQuality: overrides.dataQuality ?? 0.8,
    kickoffUtc: overrides.kickoffUtc ?? kickoff,
    targetDate: overrides.targetDate ?? '2026-09-05',
  };
}

// The shipped Balanced settings now carry a 0.55 floor on the whole coupon.
// These fixtures use small, made-up probabilities to exercise the assembly
// rules, so the floor is relaxed here and tested on its own below.
const balanced = { ...DEFAULT_CATEGORY_SETTINGS.BALANCED_PICKS, minCombinedProbability: 0 };

describe('filterForCategory', () => {
  it('drops candidates below the configured thresholds', () => {
    const pool = [
      candidate({ id: 'ok' }),
      candidate({ id: 'low-prob', probability: dec('0.10') }),
      candidate({ id: 'low-conf', confidence: 0.2 }),
      candidate({ id: 'high-risk', risk: 0.95 }),
      candidate({ id: 'poor-data', dataQuality: 0.1 }),
      candidate({ id: 'no-edge', edge: dec('0.001'), expectedValue: dec('0.001') }),
    ];

    const kept = filterForCategory(pool, balanced).map((c) => c.predictionId);
    expect(kept).toEqual(['ok']);
  });

  it('honours an allowed-markets whitelist', () => {
    const pool = [
      candidate({ id: 'a', marketCode: 'MATCH_RESULT' }),
      candidate({ id: 'b', marketCode: 'CORRECT_SCORE' }),
    ];

    const restricted = { ...balanced, allowedMarkets: ['MATCH_RESULT'] };
    expect(filterForCategory(pool, restricted).map((c) => c.predictionId)).toEqual(['a']);
  });

  it('treats an empty whitelist as every market', () => {
    const pool = [candidate({ id: 'a', marketCode: 'CORRECT_SCORE' })];
    expect(filterForCategory(pool, balanced)).toHaveLength(1);
  });
});

describe('buildCoupon', () => {
  const pool = Array.from({ length: 6 }, (_, i) => candidate({ id: `c${i}` }));
  const strategy = { name: 'highest_ev', rank: (c: Candidate) => Number(c.expectedValue) } as const;

  it('respects the odds band', () => {
    const coupon = buildCoupon(
      pool,
      balanced,
      baselineMatrix,
      strategy,
      new Set(),
      new Set(),
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(coupon).not.toBeNull();
    expect(Number(coupon!.totalOdds)).toBeGreaterThanOrEqual(balanced.minTotalOdds);
    expect(Number(coupon!.totalOdds)).toBeLessThanOrEqual(balanced.maxTotalOdds!);
  });

  it('never puts two selections on the same match when configured not to', () => {
    const sameMatch = Array.from({ length: 5 }, (_, i) =>
      candidate({ id: `s${i}`, matchId: 'one-match', selectionCode: `SEL_${i}` }),
    );

    const coupon = buildCoupon(
      sameMatch,
      balanced,
      baselineMatrix,
      strategy,
      new Set(),
      new Set(),
      DEFAULT_SCORING_WEIGHTS,
    );

    // Only one leg is usable, which is below the minimum, so nothing is built
    // rather than a coupon that breaks the rule.
    expect(coupon).toBeNull();
  });

  it('allows several legs from one match when the rule is switched off', () => {
    const sameMatch = Array.from({ length: 5 }, (_, i) =>
      candidate({ id: `s${i}`, matchId: 'one-match', selectionCode: `SEL_${i}` }),
    );

    const coupon = buildCoupon(
      sameMatch,
      { ...balanced, oneSelectionPerMatch: false, maxCorrelation: 0.9 },
      baselineMatrix,
      strategy,
      new Set(),
      new Set(),
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(coupon).not.toBeNull();
    expect(coupon!.selections.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects a candidate that is too correlated with what is already picked', () => {
    const everythingCorrelated: CorrelationMatrix = { rules: 1, between: () => 0.99 };

    const coupon = buildCoupon(
      pool,
      balanced,
      everythingCorrelated,
      strategy,
      new Set(),
      new Set(),
      DEFAULT_SCORING_WEIGHTS,
    );

    // The first leg is free; every subsequent one is blocked, so the minimum
    // selection count cannot be met.
    expect(coupon).toBeNull();
  });

  it('discounts the combined probability for correlation', () => {
    const independent = buildCoupon(
      pool, balanced, { rules: 0, between: () => 0 }, strategy,
      new Set(), new Set(), DEFAULT_SCORING_WEIGHTS,
    );
    const correlated = buildCoupon(
      pool, { ...balanced, maxCorrelation: 0.9 }, { rules: 1, between: () => 0.8 }, strategy,
      new Set(), new Set(), DEFAULT_SCORING_WEIGHTS,
    );

    expect(independent).not.toBeNull();
    expect(correlated).not.toBeNull();
    // Same legs, but correlated ones are less likely to all land.
    expect(Number(correlated!.estimatedProbability)).toBeLessThan(
      Number(independent!.estimatedProbability),
    );
  });

  it('returns null when the odds floor cannot be reached', () => {
    const shortPrices = Array.from({ length: 4 }, (_, i) =>
      candidate({ id: `p${i}`, odds: dec('1.05'), probability: dec('0.95') }),
    );

    const coupon = buildCoupon(
      shortPrices,
      { ...balanced, minTotalOdds: 10, maxSelections: 2 },
      baselineMatrix,
      strategy,
      new Set(),
      new Set(),
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(coupon).toBeNull();
  });

  it('never exceeds the maximum selection count', () => {
    // Spread across markets: no market may fill more than its share of a
    // coupon, so twenty legs of one market cannot build a three-leg coupon.
    const markets = ['MATCH_RESULT', 'OVER_UNDER', 'DOUBLE_CHANCE', 'BTTS'];
    const many = Array.from({ length: 20 }, (_, i) =>
      candidate({ id: `m${i}`, odds: dec('1.05'), marketCode: markets[i % markets.length] }),
    );
    const coupon = buildCoupon(
      many,
      { ...balanced, minTotalOdds: 1.01, maxSelections: 3 },
      baselineMatrix,
      strategy,
      new Set(),
      new Set(),
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(coupon!.selections.length).toBeLessThanOrEqual(3);
  });
});

describe('buildCategoryCoupons', () => {
  it('produces distinct coupons rather than five copies (§32)', () => {
    const pool = Array.from({ length: 24 }, (_, i) =>
      candidate({
        id: `c${i}`,
        matchId: `match-${i}`,
        marketCode: i % 2 === 0 ? 'MATCH_RESULT' : 'OVER_UNDER',
        expectedValue: dec((0.2 - i * 0.004).toFixed(4)),
        confidence: 0.9 - i * 0.01,
        risk: 0.2 + i * 0.01,
      }),
    );

    const { coupons } = buildCategoryCoupons(
      pool,
      balanced,
      baselineMatrix,
      DEFAULT_SCORING_WEIGHTS,
      ['2026-09-05'],
    );

    expect(coupons.length).toBeGreaterThan(1);

    const signatures = coupons.map((c) =>
      c.selections.map((s) => s.predictionId).sort().join('|'),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
  });

  it('never exceeds the configured count', () => {
    const pool = Array.from({ length: 40 }, (_, i) =>
      candidate({ id: `c${i}`, matchId: `m${i}` }),
    );

    const { coupons } = buildCategoryCoupons(
      pool,
      { ...balanced, couponCount: 3 },
      baselineMatrix,
      DEFAULT_SCORING_WEIGHTS,
      ['2026-09-05'],
    );

    expect(coupons.length).toBeLessThanOrEqual(3);
  });

  it('reports why a category came up short instead of padding it (§30.7)', () => {
    const { coupons, shortfallReason } = buildCategoryCoupons(
      [candidate({ id: 'only', probability: dec('0.01') })],
      balanced,
      baselineMatrix,
      DEFAULT_SCORING_WEIGHTS,
      ['2026-09-05'],
    );

    expect(coupons).toHaveLength(0);
    expect(shortfallReason).toBe('no_candidate_met_thresholds');
  });

  it('spreads coupons across the days in the window', () => {
    const pool = [
      ...Array.from({ length: 8 }, (_, i) =>
        candidate({ id: `fri${i}`, matchId: `f${i}`, targetDate: '2026-09-05' }),
      ),
      ...Array.from({ length: 8 }, (_, i) =>
        candidate({ id: `sat${i}`, matchId: `s${i}`, targetDate: '2026-09-06' }),
      ),
    ];

    const { coupons } = buildCategoryCoupons(
      pool,
      { ...balanced, couponCount: 4 },
      baselineMatrix,
      DEFAULT_SCORING_WEIGHTS,
      ['2026-09-05', '2026-09-06'],
    );

    const days = new Set(coupons.map((c) => c.targetDate));
    expect(days.size).toBe(2);
  });
});

describe('expectedColumnProbability', () => {
  it('is the per-column chance, not the whole base set', () => {
    const legs = Array.from({ length: 8 }, () => 0.6);

    // All eight landing is ~1.7%; any given 3-leg column is ~21.6%.
    expect(expectedColumnProbability(legs, 8)).toBeCloseTo(0.6 ** 8, 6);
    expect(expectedColumnProbability(legs, 3)).toBeCloseTo(0.216, 3);
    expect(expectedColumnProbability(legs, 3)).toBeGreaterThan(expectedColumnProbability(legs, 8));
  });

  it('falls as the system size grows', () => {
    const legs = [0.7, 0.65, 0.6, 0.55, 0.5, 0.62];
    expect(expectedColumnProbability(legs, 2)).toBeGreaterThan(expectedColumnProbability(legs, 4));
  });

  it('is safe on degenerate input', () => {
    expect(expectedColumnProbability([], 3)).toBe(0);
    expect(expectedColumnProbability([0.5], 0)).toBe(0);
    expect(expectedColumnProbability([0, 0], 2)).toBe(0);
  });
});

describe('minCombinedProbability', () => {
  const strategy = { name: 'highest_ev', rank: (c: Candidate) => Number(c.expectedValue) } as const;

  it('rejects a coupon whose legs cannot land together often enough', () => {
    // Two legs at 0.45 land together 20% of the time. A category asking for 55%
    // must not be handed it, however good each leg looks on its own.
    const pool = [
      candidate({ id: 'a', probability: dec('0.45'), odds: dec('2.20') }),
      candidate({ id: 'b', matchId: 'm2', probability: dec('0.45'), odds: dec('2.20') }),
    ];
    const settings = { ...balanced, minCombinedProbability: 0.55, minTotalOdds: 1.1 };

    expect(
      buildCoupon(pool, settings, baselineMatrix, strategy, new Set(), new Set(), DEFAULT_SCORING_WEIGHTS),
    ).toBeNull();

    // The same pool passes once the floor is one it can actually meet.
    expect(
      buildCoupon(
        pool,
        { ...settings, minCombinedProbability: 0.15 },
        baselineMatrix,
        strategy,
        new Set(),
        new Set(),
        DEFAULT_SCORING_WEIGHTS,
      ),
    ).not.toBeNull();
  });
});

describe('market mix', () => {
  const strategy = { name: 'highest_ev', rank: (c: Candidate) => Number(c.expectedValue) } as const;

  it('will not build a short coupon out of one market', () => {
    // Two legs of Asian handicap is one idea twice. A short coupon has to mix.
    const oneMarket = [
      candidate({ id: 'a', marketCode: 'ASIAN_HANDICAP' }),
      candidate({ id: 'b', matchId: 'm2', marketCode: 'ASIAN_HANDICAP' }),
    ];
    const settings = { ...balanced, maxSelections: 2, minTotalOdds: 1.1 };

    expect(
      buildCoupon(oneMarket, settings, baselineMatrix, strategy, new Set(), new Set(), DEFAULT_SCORING_WEIGHTS),
    ).toBeNull();

    const mixed = [
      candidate({ id: 'a', marketCode: 'ASIAN_HANDICAP' }),
      candidate({ id: 'b', matchId: 'm2', marketCode: 'OVER_UNDER' }),
    ];
    expect(
      buildCoupon(mixed, settings, baselineMatrix, strategy, new Set(), new Set(), DEFAULT_SCORING_WEIGHTS),
    ).not.toBeNull();
  });
});
