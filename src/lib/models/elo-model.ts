import { dec } from '@/lib/math/decimal';
import { normalize } from '@/lib/math/probability';
import { expectedScore } from '@/services/features/elo';
import { deriveMarkets, lambdasFromOutcome } from './markets-from-matrix';
import type { ModelOutput } from './types';

/**
 * Elo model (§26).
 *
 * Elo gives an expected *score*, not a three-way split, so the draw has to be
 * modelled separately. The draw share shrinks as the rating gap widens, which
 * is what the data shows: mismatches draw less often.
 */

export interface EloModelInput {
  homeRating: number;
  awayRating: number;
  homeMatchesPlayed: number;
  awayMatchesPlayed: number;
  homeAdvantage: number;
  /** League scoring baseline, used to spread the result onto goals markets. */
  expectedTotalGoals: number;
}

/** Draw likelihood as a function of the rating gap. */
export function drawProbability(ratingGap: number): number {
  // ~28% for evenly matched sides, decaying toward ~12% at a 400-point gap.
  const base = 0.28;
  const decay = Math.exp(-Math.abs(ratingGap) / 380);
  return Math.max(0.1, base * decay + 0.1 * (1 - decay));
}

export function runEloModel(input: EloModelInput): ModelOutput {
  const adjustedHome = input.homeRating + input.homeAdvantage;
  const gap = adjustedHome - input.awayRating;

  const expectation = expectedScore(adjustedHome, input.awayRating);
  const draw = drawProbability(gap);

  // Split the non-draw mass in proportion to the Elo expectation.
  const home = expectation * (1 - draw);
  const away = (1 - expectation) * (1 - draw);
  const [pHome, pDraw, pAway] = normalize([home, draw, away]);

  const { lambdaHome, lambdaAway } = lambdasFromOutcome(
    Number(pHome),
    Number(pDraw),
    Number(pAway),
    input.expectedTotalGoals,
  );

  const derived = deriveMarkets(lambdaHome, lambdaAway);
  // The result markets come straight from Elo; the goals markets are the
  // translation, so the 1X2 numbers are restored exactly.
  derived.probabilities.set('MS_1', dec(pHome!));
  derived.probabilities.set('MS_X', dec(pDraw!));
  derived.probabilities.set('MS_2', dec(pAway!));
  derived.probabilities.set('DOUBLE_CHANCE_1X', dec(pHome!).plus(pDraw!));
  derived.probabilities.set('DOUBLE_CHANCE_X2', dec(pDraw!).plus(pAway!));
  derived.probabilities.set('DOUBLE_CHANCE_12', dec(pHome!).plus(pAway!));

  // A team with two matches of history has a rating that means very little.
  const sample = Math.min(input.homeMatchesPlayed, input.awayMatchesPlayed);
  const confidence = Math.max(0, Math.min(1, sample / 20));

  return {
    name: 'elo',
    available: sample > 0,
    confidence,
    probabilities: derived.probabilities,
    features: {
      homeRating: Number(input.homeRating.toFixed(1)),
      awayRating: Number(input.awayRating.toFixed(1)),
      ratingGap: Number(gap.toFixed(1)),
      homeAdvantage: input.homeAdvantage,
      eloExpectation: Number(expectation.toFixed(4)),
      matchesBehindRating: sample,
    },
  };
}
