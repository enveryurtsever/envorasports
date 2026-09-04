import { deriveMarkets } from './markets-from-matrix';
import type { TeamFormBundle } from '@/services/features/form';
import type { ModelOutput } from './types';
import { unavailable } from './types';

/**
 * xG model (§26).
 *
 * Expected goals are a better signal than actual goals over short samples, but
 * they are simply not in every source: the football-data.co.uk archive has none,
 * and API-Football only exposes them for some competitions.
 *
 * When xG is missing this model reports itself unavailable rather than
 * substituting shots or goals and calling it xG. The ensemble redistributes its
 * weight, and the data-quality score records that it was absent (§44).
 */

export interface XgModelInput {
  home: TeamFormBundle;
  away: TeamFormBundle;
  homeAdvantageMultiplier: number;
}

const MIN_SAMPLE = 4;

export function runXgModel(input: XgModelInput): ModelOutput {
  const homeXg = input.home.windows.LAST_10.averageXg;
  const homeXga = input.home.windows.LAST_10.averageXga;
  const awayXg = input.away.windows.LAST_10.averageXg;
  const awayXga = input.away.windows.LAST_10.averageXga;

  if (homeXg === null || homeXga === null || awayXg === null || awayXga === null) {
    return unavailable('xg', 'no_expected_goals_data');
  }

  const sample = Math.min(input.home.windows.LAST_10.sampleSize, input.away.windows.LAST_10.sampleSize);
  if (sample < MIN_SAMPLE) return unavailable('xg', 'insufficient_xg_sample');

  // A side's scoring rate is the midpoint of its own creation and the
  // opponent's leakage — both measured in xG.
  const lambdaHome = Math.max(0.05, ((homeXg + awayXga) / 2) * input.homeAdvantageMultiplier);
  const lambdaAway = Math.max(0.05, (awayXg + homeXga) / 2);

  const derived = deriveMarkets(lambdaHome, lambdaAway);

  return {
    name: 'xg',
    available: true,
    confidence: Math.max(0, Math.min(1, sample / 10)),
    probabilities: derived.probabilities,
    features: {
      homeXg: Number(homeXg.toFixed(2)),
      homeXga: Number(homeXga.toFixed(2)),
      awayXg: Number(awayXg.toFixed(2)),
      awayXga: Number(awayXga.toFixed(2)),
      lambdaHome: Number(lambdaHome.toFixed(3)),
      lambdaAway: Number(lambdaAway.toFixed(3)),
      sampleSize: sample,
    },
  };
}
