import Decimal from 'decimal.js';

/**
 * One shared Decimal configuration for the whole application.
 *
 * Money and odds never touch JavaScript floats (§26). 0.1 + 0.2 !== 0.3 is a
 * rounding error in a chart; in a 56-column system coupon it is a wrong payout.
 */
Decimal.set({
  precision: 34,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -21,
  toExpPos: 40,
});

export { Decimal };

export type DecimalInput = Decimal.Value;

/** Scale used when persisting monetary amounts (matches @db.Decimal(_, 2)). */
export const MONEY_DP = 2;
/** Scale used when persisting odds (matches @db.Decimal(_, 3)). */
export const ODDS_DP = 3;
/** Scale used when persisting probabilities (matches @db.Decimal(_, 8)). */
export const PROBABILITY_DP = 8;

export function dec(value: DecimalInput): Decimal {
  return new Decimal(value);
}

/** Rounds half-up to the money scale. Use before every DB write of a currency. */
export function toMoney(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(MONEY_DP, Decimal.ROUND_HALF_UP);
}

export function toOdds(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(ODDS_DP, Decimal.ROUND_HALF_UP);
}

export function toProbability(value: DecimalInput): Decimal {
  return dec(value).toDecimalPlaces(PROBABILITY_DP, Decimal.ROUND_HALF_UP);
}

/** Clamps into [0, 1]; guards against a model emitting 1.0000001. */
export function clampProbability(value: DecimalInput): Decimal {
  const d = dec(value);
  if (d.lessThan(0)) return dec(0);
  if (d.greaterThan(1)) return dec(1);
  return d;
}

export function isValidOdds(value: DecimalInput): boolean {
  const d = dec(value);
  return d.isFinite() && d.greaterThan(1);
}
