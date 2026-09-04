import { deriveMarkets } from './markets-from-matrix';
import type { ModelOutput } from './types';

/**
 * Poisson goals model (§26).
 *
 * Attack and defence strengths are ratios against the league baseline, so a
 * side that scores 1.8 in a 1.5-goal league has strength 1.2. Shrinkage pulls
 * those ratios toward 1 when the sample is small — without it, three good games
 * make a team look unstoppable.
 */

export interface PoissonModelInput {
  homeAttack: number;
  homeDefence: number;
  awayAttack: number;
  awayDefence: number;
  leagueHomeGoals: number;
  leagueAwayGoals: number;
  homeSampleSize: number;
  awaySampleSize: number;
  /** 0..1 — how hard to pull small samples toward the league average. */
  shrinkage: number;
  maxGoals: number;
}

/** Pulls a strength ratio toward 1 in proportion to how little we have seen. */
export function shrinkStrength(ratio: number, sampleSize: number, shrinkage: number): number {
  if (sampleSize <= 0) return 1;
  const weight = sampleSize / (sampleSize + shrinkage * 20);
  return 1 + (ratio - 1) * weight;
}

export function runPoissonModel(input: PoissonModelInput): ModelOutput {
  const homeAttack = shrinkStrength(input.homeAttack, input.homeSampleSize, input.shrinkage);
  const homeDefence = shrinkStrength(input.homeDefence, input.homeSampleSize, input.shrinkage);
  const awayAttack = shrinkStrength(input.awayAttack, input.awaySampleSize, input.shrinkage);
  const awayDefence = shrinkStrength(input.awayDefence, input.awaySampleSize, input.shrinkage);

  // Home scoring rate = home attack x away defence x league home baseline.
  const lambdaHome = Math.max(0.05, homeAttack * awayDefence * input.leagueHomeGoals);
  const lambdaAway = Math.max(0.05, awayAttack * homeDefence * input.leagueAwayGoals);

  const derived = deriveMarkets(lambdaHome, lambdaAway, { maxGoals: input.maxGoals });

  const sample = Math.min(input.homeSampleSize, input.awaySampleSize);
  const confidence = Math.max(0, Math.min(1, sample / 15));

  return {
    name: 'poisson',
    available: sample > 0,
    confidence,
    probabilities: derived.probabilities,
    features: {
      lambdaHome: Number(lambdaHome.toFixed(3)),
      lambdaAway: Number(lambdaAway.toFixed(3)),
      homeAttack: Number(homeAttack.toFixed(3)),
      homeDefence: Number(homeDefence.toFixed(3)),
      awayAttack: Number(awayAttack.toFixed(3)),
      awayDefence: Number(awayDefence.toFixed(3)),
      leagueHomeGoals: Number(input.leagueHomeGoals.toFixed(3)),
      leagueAwayGoals: Number(input.leagueAwayGoals.toFixed(3)),
      sampleSize: sample,
    },
  };
}
