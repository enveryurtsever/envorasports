import { Decimal, clampProbability, dec } from '@/lib/math/decimal';
import { removeVig } from '@/lib/math/probability';
import { MARKET_GROUPS, type SelectionProbabilities } from './types';

/**
 * Market-prior calibration.
 *
 * The first backtest of this engine showed it was systematically overconfident:
 * selections it priced at 35% landed 20% of the time, and ones it priced at 64%
 * landed 53%. That is the classic failure of a model that ignores the market —
 * it only bets where it disagrees with the price, and where it disagrees most,
 * it is usually the one who is wrong.
 *
 * The fix is a prior, not a fudge: blend the model's view with the vig-free
 * market view. A weight of 0 is the raw model; 1 is pure market-following (and
 * therefore zero edge by construction). Somewhere in between the model keeps
 * its disagreements but stops overstating them.
 *
 * This is applied *before* edge and EV are computed, so every downstream number
 * reflects the calibrated probability.
 */

export interface MarketQuote {
  selectionCode: string;
  price: Decimal;
}

/** Complementary pairs that form a market on their own. */
const IMPLICIT_PAIRS: string[][] = [
  ['OVER_0_5', 'UNDER_0_5'],
  ['OVER_1_5', 'UNDER_1_5'],
  ['OVER_2_5', 'UNDER_2_5'],
  ['OVER_3_5', 'UNDER_3_5'],
  ['OVER_4_5', 'UNDER_4_5'],
  ['OVER_5_5', 'UNDER_5_5'],
  ['BTTS_YES', 'BTTS_NO'],
];

export function calibrationGroups(): string[][] {
  return [
    MARKET_GROUPS.MATCH_RESULT as string[],
    MARKET_GROUPS.HALF_TIME_RESULT as string[],
    ...IMPLICIT_PAIRS,
  ];
}

export interface CalibrationResult {
  probabilities: SelectionProbabilities;
  /** Groups that had a complete set of prices and were actually blended. */
  calibratedGroups: string[][];
}

/**
 * Blends model probabilities toward the vig-free market price, group by group.
 *
 * Only complete groups are blended: removing the overround needs every outcome
 * of the market, and half a market gives a meaningless normalisation.
 */
export function blendWithMarket(
  probabilities: SelectionProbabilities,
  quotes: Map<string, Decimal>,
  weight: number,
): CalibrationResult {
  const w = Math.max(0, Math.min(1, weight));
  if (w === 0) return { probabilities, calibratedGroups: [] };

  const output = new Map(probabilities);
  const calibrated: string[][] = [];

  for (const group of calibrationGroups()) {
    const prices = group.map((code) => quotes.get(code));
    // A partially quoted market cannot be de-vigged honestly.
    if (prices.some((price) => price === undefined || price.lessThanOrEqualTo(1))) continue;

    const fair = removeVig(prices as Decimal[]);

    for (const [index, code] of group.entries()) {
      const model = output.get(code);
      if (!model) continue;

      const market = fair[index] as Decimal;
      output.set(code, clampProbability(model.times(1 - w).plus(market.times(w))));
    }
    calibrated.push(group);
  }

  // Keep the derived markets consistent with the calibrated outcomes.
  const home = output.get('MS_1');
  const draw = output.get('MS_X');
  const away = output.get('MS_2');
  if (home && draw && away) {
    output.set('DOUBLE_CHANCE_1X', home.plus(draw));
    output.set('DOUBLE_CHANCE_X2', draw.plus(away));
    output.set('DOUBLE_CHANCE_12', home.plus(away));
  }

  const bttsYes = output.get('BTTS_YES');
  if (bttsYes) output.set('BTTS_NO', dec(1).minus(bttsYes));

  return { probabilities: output, calibratedGroups: calibrated };
}
