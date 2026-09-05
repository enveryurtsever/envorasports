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

    // A single-match coupon is just a bet; the product does not offer one.
    minSelections: z.number().int().min(2).max(20),
    maxSelections: z.number().int().min(1).max(20),

    minConfidence: probability,
    minExpectedValue: signedRatio,
    minEdge: signedRatio,
    minProbability: probability,
    maxRisk: probability,
    maxCorrelation: probability,
    minDataQuality: probability,
    /**
     * Floor on the chance the whole coupon lands. It trades directly against
     * minTotalOdds — an honest coupon prices at roughly 1/probability, so
     * demanding 0.85 caps the odds near 1.18. Both bounds are enforced, and a
     * category configured with an impossible pair produces nothing and records
     * why rather than inventing a probability that satisfies it.
     */
    minCombinedProbability: probability,

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
    // SYSTEM_3 or SYSTEM_3_4_5 — one or several column sizes.
    allowedSystemTypes: z.array(z.string().regex(/^SYSTEM_\d+(_\d+)*$/)).min(1),
    defaultSystemType: z.string().regex(/^SYSTEM_\d+(_\d+)*$/),
    /**
     * Categories that also produce a system coupon. High-variance categories
     * gain most: a system only needs k of n legs to return something, which is
     * exactly the shape of a long-shot selection set.
     */
    sourceCategories: z.array(z.enum(COUPON_CATEGORIES)).min(1),
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
      // Every size must be reachable: the largest needs that many base legs,
      // and a single-leg column is a straight bet rather than a system.
      const sizes = s.allowedSystemTypes.flatMap((type) =>
        type.replace('SYSTEM_', '').split('_').map(Number),
      );
      return sizes.every((k) => Number.isInteger(k) && k >= 2 && k <= s.maxBaseSelections);
    },
    {
      message: 'A system size is below 2 or needs more selections than maxBaseSelections allows',
      path: ['allowedSystemTypes'],
    },
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
  minSelections: { min: 2, max: 20, step: 1, unit: 'count' },
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

/**
 * Market-specific slates inside a category.
 *
 * Surprise is one bucket of long shots, which makes it hard to read: an İY/MS
 * coupon and a 6+ goals coupon are different bets with different reasoning. A
 * focus group is the parent category's settings with the markets narrowed and
 * its own count, so the section can be split without inventing a category and
 * without a second set of thresholds to keep in step.
 */
export interface CouponFocusGroup {
  /** Stable key, stored on the coupon as its strategy and used as a label key. */
  key: string;
  category: CouponCategory;
  couponCount: number;
  allowedMarkets: string[];
  /**
   * Overrides for the parent's thresholds, which a narrow market often cannot
   * meet. The parent bars any leg under 25%, and six-or-more goals is a 5%
   * event by nature — so under the parent's rules the slate is empty by
   * construction, not for want of candidates.
   */
  minTotalOdds?: number;
  minCombinedProbability?: number;
  minSelections?: number;
  maxSelections?: number;
  minProbability?: number;
  minConfidence?: number;
  minEdge?: number;
  minExpectedValue?: number;
  maxRisk?: number;
  /**
   * Play the slate as a system rather than a straight accumulator. A seven-leg
   * accumulator returns nothing unless all seven land; the same seven as a
   * 3/4/5 returns on three. Same selections, a real chance of a return.
   */
  system?: { systemType: string; minBaseSelections: number; maxBaseSelections: number };
}

export const DEFAULT_FOCUS_GROUPS: CouponFocusGroup[] = [
  {
    key: 'htft',
    category: 'HIGH_VALUE',
    couponCount: 3,
    allowedMarkets: [MARKET.HALF_TIME_FULL_TIME],
    // Half-time/full-time pairs are long on their own: two or three legs
    // already clear three figures, so the parent's odds floor stands.
    minSelections: 2,
    maxSelections: 4,
    // A 1/1 for a strong favourite is ~35%; a 2/1 turnaround is ~3%. The slate
    // needs the whole range or it is only ever the favourites.
    minProbability: 0.04,
    minConfidence: 0.3,
    minEdge: 0,
    minExpectedValue: 0,
    maxRisk: 0.95,
    // Five İY/MS legs needing three is a far better bet than four needing four.
    system: { systemType: 'SYSTEM_2_3', minBaseSelections: 4, maxBaseSelections: 6 },
  },
  {
    key: 'goals6',
    category: 'HIGH_VALUE',
    couponCount: 3,
    allowedMarkets: [MARKET.TOTAL_GOALS_THRESHOLD],
    minSelections: 2,
    maxSelections: 4,
    // Six or more goals lands in roughly one match in twenty. There is no
    // honest way to ask for a 25% leg here.
    minProbability: 0.02,
    minConfidence: 0.25,
    minEdge: 0,
    minExpectedValue: 0,
    maxRisk: 0.98,
    // 6+ goals is rare enough that asking for two of four is already ambitious,
    // and no way of playing it produces a high number.
    minCombinedProbability: 0.002,
    system: { systemType: 'SYSTEM_2_3', minBaseSelections: 4, maxBaseSelections: 6 },
  },
];

export const DEFAULT_CATEGORY_SETTINGS: Record<CouponCategory, CouponCategorySettings> = {
  HIGH_CONFIDENCE: {
    category: 'HIGH_CONFIDENCE',
    enabled: true,
    couponCount: 3,
    minTotalOdds: 1.10,
    maxTotalOdds: 4,
    minSelections: 2,
    maxSelections: 3,
    minConfidence: 0.6,
    // A Banko is heavy favourites at short prices. Demanding edge on top of
    // that is what emptied the category: the market prices a 92% shot keenly,
    // so the most likely legs carry almost none. Zero is the floor — we still
    // never back a selection the market rates above our own model.
    minExpectedValue: 0,
    minEdge: 0,
    minProbability: 0.6,
    maxRisk: 0.4,
    maxCorrelation: 0.3,
    minDataQuality: 0.6,
    /**
     * 0.85 is the target, but it needs two legs near 92% and the priced pool
     * tops out at 81% — one selection in sixty-seven clears 80%. Raise this
     * once the bulletin carries short-priced favourites (Over 0.5, double
     * chance on a heavy favourite); until then it would empty the category.
     */
    minCombinedProbability: 0.55,
    oneSelectionPerMatch: true,
    /**
     * The safe end of the bulletin. Asian handicap earns its place here now
     * that only the half-lines are offered: "+1.5" is one of the most reliable
     * selections there is, and excluding the market cost the category two
     * thirds of its candidates. Half-time and 6+ goals stay out — a Banko is
     * not built on a coin-flip half or a five-percent event.
     */
    allowedMarkets: [
      MARKET.DOUBLE_CHANCE,
      MARKET.OVER_UNDER,
      MARKET.MATCH_RESULT,
      MARKET.BTTS,
      MARKET.TEAM_TOTAL,
      MARKET.ASIAN_HANDICAP,
    ],
  },
  BALANCED_PICKS: {
    category: 'BALANCED_PICKS',
    enabled: true,
    // §30's example default range.
    couponCount: 3,
    minTotalOdds: 1.75,
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
    minCombinedProbability: 0.35,
    oneSelectionPerMatch: true,
    allowedMarkets: [],
  },
  HIGH_VALUE: {
    category: 'HIGH_VALUE',
    enabled: true,
    /**
     * Zero: every Surprise coupon is a system now. A straight accumulator at
     * these odds returns nothing unless every leg lands, and the system slate
     * below carries the same selections with a real chance of a return.
     */
    couponCount: 0,
    // The point of this category is the long shot, so the floor is the target:
    // a coupon that cannot reach 100.0 is not a Surprise, it is a Balanced one
    // wearing the label. Reaching it takes five or six legs, which is why the
    // selection range is wider here than elsewhere.
    minTotalOdds: 100,
    maxTotalOdds: null,
    minSelections: 3,
    maxSelections: 8,
    minConfidence: 0.35,
    // A long shot still has to beat the price, or it is a lottery ticket (§31).
    minExpectedValue: 0.08,
    minEdge: 0.04,
    // Backtest evidence, not taste: below ~0.25 the model's calibration error
    // swamps its edge. Every leg still clears that bar — the length comes from
    // stacking honest legs, never from reaching for worse ones to pad the odds.
    minProbability: 0.25,
    maxRisk: 0.85,
    maxCorrelation: 0.5,
    minDataQuality: 0.45,
    minCombinedProbability: 0.005,
    oneSelectionPerMatch: true,
    allowedMarkets: [],
  },
  COMBINATION_SYSTEM: {
    category: 'COMBINATION_SYSTEM',
    // Retired: systems now come from the categories above. The entry stays so
    // historical coupons keep a valid category.
    enabled: false,
    couponCount: 0,
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
    minCombinedProbability: 0.10,
    oneSelectionPerMatch: true,
    allowedMarkets: [],
  },
};

export const DEFAULT_SYSTEM_SETTINGS: SystemCouponSettings = {
  enabled: true,
  // Turkish slips combine sizes: "Sistem 3,4,5" over 8 legs is
  // C(8,3)+C(8,4)+C(8,5) = 182 columns on one coupon.
  allowedSystemTypes: ['SYSTEM_2_3', 'SYSTEM_3_4', 'SYSTEM_3_4_5', 'SYSTEM_4_5_6'],
  defaultSystemType: 'SYSTEM_3_4_5',
  // A system is a way of playing a set of picks, not a separate product, so it
  // is generated from a real category's pool rather than its own.
  sourceCategories: ['HIGH_VALUE'],
  minBaseSelections: 6,
  maxBaseSelections: 8,
  stakePerColumn: 1,
  maxTotalStake: 5000,
  // The operator's own currency: system stakes are real money in TL, not a
  // converted EUR figure.
  currency: 'TRY',
  minCombinedProbability: 0.02,
  minExpectedValue: 0.02,
  maxCorrelation: 0.35,
  oneSelectionPerMatch: true,
  couponCount: 3,
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
