import { dec } from '@/lib/math/decimal';
import { normalize } from '@/lib/math/probability';
import { deriveMarkets, lambdasFromOutcome } from './markets-from-matrix';
import type { TeamFormBundle } from '@/services/features/form';
import type { ModelOutput } from './types';
import { unavailable } from './types';

/**
 * Form model (§26).
 *
 * Recent points-per-game, weighted toward the most recent window and split by
 * venue. It is the shortest-memory model in the ensemble, which is the point:
 * it reacts to a change in a side long before Elo does.
 */

const WINDOW_WEIGHTS = { LAST_5: 0.5, LAST_10: 0.3, LAST_20: 0.2 } as const;
const MIN_SAMPLE = 3;

function pointsPerGame(wins: number, draws: number, played: number): number {
  return played === 0 ? 0 : (wins * 3 + draws) / played;
}

export interface FormModelInput {
  home: TeamFormBundle;
  away: TeamFormBundle;
  /** Weight given to the venue-specific window versus overall form. */
  venueWeight: number;
}

export function runFormModel(input: FormModelInput): ModelOutput {
  const { home, away } = input;

  if (home.windows.LAST_10.sampleSize < MIN_SAMPLE || away.windows.LAST_10.sampleSize < MIN_SAMPLE) {
    return unavailable('form', 'insufficient_match_history');
  }

  const weighted = (bundle: TeamFormBundle) => {
    let total = 0;
    let weight = 0;
    for (const [window, w] of Object.entries(WINDOW_WEIGHTS) as Array<
      [keyof typeof WINDOW_WEIGHTS, number]
    >) {
      const form = bundle.windows[window];
      if (form.sampleSize === 0) continue;
      total += pointsPerGame(form.wins, form.draws, form.matchesPlayed) * w;
      weight += w;
    }
    return weight === 0 ? 0 : total / weight;
  };

  // Home form at home, away form away — the split that actually matters.
  const homeOverall = weighted(home);
  const awayOverall = weighted(away);
  const homeVenue =
    home.home.sampleSize >= MIN_SAMPLE
      ? pointsPerGame(home.home.wins, home.home.draws, home.home.matchesPlayed)
      : homeOverall;
  const awayVenue =
    away.away.sampleSize >= MIN_SAMPLE
      ? pointsPerGame(away.away.wins, away.away.draws, away.away.matchesPlayed)
      : awayOverall;

  const homeStrength = homeOverall * (1 - input.venueWeight) + homeVenue * input.venueWeight;
  const awayStrength = awayOverall * (1 - input.venueWeight) + awayVenue * input.venueWeight;

  // Convert the points-per-game gap into a three-way split.
  const gap = homeStrength - awayStrength;
  const draw = Math.max(0.12, 0.3 - Math.abs(gap) * 0.06);
  const homeShare = 1 / (1 + Math.exp(-gap * 1.1));
  const [pHome, pDraw, pAway] = normalize([
    homeShare * (1 - draw),
    draw,
    (1 - homeShare) * (1 - draw),
  ]);

  // Goals come from the sides' own scoring and conceding rates, not the league.
  const expectedTotal = Math.max(
    1.2,
    (home.home.averageGoalsFor + away.away.averageGoalsAgainst) / 2 +
      (away.away.averageGoalsFor + home.home.averageGoalsAgainst) / 2,
  );

  const { lambdaHome, lambdaAway } = lambdasFromOutcome(
    Number(pHome),
    Number(pDraw),
    Number(pAway),
    expectedTotal,
  );

  const derived = deriveMarkets(lambdaHome, lambdaAway);
  derived.probabilities.set('MS_1', dec(pHome!));
  derived.probabilities.set('MS_X', dec(pDraw!));
  derived.probabilities.set('MS_2', dec(pAway!));

  // Empirical BTTS and over rates are direct observations; prefer them over the
  // matrix-derived versions for these specific markets.
  const bttsYes = (home.windows.LAST_10.bttsRate + away.windows.LAST_10.bttsRate) / 2;
  derived.probabilities.set('BTTS_YES', dec(bttsYes));
  derived.probabilities.set('BTTS_NO', dec(1 - bttsYes));

  const sample = Math.min(home.windows.LAST_10.sampleSize, away.windows.LAST_10.sampleSize);

  return {
    name: 'form',
    available: true,
    confidence: Math.max(0, Math.min(1, sample / 10)),
    probabilities: derived.probabilities,
    features: {
      homePointsPerGame: Number(homeStrength.toFixed(3)),
      awayPointsPerGame: Number(awayStrength.toFixed(3)),
      homeFormLast5: home.windows.LAST_5.results.join(''),
      awayFormLast5: away.windows.LAST_5.results.join(''),
      homeGoalsForAvg: Number(home.windows.LAST_10.averageGoalsFor.toFixed(2)),
      homeGoalsAgainstAvg: Number(home.windows.LAST_10.averageGoalsAgainst.toFixed(2)),
      awayGoalsForAvg: Number(away.windows.LAST_10.averageGoalsFor.toFixed(2)),
      awayGoalsAgainstAvg: Number(away.windows.LAST_10.averageGoalsAgainst.toFixed(2)),
      bttsRate: Number(bttsYes.toFixed(3)),
      sampleSize: sample,
    },
  };
}
