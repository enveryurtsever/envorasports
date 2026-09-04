import { describe, expect, it } from 'vitest';
import {
  bookmakerMargin,
  brierScore,
  combinedOdds,
  edge,
  expectedValue,
  impliedProbability,
  logLoss,
  marginalise,
  normalize,
  poissonCdf,
  poissonPmf,
  removeVig,
  scoreMatrix,
} from './probability';

describe('value formulas', () => {
  it('matches the worked examples in the specification', () => {
    // §25: odds 2.00 -> implied 0.50
    expect(impliedProbability(2).toFixed(4)).toBe('0.5000');
    // §25: model 0.57 at 2.00 -> EV +0.14
    expect(expectedValue('0.57', 2).toFixed(4)).toBe('0.1400');
    expect(edge('0.57', 2).toFixed(4)).toBe('0.0700');
  });

  it('flags the §27 high-odds example as value and the counter-example as not', () => {
    // Odds 18.00 -> implied 5.56%. Model 7.10% is a value candidate.
    expect(impliedProbability(18).times(100).toFixed(2)).toBe('5.56');
    expect(edge('0.0710', 18).isPositive()).toBe(true);
    // Model 2.1% against the same price is negative value and must be rejected.
    expect(edge('0.021', 18).isNegative()).toBe(true);
    expect(expectedValue('0.021', 18).isNegative()).toBe(true);
  });

  it('rejects prices that are not valid decimal odds', () => {
    expect(() => impliedProbability(1)).toThrow(RangeError);
    expect(() => impliedProbability(0)).toThrow(RangeError);
    expect(() => expectedValue('0.5', 0.9)).toThrow(RangeError);
  });

  it('multiplies accumulator odds exactly', () => {
    expect(combinedOdds(['1.10', '1.20', '1.30']).toFixed(4)).toBe('1.7160');
  });
});

describe('market maths', () => {
  it('computes the overround of a priced market', () => {
    // 2.00 / 3.50 / 4.00 -> 0.5 + 0.2857... + 0.25 = 1.0357...
    expect(bookmakerMargin([2, 3.5, 4]).times(100).toFixed(2)).toBe('3.57');
  });

  it('removes vig so probabilities sum to exactly one', () => {
    const fair = removeVig([2, 3.5, 4]);
    const total = fair.reduce((a, b) => a.plus(b), fair[0]!.minus(fair[0]!));
    expect(total.toFixed(8)).toBe('1.00000000');
    // The favourite stays the favourite.
    expect(fair[0]!.greaterThan(fair[1]!)).toBe(true);
  });

  it('normalises a degenerate all-zero vector to uniform instead of NaN', () => {
    const result = normalize([0, 0, 0, 0]);
    expect(result.every((p) => p.toFixed(4) === '0.2500')).toBe(true);
  });
});

describe('scoring metrics', () => {
  it('rewards a confident correct call', () => {
    expect(brierScore('0.9', true).lessThan(brierScore('0.6', true))).toBe(true);
  });

  it('keeps log loss finite for a confidently wrong call', () => {
    const loss = logLoss('1', false);
    expect(loss.isFinite()).toBe(true);
    expect(loss.greaterThan(30)).toBe(true);
  });
});

describe('poisson goal model', () => {
  it('gives a valid pmf', () => {
    // P(X=0 | lambda=1.5) = e^-1.5
    expect(poissonPmf(0, 1.5).toFixed(6)).toBe('0.223130');
    expect(poissonPmf(2, 1.5).toFixed(6)).toBe('0.251021');
  });

  it('has a cdf that approaches 1', () => {
    expect(poissonCdf(25, 1.5).toFixed(6)).toBe('1.000000');
  });

  it('handles lambda = 0 as a certain shutout', () => {
    expect(poissonPmf(0, 0).toFixed(4)).toBe('1.0000');
    expect(poissonPmf(1, 0).toFixed(4)).toBe('0.0000');
  });

  it('produces a normalised score matrix', () => {
    const matrix = scoreMatrix(1.6, 1.2, 10);
    const total = marginalise(matrix, () => true);
    expect(total.toFixed(8)).toBe('1.00000000');
  });

  it('derives coherent 1X2 and goals markets from one matrix', () => {
    const matrix = scoreMatrix(1.6, 1.2, 10);
    const home = marginalise(matrix, (h, a) => h > a);
    const draw = marginalise(matrix, (h, a) => h === a);
    const away = marginalise(matrix, (h, a) => h < a);

    expect(home.plus(draw).plus(away).toFixed(6)).toBe('1.000000');
    // The stronger attack should be favourite.
    expect(home.greaterThan(away)).toBe(true);

    // Over/Under lines must be monotonic.
    const over15 = marginalise(matrix, (h, a) => h + a > 1.5);
    const over25 = marginalise(matrix, (h, a) => h + a > 2.5);
    const over35 = marginalise(matrix, (h, a) => h + a > 3.5);
    expect(over15.greaterThan(over25)).toBe(true);
    expect(over25.greaterThan(over35)).toBe(true);

    // BTTS is the complement of "at least one team blanks".
    const btts = marginalise(matrix, (h, a) => h > 0 && a > 0);
    const noBtts = marginalise(matrix, (h, a) => h === 0 || a === 0);
    expect(btts.plus(noBtts).toFixed(6)).toBe('1.000000');
  });
});
