import { Decimal, clampProbability, dec } from '@/lib/math/decimal';
import { normalize } from '@/lib/math/probability';
import type { ModelWeights } from '@/lib/config/coupon-settings';
import { MARKET_GROUPS, type ModelOutput, type SelectionProbabilities } from './types';

/**
 * Ensemble (§26).
 *
 * Two things this has to get right:
 *
 * 1. **Unavailable models must not vote.** If xG is missing, its weight is
 *    redistributed across the models that did run. Treating absence as 0.5, or
 *    as a zero-probability vote, would quietly bias every market.
 * 2. **Grouped markets must stay coherent.** 1X2 is renormalised so the three
 *    outcomes sum to exactly 1 after blending; otherwise the implied
 *    probabilities drift and every downstream edge calculation is wrong.
 */

export interface EnsembleResult {
  probabilities: SelectionProbabilities;
  /** 0..1 — how closely the contributing models agreed. */
  modelAgreement: number;
  /** Weight actually applied to each model after redistribution. */
  effectiveWeights: Record<string, number>;
  contributingModels: string[];
  /** Per-model 1X2 view, for the explanation panel. */
  perModel: Record<string, Record<string, number>>;
}

const AGREEMENT_MARKETS = ['MS_1', 'MS_X', 'MS_2'];

export function runEnsemble(models: ModelOutput[], weights: ModelWeights): EnsembleResult {
  const available = models.filter((model) => model.available && model.probabilities.size > 0);

  if (available.length === 0) {
    return {
      probabilities: new Map(),
      modelAgreement: 0,
      effectiveWeights: {},
      contributingModels: [],
      perModel: {},
    };
  }

  // Redistribute the missing models' weight over those that ran, and scale each
  // by its own confidence so a model working from three matches counts less.
  const rawWeights = available.map((model) => {
    const configured = (weights as Record<string, number>)[model.name] ?? 0;
    return { model, weight: configured * Math.max(0.1, model.confidence) };
  });

  const totalWeight = rawWeights.reduce((sum, entry) => sum + entry.weight, 0);
  const effective = rawWeights.map((entry) => ({
    model: entry.model,
    weight: totalWeight > 0 ? entry.weight / totalWeight : 1 / rawWeights.length,
  }));

  // Blend every selection any model has an opinion on.
  const codes = new Set<string>();
  for (const { model } of effective) for (const code of model.probabilities.keys()) codes.add(code);

  const blended: SelectionProbabilities = new Map();
  for (const code of codes) {
    let sum = dec(0);
    let weightUsed = 0;

    for (const { model, weight } of effective) {
      const probability = model.probabilities.get(code);
      // A model with no view on this market does not drag it toward zero.
      if (probability === undefined) continue;
      sum = sum.plus(probability.times(weight));
      weightUsed += weight;
    }

    if (weightUsed > 0) blended.set(code, clampProbability(sum.dividedBy(weightUsed)));
  }

  renormaliseGroups(blended);

  return {
    probabilities: blended,
    modelAgreement: computeAgreement(effective.map((entry) => entry.model)),
    effectiveWeights: Object.fromEntries(
      effective.map((entry) => [entry.model.name, Number(entry.weight.toFixed(4))]),
    ),
    contributingModels: effective.map((entry) => entry.model.name),
    perModel: Object.fromEntries(
      available.map((model) => [
        model.name,
        Object.fromEntries(
          AGREEMENT_MARKETS.map((code) => [
            code,
            Number((model.probabilities.get(code) ?? dec(0)).toFixed(4)),
          ]),
        ),
      ]),
    ),
  };
}

/** Mutually exclusive, exhaustive markets must sum to exactly 1 after blending. */
function renormaliseGroups(probabilities: SelectionProbabilities): void {
  for (const [group, codes] of Object.entries(MARKET_GROUPS)) {
    // Double chance is a union of 1X2, not a partition — it is fixed after.
    if (group === 'DOUBLE_CHANCE') continue;

    const values = codes.map((code) => probabilities.get(code));
    if (values.some((value) => value === undefined)) continue;

    const normalised = normalize(values as Decimal[]);
    codes.forEach((code, index) => probabilities.set(code, normalised[index] as Decimal));
  }

  // Rebuild double chance from the renormalised 1X2 so they cannot disagree.
  const home = probabilities.get('MS_1');
  const draw = probabilities.get('MS_X');
  const away = probabilities.get('MS_2');
  if (home && draw && away) {
    probabilities.set('DOUBLE_CHANCE_1X', home.plus(draw));
    probabilities.set('DOUBLE_CHANCE_X2', draw.plus(away));
    probabilities.set('DOUBLE_CHANCE_12', home.plus(away));
  }

  // BTTS is a complementary pair.
  const bttsYes = probabilities.get('BTTS_YES');
  if (bttsYes) probabilities.set('BTTS_NO', dec(1).minus(bttsYes));
}

/**
 * How closely the models agreed on the match result.
 *
 * 1 = identical views, 0 = maximally split. High agreement is a reason to raise
 * confidence; disagreement is a reason to raise risk (§17 of the brief).
 */
export function computeAgreement(models: ModelOutput[]): number {
  const views = models
    .map((model) => AGREEMENT_MARKETS.map((code) => Number(model.probabilities.get(code) ?? 0)))
    .filter((view) => view.some((value) => value > 0));

  if (views.length < 2) return views.length === 1 ? 0.6 : 0;

  // Mean pairwise total-variation distance, inverted.
  let distanceSum = 0;
  let pairs = 0;
  for (let i = 0; i < views.length; i++) {
    for (let j = i + 1; j < views.length; j++) {
      const a = views[i] as number[];
      const b = views[j] as number[];
      const tv = a.reduce((sum, value, index) => sum + Math.abs(value - (b[index] ?? 0)), 0) / 2;
      distanceSum += tv;
      pairs++;
    }
  }

  return pairs === 0 ? 0 : Math.max(0, Math.min(1, 1 - distanceSum / pairs));
}
