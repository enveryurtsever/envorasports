import { describe, expect, it } from 'vitest';
import { dec } from '@/lib/math/decimal';
import { deriveMarkets, lambdasFromOutcome } from './markets-from-matrix';
import { runEloModel, drawProbability } from './elo-model';
import { headToHeadFactor, poissonLambdas, runPoissonModel, shrinkStrength } from './poisson-model';
import { runEnsemble, computeAgreement } from './ensemble';
import { unavailable, type ModelOutput } from './types';
import { DEFAULT_MODEL_WEIGHTS } from '@/lib/config/coupon-settings';

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

describe('deriveMarkets', () => {
  const { probabilities: p } = deriveMarkets(1.6, 1.2);
  const get = (code: string) => Number(p.get(code) ?? 0);

  it('produces a coherent 1X2', () => {
    expect(sum([get('MS_1'), get('MS_X'), get('MS_2')])).toBeCloseTo(1, 6);
    // The stronger attack should be favourite.
    expect(get('MS_1')).toBeGreaterThan(get('MS_2'));
  });

  it('makes double chance the union of the outcomes it contains', () => {
    expect(get('DOUBLE_CHANCE_1X')).toBeCloseTo(get('MS_1') + get('MS_X'), 6);
    expect(get('DOUBLE_CHANCE_X2')).toBeCloseTo(get('MS_X') + get('MS_2'), 6);
    expect(get('DOUBLE_CHANCE_12')).toBeCloseTo(get('MS_1') + get('MS_2'), 6);
  });

  it('keeps over/under monotonic across lines', () => {
    // Deriving them from one matrix is what guarantees this.
    expect(get('OVER_1_5')).toBeGreaterThan(get('OVER_2_5'));
    expect(get('OVER_2_5')).toBeGreaterThan(get('OVER_3_5'));
    expect(get('OVER_3_5')).toBeGreaterThan(get('OVER_4_5'));
  });

  it('makes over and under complementary on a half line', () => {
    expect(get('OVER_2_5') + get('UNDER_2_5')).toBeCloseTo(1, 6);
  });

  it('keeps the goals-threshold specials ordered', () => {
    expect(get('GOALS_6_PLUS')).toBeGreaterThan(get('GOALS_7_PLUS'));
    expect(get('GOALS_6_PLUS')).toBeLessThan(get('OVER_4_5'));
  });

  it('makes BTTS complementary', () => {
    expect(get('BTTS_YES') + get('BTTS_NO')).toBeCloseTo(1, 6);
  });

  it('makes the goal-range bands partition the outcome space', () => {
    const bands =
      get('GOAL_RANGE_0_1') + get('GOAL_RANGE_2_3') + get('GOAL_RANGE_4_6') + get('GOAL_RANGE_7_PLUS');
    expect(bands).toBeCloseTo(1, 4);
  });

  it('gives half-time results that sum to one', () => {
    expect(sum([get('HT_1'), get('HT_X'), get('HT_2')])).toBeCloseTo(1, 4);
  });

  it('gives an HT/FT grid that sums to one', () => {
    const codes = ['1', 'X', '2'].flatMap((h) => ['1', 'X', '2'].map((f) => `HTFT_${h}_${f}`));
    expect(sum(codes.map(get))).toBeCloseTo(1, 3);
  });

  it('rates a lead-and-hold above a comeback', () => {
    // Leading at half time and winning is far more likely than losing the lead.
    expect(get('HTFT_1_1')).toBeGreaterThan(get('HTFT_1_2'));
    expect(get('HTFT_2_2')).toBeGreaterThan(get('HTFT_2_1'));
  });

  it('prices correct scores sensibly', () => {
    // 1-1 and 1-0 should outrank a 4-4 by a wide margin.
    expect(get('CS_1_1')).toBeGreaterThan(get('CS_4_4'));
    expect(get('CS_1_0')).toBeGreaterThan(get('CS_0_4'));
  });

  it('makes the two handicap sides consistent', () => {
    // With a half line there is no push, so the two sides must complement.
    expect(get('AH_HOME_M0_5') + get('AH_AWAY_P0_5')).toBeCloseTo(1, 4);
  });
});

describe('lambdasFromOutcome', () => {
  it('recovers scoring rates that reproduce the stated 1X2', () => {
    const { lambdaHome, lambdaAway } = lambdasFromOutcome(0.5, 0.27, 0.23, 2.7);
    const { probabilities } = deriveMarkets(lambdaHome, lambdaAway);

    expect(Number(probabilities.get('MS_1'))).toBeCloseTo(0.5, 1);
    expect(Number(probabilities.get('MS_2'))).toBeCloseTo(0.23, 1);
    expect(lambdaHome).toBeGreaterThan(lambdaAway);
  });
});

describe('elo model', () => {
  it('shrinks the draw as the gap widens', () => {
    expect(drawProbability(0)).toBeGreaterThan(drawProbability(200));
    expect(drawProbability(200)).toBeGreaterThan(drawProbability(500));
  });

  it('favours the stronger side', () => {
    const output = runEloModel({
      homeRating: 1700,
      awayRating: 1450,
      homeMatchesPlayed: 30,
      awayMatchesPlayed: 30,
      homeAdvantage: 65,
      expectedTotalGoals: 2.7,
    });

    const home = Number(output.probabilities.get('MS_1'));
    const away = Number(output.probabilities.get('MS_2'));
    expect(home).toBeGreaterThan(away);
    expect(output.available).toBe(true);
  });

  it('reports low confidence when the ratings rest on few matches', () => {
    const thin = runEloModel({
      homeRating: 1500, awayRating: 1500, homeMatchesPlayed: 2, awayMatchesPlayed: 2,
      homeAdvantage: 65, expectedTotalGoals: 2.7,
    });
    const rich = runEloModel({
      homeRating: 1500, awayRating: 1500, homeMatchesPlayed: 30, awayMatchesPlayed: 30,
      homeAdvantage: 65, expectedTotalGoals: 2.7,
    });
    expect(thin.confidence).toBeLessThan(rich.confidence);
  });

  it('marks itself unavailable with no rated history at all', () => {
    const output = runEloModel({
      homeRating: 1500, awayRating: 1500, homeMatchesPlayed: 0, awayMatchesPlayed: 0,
      homeAdvantage: 65, expectedTotalGoals: 2.7,
    });
    expect(output.available).toBe(false);
  });
});

describe('head-to-head', () => {
  it('moves the total toward what the pairing produces, by at most a third at a full sample', () => {
    // Sides expected to produce 2.5 that have met five times at 4.0 a game.
    expect(headToHeadFactor(2.5, { averageTotalGoals: 4, sampleSize: 5 })).toBeCloseTo(1.18, 2);
    // One meeting is worth a fifth of that.
    expect(headToHeadFactor(2.5, { averageTotalGoals: 4, sampleSize: 1 })).toBeCloseTo(1.036, 2);
    expect(headToHeadFactor(2.5, null)).toBe(1);
    expect(headToHeadFactor(2.5, { averageTotalGoals: 4, sampleSize: 0 })).toBe(1);
  });

  it('never lets a freak scoreline double or halve the sides', () => {
    expect(headToHeadFactor(2.0, { averageTotalGoals: 9, sampleSize: 5 })).toBe(1.25);
    expect(headToHeadFactor(3.0, { averageTotalGoals: 0, sampleSize: 5 })).toBe(0.8);
  });

  it('scales both sides alike so the result split is untouched', () => {
    const base = { homeAttack: 1.4, homeDefence: 0.8, awayAttack: 0.9, awayDefence: 1.2, leagueHomeGoals: 1.5, leagueAwayGoals: 1.15, homeSampleSize: 20, awaySampleSize: 20, shrinkage: 0.25, maxGoals: 8 };
    const plain = poissonLambdas(base);
    const open = poissonLambdas({ ...base, headToHead: { averageTotalGoals: 5, sampleSize: 5 } });
    expect(open.lambdaHome + open.lambdaAway).toBeGreaterThan(plain.lambdaHome + plain.lambdaAway);
    expect(open.lambdaHome / open.lambdaAway).toBeCloseTo(plain.lambdaHome / plain.lambdaAway, 6);
  });
});

describe('poisson model', () => {
  it('pulls a small sample toward the league average', () => {
    // A 2.0 strength off 2 matches should be trusted far less than off 40.
    expect(shrinkStrength(2, 2, 0.25)).toBeLessThan(shrinkStrength(2, 40, 0.25));
    expect(shrinkStrength(2, 2, 0.25)).toBeGreaterThan(1);
    expect(shrinkStrength(1.5, 0, 0.25)).toBe(1);
  });

  it('gives the stronger attack the higher scoring rate', () => {
    const output = runPoissonModel({
      homeAttack: 1.4, homeDefence: 0.8, awayAttack: 0.9, awayDefence: 1.2,
      leagueHomeGoals: 1.5, leagueAwayGoals: 1.15,
      homeSampleSize: 20, awaySampleSize: 20, shrinkage: 0.25, maxGoals: 8,
    });

    expect(Number(output.features.lambdaHome)).toBeGreaterThan(Number(output.features.lambdaAway));
    expect(Number(output.probabilities.get('MS_1'))).toBeGreaterThan(
      Number(output.probabilities.get('MS_2')),
    );
  });
});

describe('ensemble', () => {
  function fake(name: string, home: number, draw: number, away: number, confidence = 1): ModelOutput {
    return {
      name,
      available: true,
      confidence,
      probabilities: new Map([
        ['MS_1', dec(home)],
        ['MS_X', dec(draw)],
        ['MS_2', dec(away)],
        ['BTTS_YES', dec(0.55)],
      ]),
      features: {},
    };
  }

  it('blends and renormalises the result market to exactly one', () => {
    const result = runEnsemble(
      [fake('elo', 0.5, 0.28, 0.22), fake('poisson', 0.44, 0.3, 0.26)],
      DEFAULT_MODEL_WEIGHTS,
    );

    const total =
      Number(result.probabilities.get('MS_1')) +
      Number(result.probabilities.get('MS_X')) +
      Number(result.probabilities.get('MS_2'));
    expect(total).toBeCloseTo(1, 8);
  });

  it('redistributes an unavailable model’s weight instead of counting it as zero', () => {
    const withXg = runEnsemble(
      [fake('elo', 0.5, 0.28, 0.22), fake('xg', 0.5, 0.28, 0.22)],
      DEFAULT_MODEL_WEIGHTS,
    );
    const withoutXg = runEnsemble(
      [fake('elo', 0.5, 0.28, 0.22), unavailable('xg', 'no_expected_goals_data')],
      DEFAULT_MODEL_WEIGHTS,
    );

    // Both models agree, so dropping one must not move the answer.
    expect(Number(withoutXg.probabilities.get('MS_1'))).toBeCloseTo(
      Number(withXg.probabilities.get('MS_1')),
      6,
    );
    expect(withoutXg.contributingModels).toEqual(['elo']);
    expect(sum(Object.values(withoutXg.effectiveWeights))).toBeCloseTo(1, 6);
  });

  it('rebuilds double chance from the renormalised outcomes', () => {
    const result = runEnsemble([fake('elo', 0.5, 0.28, 0.22)], DEFAULT_MODEL_WEIGHTS);
    expect(Number(result.probabilities.get('DOUBLE_CHANCE_1X'))).toBeCloseTo(
      Number(result.probabilities.get('MS_1')) + Number(result.probabilities.get('MS_X')),
      8,
    );
  });

  it('keeps BTTS complementary after blending', () => {
    const result = runEnsemble([fake('elo', 0.5, 0.28, 0.22)], DEFAULT_MODEL_WEIGHTS);
    expect(
      Number(result.probabilities.get('BTTS_YES')) + Number(result.probabilities.get('BTTS_NO')),
    ).toBeCloseTo(1, 8);
  });

  it('returns nothing usable when every model is unavailable', () => {
    const result = runEnsemble(
      [unavailable('elo', 'x'), unavailable('form', 'y')],
      DEFAULT_MODEL_WEIGHTS,
    );
    expect(result.probabilities.size).toBe(0);
    expect(result.contributingModels).toEqual([]);
  });

  it('weights a low-confidence model less', () => {
    const result = runEnsemble(
      [fake('elo', 0.7, 0.2, 0.1, 1), fake('form', 0.2, 0.3, 0.5, 0.1)],
      DEFAULT_MODEL_WEIGHTS,
    );
    // Elo is confident and should dominate the blend.
    expect(Number(result.probabilities.get('MS_1'))).toBeGreaterThan(0.5);
  });
});

describe('model agreement', () => {
  function view(home: number, draw: number, away: number): ModelOutput {
    return {
      name: 'm',
      available: true,
      confidence: 1,
      probabilities: new Map([['MS_1', dec(home)], ['MS_X', dec(draw)], ['MS_2', dec(away)]]),
      features: {},
    };
  }

  it('is 1 when models say the same thing', () => {
    expect(computeAgreement([view(0.5, 0.3, 0.2), view(0.5, 0.3, 0.2)])).toBeCloseTo(1, 6);
  });

  it('falls when models disagree', () => {
    const agree = computeAgreement([view(0.5, 0.3, 0.2), view(0.48, 0.31, 0.21)]);
    const disagree = computeAgreement([view(0.7, 0.2, 0.1), view(0.15, 0.25, 0.6)]);
    expect(disagree).toBeLessThan(agree);
    expect(disagree).toBeLessThan(0.5);
  });

  it('does not claim agreement from a single model', () => {
    expect(computeAgreement([view(0.5, 0.3, 0.2)])).toBeLessThan(1);
    expect(computeAgreement([])).toBe(0);
  });
});
