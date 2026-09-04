import { Decimal, clampProbability, dec, isValidOdds, type DecimalInput } from './decimal';

/**
 * The value formulas from §25. Everything downstream — candidate ranking,
 * coupon scoring, backtest metrics — reduces to these four.
 */

/** implied_probability = 1 / odds */
export function impliedProbability(odds: DecimalInput): Decimal {
  if (!isValidOdds(odds)) {
    throw new RangeError(`Decimal odds must be > 1, received ${dec(odds).toString()}`);
  }
  return dec(1).dividedBy(dec(odds));
}

/** edge = model_probability - implied_probability */
export function edge(modelProbability: DecimalInput, odds: DecimalInput): Decimal {
  return clampProbability(modelProbability).minus(impliedProbability(odds));
}

/** EV = (model_probability * odds) - 1, per unit staked. */
export function expectedValue(modelProbability: DecimalInput, odds: DecimalInput): Decimal {
  if (!isValidOdds(odds)) {
    throw new RangeError(`Decimal odds must be > 1, received ${dec(odds).toString()}`);
  }
  return clampProbability(modelProbability).times(dec(odds)).minus(1);
}

/** Fair (vig-free) odds for a probability. */
export function fairOdds(probability: DecimalInput): Decimal {
  const p = clampProbability(probability);
  if (p.isZero()) {
    throw new RangeError('Cannot derive fair odds for probability 0');
  }
  return dec(1).dividedBy(p);
}

/**
 * Bookmaker margin ("overround") of a complete market.
 * A 1X2 market priced 2.00 / 3.50 / 4.00 sums to 1.036 → 3.6% margin.
 */
export function bookmakerMargin(oddsList: readonly DecimalInput[]): Decimal {
  if (oddsList.length === 0) {
    throw new RangeError('bookmakerMargin requires at least one price');
  }
  const sum = oddsList.reduce<Decimal>((acc, o) => acc.plus(impliedProbability(o)), dec(0));
  return sum.minus(1);
}

/**
 * Removes the vig proportionally so implied probabilities sum to 1.
 *
 * This is the "multiplicative" method — the simplest defensible one. It is not
 * the most accurate for longshots (favourite-longshot bias); swapping in Shin
 * or power methods later only changes this function.
 */
export function removeVig(oddsList: readonly DecimalInput[]): Decimal[] {
  const raw = oddsList.map((o) => impliedProbability(o));
  const total = raw.reduce<Decimal>((acc, p) => acc.plus(p), dec(0));
  if (total.isZero()) {
    throw new RangeError('Cannot remove vig from a market with zero total probability');
  }
  return raw.map((p) => p.dividedBy(total));
}

/** Rescales a probability vector so it sums to exactly 1. */
export function normalize(probabilities: readonly DecimalInput[]): Decimal[] {
  const values = probabilities.map((p) => clampProbability(p));
  const total = values.reduce<Decimal>((acc, p) => acc.plus(p), dec(0));
  if (total.isZero()) {
    // Degenerate input: fall back to a uniform distribution rather than NaN.
    const uniform = dec(1).dividedBy(values.length);
    return values.map(() => uniform);
  }
  return values.map((p) => p.dividedBy(total));
}

/**
 * Combined probability of independent selections.
 *
 * NOTE: real selections are not independent (§33). The coupon engine applies a
 * correlation adjustment on top of this; this function is the naive baseline.
 */
export function combinedProbability(probabilities: readonly DecimalInput[]): Decimal {
  return probabilities.reduce<Decimal>((acc, p) => acc.times(clampProbability(p)), dec(1));
}

/** Accumulator odds = product of the individual prices. */
export function combinedOdds(oddsList: readonly DecimalInput[]): Decimal {
  return oddsList.reduce<Decimal>((acc, o) => {
    if (!isValidOdds(o)) {
      throw new RangeError(`Decimal odds must be > 1, received ${dec(o).toString()}`);
    }
    return acc.times(dec(o));
  }, dec(1));
}

// ---------------------------------------------------------------------------
// Scoring metrics used by the backtest engine (§36)
// ---------------------------------------------------------------------------

/** Brier score for a binary outcome. Lower is better; 0 is perfect. */
export function brierScore(probability: DecimalInput, outcome: boolean): Decimal {
  const p = clampProbability(probability);
  const y = outcome ? dec(1) : dec(0);
  return p.minus(y).pow(2);
}

/**
 * Negative log-likelihood for a binary outcome. Clipped away from 0 and 1 so a
 * single confident miss cannot return Infinity and poison the average.
 */
export function logLoss(probability: DecimalInput, outcome: boolean, epsilon = 1e-15): Decimal {
  const eps = dec(epsilon);
  const p = Decimal.max(eps, Decimal.min(dec(1).minus(eps), clampProbability(probability)));
  return outcome ? dec(-1).times(Decimal.ln(p)) : dec(-1).times(Decimal.ln(dec(1).minus(p)));
}

// ---------------------------------------------------------------------------
// Poisson helpers — the backbone of the goals model (§26)
// ---------------------------------------------------------------------------

/** P(X = k) for X ~ Poisson(lambda). */
export function poissonPmf(k: number, lambda: DecimalInput): Decimal {
  if (!Number.isInteger(k) || k < 0) {
    throw new RangeError(`k must be a non-negative integer, received ${k}`);
  }
  const l = dec(lambda);
  if (l.isNegative()) {
    throw new RangeError(`lambda must be >= 0, received ${l.toString()}`);
  }
  if (l.isZero()) return k === 0 ? dec(1) : dec(0);

  // exp(-lambda) * lambda^k / k!
  let logResult = l.negated().plus(l.ln().times(k));
  for (let i = 2; i <= k; i++) {
    logResult = logResult.minus(dec(i).ln());
  }
  return logResult.exp();
}

/** P(X <= k). */
export function poissonCdf(k: number, lambda: DecimalInput): Decimal {
  let total = dec(0);
  for (let i = 0; i <= k; i++) {
    total = total.plus(poissonPmf(i, lambda));
  }
  return Decimal.min(total, dec(1));
}

/**
 * Joint score distribution for independent home/away Poisson processes.
 * Returns `matrix[home][away]`, truncated at `maxGoals` and renormalised so the
 * lost tail mass does not silently disappear.
 */
export function scoreMatrix(
  lambdaHome: DecimalInput,
  lambdaAway: DecimalInput,
  maxGoals = 10,
): Decimal[][] {
  const homePmf = Array.from({ length: maxGoals + 1 }, (_, i) => poissonPmf(i, lambdaHome));
  const awayPmf = Array.from({ length: maxGoals + 1 }, (_, i) => poissonPmf(i, lambdaAway));

  const matrix: Decimal[][] = [];
  let total = dec(0);
  for (let h = 0; h <= maxGoals; h++) {
    const row: Decimal[] = [];
    for (let a = 0; a <= maxGoals; a++) {
      const p = (homePmf[h] as Decimal).times(awayPmf[a] as Decimal);
      row.push(p);
      total = total.plus(p);
    }
    matrix.push(row);
  }

  if (total.isZero()) return matrix;
  return matrix.map((row) => row.map((p) => p.dividedBy(total)));
}

/** Sums every cell of a score matrix that satisfies `predicate(home, away)`. */
export function marginalise(
  matrix: readonly (readonly Decimal[])[],
  predicate: (homeGoals: number, awayGoals: number) => boolean,
): Decimal {
  let total = dec(0);
  for (let h = 0; h < matrix.length; h++) {
    const row = matrix[h];
    if (!row) continue;
    for (let a = 0; a < row.length; a++) {
      if (predicate(h, a)) {
        total = total.plus(row[a] as Decimal);
      }
    }
  }
  return clampProbability(total);
}
