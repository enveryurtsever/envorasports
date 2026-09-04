import { describe, expect, it } from 'vitest';
import { dec } from '@/lib/math/decimal';
import { settlementMultiplier } from './settlement-service';
import type { SettlementOutcome } from '@/lib/settlement/types';

/**
 * The accumulator arithmetic behind coupon settlement (§33).
 * A leg's multiplier is how much of the stake it returns.
 */
describe('settlementMultiplier', () => {
  const odds = dec('2.00');

  it('pays full odds on a win and nothing on a loss', () => {
    expect(settlementMultiplier('WON', odds).toFixed(2)).toBe('2.00');
    expect(settlementMultiplier('LOST', odds).toFixed(2)).toBe('0.00');
  });

  it('neutralises a void or pushed leg instead of losing the coupon', () => {
    // §33: a void selection is removed from the accumulator, not counted lost.
    for (const status of ['VOID', 'PUSHED', 'CANCELED'] as SettlementOutcome[]) {
      expect(settlementMultiplier(status, odds).toFixed(2)).toBe('1.00');
    }
  });

  it('splits a quarter-line half win correctly', () => {
    // Half the stake wins at 2.00, half is returned: (2.00 + 1) / 2 = 1.50.
    expect(settlementMultiplier('HALF_WON', odds).toFixed(2)).toBe('1.50');
  });

  it('splits a quarter-line half loss correctly', () => {
    // Half the stake wins at 2.00, half is lost: 2.00 / 2 = 1.00 — stake back.
    expect(settlementMultiplier('HALF_LOST', odds).toFixed(2)).toBe('1.00');
  });

  it('orders the outcomes sensibly', () => {
    const won = settlementMultiplier('WON', odds);
    const halfWon = settlementMultiplier('HALF_WON', odds);
    const halfLost = settlementMultiplier('HALF_LOST', odds);
    const lost = settlementMultiplier('LOST', odds);

    expect(won.greaterThan(halfWon)).toBe(true);
    expect(halfWon.greaterThan(halfLost)).toBe(true);
    expect(halfLost.greaterThan(lost)).toBe(true);
  });

  it('leaves an unresolved leg neutral so a partial coupon is not mispriced', () => {
    expect(settlementMultiplier('PENDING', odds).toFixed(2)).toBe('1.00');
  });

  it('keeps a two-leg accumulator exact', () => {
    // 1.80 won x 2.50 won = 4.50
    const total = settlementMultiplier('WON', dec('1.80')).times(settlementMultiplier('WON', dec('2.50')));
    expect(total.toFixed(2)).toBe('4.50');

    // 1.80 won x void = 1.80: the void leg drops out cleanly.
    const withVoid = settlementMultiplier('WON', dec('1.80')).times(
      settlementMultiplier('VOID', dec('2.50')),
    );
    expect(withVoid.toFixed(2)).toBe('1.80');

    // Any losing leg zeroes the whole accumulator.
    const withLoss = settlementMultiplier('WON', dec('1.80')).times(
      settlementMultiplier('LOST', dec('2.50')),
    );
    expect(withLoss.toFixed(2)).toBe('0.00');
  });

  it('handles a half-win leg inside an accumulator', () => {
    // 2.00 won x 3.00 half-won = 2.00 x 2.00 = 4.00
    const total = settlementMultiplier('WON', dec('2.00')).times(
      settlementMultiplier('HALF_WON', dec('3.00')),
    );
    expect(total.toFixed(2)).toBe('4.00');
  });
});
