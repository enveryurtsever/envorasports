import { z } from 'zod';
import { MARKET } from '@/lib/markets/registry';

/**
 * Dynamic generation settings (§17, §24, §30).
 *
 * There is deliberately no hard-coded "5 + 5 + 5" anywhere in the engine. Every
 * count and threshold below is loaded at runtime, and every value ships with a
 * declared valid range so the admin UI can render and enforce it.
 */

export const COUPON_CATEGORIES = [
  'HIGH_CONFIDENCE',
  'BALANCED_PICKS',
  'HIGH_VALUE',
  'COMBINATION_SYSTEM',
] as const;

export type CouponCategory = (typeof COUPON_CATEGORIES)[number];

const probability = z.number().min(0).max(1);
const signedRatio = z.number().min(-1).max(10);

export const couponCategorySettingsSchema = z
  .object({
    category: z.enum(COUPON_CATEGORIES),
    enabled: z.boolean(),
    couponCount: z.number().int().min(0).max(50),

    minTotalOdds: z.number().min(1).max(100_000),
    maxTotalOdds: z.number().min(1).max(100_000).nullable(),

    minSelections: z.number().int().min(1).max(20),
    maxSelections: z.number().int().min(1).max(20),

    minConfidence: probability,
    minExpectedValue: signedRatio,
    minEdge: signedRatio,
    minProbability: probability,
    maxRisk: probability,
    maxCorrelation: probability,
    minDataQuality: probability,

    oneSelectionPerMatch: z.boolean(),
    /** Empty = every active market is eligible. */
    allowedMarkets: z.array(z.string()),
  })
  // The invariants §17 requires; the database repeats them as CHECK constraints.
  .refine((s) => s.maxTotalOdds === null || s.minTotalOdds <= s.maxTotalOdds, {
    message: 'minTotalOdds must be <= maxTotalOdds',
    path: ['maxTotalOdds'],
  })
  .refine((s) => s.minSelections <= s.maxSelections, {
    message: 'minSelections must be <= maxSelections',
    path: ['maxSelections'],
  })
  .refine((s) => s.allowedMarkets.every((code) => Object.values(MARKET).includes(code as never)), {
    message: 'allowedMarkets contains an unknown market code',
    path: ['allowedMarkets'],
  });

export type CouponCategorySettings = z.infer<typeof couponCategorySettingsSchema>;

export const systemCouponSettingsSchema = z
  .object({
    enabled: z.boolean(),
    allowedSystemTypes: z.array(z.string().regex(/^SYSTEM_\d+$/)).min(1),
    defaultSystemType: z.string().regex(/^SYSTEM_\d+$/),
    minBaseSelections: z.number().int().min(2).max(20),
    maxBaseSelections: z.number().int().min(2).max(20),
    stakePerColumn: z.number().min(0).max(10_000),
    maxTotalStake: z.number().min(0).max(1_000_000),
    currency: z.string().length(3),
    minCombinedProbability: probability,
    minExpectedValue: signedRatio,
    maxCorrelation: probability,
    oneSelectionPerMatch: z.boolean(),
    couponCount: z.number().int().min(0).max(50),
  })
  .refine((s) => s.minBaseSelections <= s.maxBaseSelections, {
    message: 'minBaseSelections must be <= maxBaseSelections',
    path: ['maxBaseSelections'],
  })
  .refine((s) => s.allowedSystemTypes.includes(s.defaultSystemType), {
    message: 'defaultSystemType must be one of allowedSystemTypes',
    path: ['defaultSystemType'],
  })
  .refine(
    (s) => {
      // k must be reachable: SYSTEM_k needs at least k base selections.
      const ks = s.allowedSystemTypes.map((t) => Number(t.split('_')[1]));
      return ks.every((k) => Number.isInteger(k) && k >= 1 && k <= s.maxBaseSelections);
    },
    { message: 'A system type requires more selections than maxBaseSelections allows', path: ['allowedSystemTypes'] },
  );

export type SystemCouponSettings = z.infer<typeof systemCouponSettingsSchema>;

/**
 * Declared ranges for the admin UI: every setting shows its current value, its
 * valid range and a short explanation (§19).
 */
export interface SettingRange {
  min: number;
  max: number;
  step: number;
  unit?: 'odds' | 'ratio' | 'count' | 'money';
}

export const SETTING_RANGES: Record<string, SettingRange> = {
  couponCount: { min: 0, max: 50, step: 1, unit: 'count' },
  minTotalOdds: { min: 1, max: 1000, step: 0.01, unit: 'odds' },
  maxTotalOdds: { min: 1, max: 100_000, step: 0.01, unit: 'odds' },
  minSelections: { min: 1, max: 20, step: 1, unit: 'count' },
  maxSelections: { min: 1, max: 20, step: 1, unit: 'count' },
  minConfidence: { min: 0, max: 1, step: 0.01, unit: 'ratio' },
  minExpectedValue: { min: -1, max: 10, step: 0.01, unit: 'ratio' },
  minEdge: { min: -1, max: 10, step: 0.005, unit: 'ratio' },
  minProbability: { min: 0, max: 1, step: 0.01, unit: 'ratio' },
  maxRisk: { min: 0, max: 1, step: 0.01, unit: 'ratio' },
  maxCorrelation: { min: 0, max: 1, step: 0.01, unit: 'ratio' },
  minDataQuality: { min: 0, max: 1, step: 0.01, unit: 'ratio' },
  stakePerColumn: { min: 0, max: 10_000, step: 0.01, unit: 'money' },
  maxTotalStake: { min: 0, max: 1_000_000, step: 0.01, unit: 'money' },
  minBaseSelections: { min: 2, max: 20, step: 1, unit: 'count' },
  maxBaseSelections: { min: 2, max: 20, step: 1, unit: 'count' },
};

// ---------------------------------------------------------------------------
// Defaults — the starting point only. Nothing reads these at generation time;
// the engine always loads the persisted values.
// ---------------------------------------------------------------------------

export const DEFAULT_CATEGORY_SETTINGS: Record<CouponCategory, CouponCategorySettings> = {
  HIGH_CONFIDENCE: {
    category: 'HIGH_CONFIDENCE',
    enabled: true,
    couponCount: 5,
    minTotalOdds: 1.5,
    // A 2-leg coupon whose legs must also carry positive edge lands around
    // 2.4-3.5; a 2.5 ceiling made the category unfillable in practice.
    maxTotalOdds: 4,
    minSelections: 2,
    maxSelections: 4,
    minConfidence: 0.7,
    minExpectedValue: 0.02,
    minEdge: 0.02,
    minProbability: 0.65,
    maxRisk: 0.4,
    maxCorrelation: 0.3,
    minDataQuality: 0.6,
    oneSelectionPerMatch: true,
    allowedMarkets: [
      MARKET.DOUBLE_CHANCE,
      MARKET.OVER_UNDER,
      MARKET.MATCH_RESULT,
      MARKET.BTTS,
      MARKET.TEAM_TOTAL,
    ],
  },
  BALANCED_PICKS: {
    category: 'BALANCED_PICKS',
    enabled: true,
    // §30's example default range.
    couponCount: 5,
    minTotalOdds: 2.5,
    maxTotalOdds: 6,
    minSelections: 2,
    maxSelections: 5,
    minConfidence: 0.55,
    minExpectedValue: 0.03,
    minEdge: 0.025,
    minProbability: 0.4,
    maxRisk: 0.6,
    maxCorrelation: 0.4,
    minDataQuality: 0.5,
    oneSelectionPerMatch: true,
    allowedMarkets: [],
  },
  HIGH_VALUE: {
    category: 'HIGH_VALUE',
    enabled: true,
    couponCount: 5,
    minTotalOdds: 8,
    maxTotalOdds: null,
    minSelections: 2,
    maxSelections: 6,
    minConfidence: 0.35,
    // A long shot still has to beat the price, or it is a lottery ticket (§31).
    minExpectedValue: 0.08,
    minEdge: 0.04,
    // Backtest evidence, not taste: below ~0.25 the model's calibration error
    // swamps its edge. High Value still reaches 8.0+ total odds because three
    // legs at 0.25-0.35 multiply out well past it.
    minProbability: 0.25,
    maxRisk: 0.85,
    maxCorrelation: 0.5,
    minDataQuality: 0.45,
    oneSelectionPerMatch: true,
    allowedMarkets: [],
  },
  COMBINATION_SYSTEM: {
    category: 'COMBINATION_SYSTEM',
    enabled: true,
    couponCount: 2,
    minTotalOdds: 1.5,
    maxTotalOdds: null,
    minSelections: 6,
    maxSelections: 10,
    minConfidence: 0.5,
    minExpectedValue: 0.02,
    minEdge: 0.02,
    minProbability: 0.35,
    maxRisk: 0.7,
    maxCorrelation: 0.35,
    minDataQuality: 0.5,
    oneSelectionPerMatch: true,
    allowedMarkets: [],
  },
};

export const DEFAULT_SYSTEM_SETTINGS: SystemCouponSettings = {
  enabled: true,
  allowedSystemTypes: ['SYSTEM_2', 'SYSTEM_3', 'SYSTEM_4'],
  defaultSystemType: 'SYSTEM_3',
  minBaseSelections: 6,
  maxBaseSelections: 10,
  stakePerColumn: 1,
  maxTotalStake: 250,
  currency: 'EUR',
  minCombinedProbability: 0.02,
  minExpectedValue: 0.02,
  maxCorrelation: 0.35,
  oneSelectionPerMatch: true,
  couponCount: 2,
};

/** Weights for the coupon score (§34). No magic numbers in the services. */
export const couponScoringWeightsSchema = z.object({
  probabilityWeight: z.number().min(0).max(10),
  valueWeight: z.number().min(0).max(10),
  confidenceWeight: z.number().min(0).max(10),
  diversificationWeight: z.number().min(0).max(10),
  correlationPenalty: z.number().min(0).max(10),
  riskPenalty: z.number().min(0).max(10),
});

export type CouponScoringWeights = z.infer<typeof couponScoringWeightsSchema>;

export const DEFAULT_SCORING_WEIGHTS: CouponScoringWeights = {
  probabilityWeight: 1,
  valueWeight: 1.5,
  confidenceWeight: 1,
  diversificationWeight: 0.5,
  correlationPenalty: 1.25,
  riskPenalty: 0.75,
};

/** Initial ensemble weights (§26); tuned later, never hard-coded downstream. */
export const modelWeightsSchema = z
  .object({
    elo: z.number().min(0).max(1),
    poisson: z.number().min(0).max(1),
    form: z.number().min(0).max(1),
    xg: z.number().min(0).max(1),
  })
  .refine((w) => Math.abs(w.elo + w.poisson + w.form + w.xg - 1) < 1e-6, {
    message: 'Model weights must sum to 1',
  });

export type ModelWeights = z.infer<typeof modelWeightsSchema>;

export const DEFAULT_MODEL_WEIGHTS: ModelWeights = {
  elo: 0.2,
  poisson: 0.4,
  form: 0.2,
  xg: 0.2,
};
