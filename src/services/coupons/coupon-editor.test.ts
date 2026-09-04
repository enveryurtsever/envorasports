import { describe, expect, it } from 'vitest';
import { dec } from '@/lib/math/decimal';
import { DEFAULT_SCORING_WEIGHTS } from '@/lib/config/coupon-settings';
import { computeTotals, type SelectionForTotals } from './coupon-editor';

function leg(overrides: Partial<SelectionForTotals> = {}): SelectionForTotals {
  return {
    matchId: overrides.matchId ?? 'm1',
    marketCode: overrides.marketCode ?? 'MATCH_RESULT',
    selectionCode: overrides.selectionCode ?? 'MS_1',
    odds: overrides.odds ?? dec('2.00'),
    probability: overrides.probability ?? dec('0.55'),
    confidence: overrides.confidence ?? 0.7,
    risk: overrides.risk ?? 0.3,
    kickoffUtc: overrides.kickoffUtc ?? new Date('2026-09-05T18:00:00Z'),
  };
}

describe('computeTotals', () => {
  it('multiplies the odds of every leg', () => {
    const totals = computeTotals(
      [
        leg({ matchId: 'a', odds: dec('1.50') }),
        leg({ matchId: 'b', odds: dec('2.00') }),
        leg({ matchId: 'c', odds: dec('3.00') }),
      ],
      0,
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(totals.totalOdds.toFixed(2)).toBe('9.00');
    expect(totals.selectionCount).toBe(3);
  });

  it('recomputes correctly after a leg is removed', () => {
    const three = [
      leg({ matchId: 'a', odds: dec('1.50') }),
      leg({ matchId: 'b', odds: dec('2.00') }),
      leg({ matchId: 'c', odds: dec('3.00') }),
    ];
    const two = three.slice(0, 2);

    expect(computeTotals(three, 0, DEFAULT_SCORING_WEIGHTS).totalOdds.toFixed(2)).toBe('9.00');
    // Dropping the 3.00 leg must land exactly on 3.00, not 9.00 minus something.
    expect(computeTotals(two, 0, DEFAULT_SCORING_WEIGHTS).totalOdds.toFixed(2)).toBe('3.00');
  });

  it('multiplies probabilities and discounts for correlation', () => {
    const legs = [
      leg({ matchId: 'a', probability: dec('0.60') }),
      leg({ matchId: 'b', probability: dec('0.50') }),
    ];

    const independent = computeTotals(legs, 0, DEFAULT_SCORING_WEIGHTS);
    expect(Number(independent.estimatedProbability)).toBeCloseTo(0.3, 8);

    // 0.8 correlation removes 20% of the naive probability.
    const correlated = computeTotals(legs, 0.8, DEFAULT_SCORING_WEIGHTS);
    expect(Number(correlated.estimatedProbability)).toBeCloseTo(0.3 * 0.8, 8);
    expect(Number(correlated.estimatedProbability)).toBeLessThan(
      Number(independent.estimatedProbability),
    );
  });

  it('derives expected value from the recomputed totals', () => {
    const legs = [
      leg({ matchId: 'a', odds: dec('2.00'), probability: dec('0.60') }),
      leg({ matchId: 'b', odds: dec('2.00'), probability: dec('0.60') }),
    ];
    const totals = computeTotals(legs, 0, DEFAULT_SCORING_WEIGHTS);

    // 0.36 probability at 4.00 odds -> 0.44 EV per unit staked.
    expect(totals.totalOdds.toFixed(2)).toBe('4.00');
    expect(Number(totals.expectedValue)).toBeCloseTo(0.44, 8);
  });

  it('averages confidence and risk across the legs', () => {
    const totals = computeTotals(
      [
        leg({ matchId: 'a', confidence: 0.8, risk: 0.2 }),
        leg({ matchId: 'b', confidence: 0.6, risk: 0.4 }),
      ],
      0,
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(totals.confidence).toBeCloseTo(0.7, 8);
    expect(totals.risk).toBeCloseTo(0.3, 8);
  });

  it('rewards a mix of markets in the diversification score', () => {
    const same = computeTotals(
      [leg({ matchId: 'a' }), leg({ matchId: 'b' })],
      0,
      DEFAULT_SCORING_WEIGHTS,
    );
    const mixed = computeTotals(
      [leg({ matchId: 'a' }), leg({ matchId: 'b', marketCode: 'OVER_UNDER' })],
      0,
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(mixed.diversification).toBeGreaterThan(same.diversification);
  });

  it('tracks the kickoff window across the legs', () => {
    const totals = computeTotals(
      [
        leg({ matchId: 'a', kickoffUtc: new Date('2026-09-05T12:00:00Z') }),
        leg({ matchId: 'b', kickoffUtc: new Date('2026-09-05T20:00:00Z') }),
      ],
      0,
      DEFAULT_SCORING_WEIGHTS,
    );

    expect(totals.firstKickoffUtc?.toISOString()).toBe('2026-09-05T12:00:00.000Z');
    expect(totals.lastKickoffUtc?.toISOString()).toBe('2026-09-05T20:00:00.000Z');
  });

  it('returns a safe empty result rather than NaN', () => {
    const totals = computeTotals([], 0, DEFAULT_SCORING_WEIGHTS);

    expect(totals.totalOdds.toFixed(2)).toBe('1.00');
    expect(totals.selectionCount).toBe(0);
    expect(Number.isFinite(totals.score)).toBe(true);
    expect(totals.firstKickoffUtc).toBeNull();
  });

  it('keeps odds exact where floats would drift', () => {
    // 1.1 * 1.1 * 1.1 is 1.3310000000000004 in IEEE-754.
    const totals = computeTotals(
      [
        leg({ matchId: 'a', odds: dec('1.10') }),
        leg({ matchId: 'b', odds: dec('1.10') }),
        leg({ matchId: 'c', odds: dec('1.10') }),
      ],
      0,
      DEFAULT_SCORING_WEIGHTS,
    );
    expect(totals.totalOdds.toFixed(3)).toBe('1.331');
  });
});
