import { z } from 'zod';
import { MARKET } from '@/lib/markets/registry';

/**
 * Dynamic generation settings (§17, §24, §30).
 *
 * There is deliberately no hard-coded "5 + 5 + 5" anywhere in the engine. Every
 * count and threshold below is loaded at runtime, and every value ships with a
 * declared valid range so the admin UI can render and enforce it.
 */

/**
 * Turns the edge and expected-value filters off rather than down.
 *
 * Zero reads like "no requirement" and is not: edge is probability minus the
 * market's, so a floor of zero still keeps only the candidates where the model
 * sits at or above the price — the upper half of its own error distribution.
 * Measured over 17,057 settled predictions, the slice sitting right at zero
 * expected value was already 5.7 points short of its forecast at -19% ROI, and
 * the top tenth promised 32.1% and returned 12.3%.
 *
 * Edge is now neither a filter nor a ranking (see STRATEGIES in the coupon
 * generator). It stays stored on every prediction, because it is worth
 * measuring — it is just not worth selecting on.
 */
const NO_EDGE_REQUIREMENT = -1;

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
    /** Archive codes (E0, NOR1, ...). Empty or absent means every league. */
    allowedLeagues: z.array(z.string()).optional(),
    /** Selection codes (OVER_2_5, BTTS_YES, ...). Empty or absent means every selection. */
    allowedSelections: z.array(z.string()).optional(),
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
   * Restricts a slate to leagues, by archive code.
   *
   * The goal slates are the reason: six or more goals is a 3.5% event in La
   * Liga 2 and an 11% one in the Bundesliga, and a slate that draws from both
   * alike is filled from whichever has more fixtures that week, not from
   * wherever the bet actually lands.
   */
  allowedLeagues?: string[];
  /**
   * Restricts a slate to selections, by code.
   *
   * A market can carry both sides of a question, and ranking on probability
   * picks the likelier side. In a slate built to back goals in the leagues
   * where goals are common, that produced Under 4.5, Under 3.5 and Under 2.5
   * — the likeliest outcomes, and the opposite of the point.
   */
  allowedSelections?: string[];
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
    /**
     * Ten legs, every one of them a side expected to win.
     *
     * Not a long-shot slate: the length does the work, not the prices. Ten
     * selections around 1.7 multiply past 300 on their own, so the legs can
     * stay on the safe end of the bulletin — which is the point of asking for
     * ten rather than three.
     */
    key: 'tenfold',
    category: 'HIGH_VALUE',
    // Three asked for; ten distinct fixtures each, so a thin slate delivers
    // fewer rather than repeating a fixture across them.
    couponCount: 3,
    allowedMarkets: [MARKET.MATCH_RESULT, MARKET.DOUBLE_CHANCE, MARKET.OVER_UNDER],
    /**
     * The odds floor follows the legs, not the other way round.
     *
     * Asking for 300 from ten legs is asking for an average price of 1.77,
     * which is a 56% leg — so the floor was quietly setting the quality of
     * every selection in the slate, and setting it low. Measured against the
     * live pool, the ten most probable legs available multiply to 56.3 with
     * the weakest at 57%; reaching 300 meant twelve legs and dropping to 53%.
     *
     * So the leg quality is stated directly instead of being implied by a
     * payout target: ten sides the model rates at 55% or better. Against the
     * live pool that reaches 250.8 at its longest, so a floor of 100 is
     * satisfiable — but only just, because 55% left exactly ten eligible
     * fixtures for ten legs. On a thin midweek the slate will come up empty
     * rather than reach for a weaker leg, which is the intended trade.
     */
    minTotalOdds: 100,
    minSelections: 10,
    maxSelections: 11,
    // Each leg is a side the model likes; the combination is what makes it long.
    minProbability: 0.55,
    minConfidence: 0.4,
    minEdge: NO_EDGE_REQUIREMENT,
    minExpectedValue: NO_EDGE_REQUIREMENT,
    maxRisk: 0.7,
    minCombinedProbability: 0,
    /**
     * Eight of ten, not ten of ten.
     *
     * Ten legs the model rates around 60% each land together 2.2% of the time,
     * which is a lottery ticket however good the legs are. The same ten played
     * 8/9/10 returns on eight and comes in 34.5% of the time — the selections
     * are identical, only the demand on them changes. Fifty-six columns, which
     * is on the heavy side but still a slip a reader can follow.
     *
     * The base stays at ten: at eleven legs an eight-fold system is 165
     * columns, which is a spreadsheet rather than a coupon.
     */
    system: { systemType: 'SYSTEM_8_9_10', minBaseSelections: 10, maxBaseSelections: 10 },
  },
  {
    /**
     * The Surprise category's own coupons, played as a system.
     *
     * These were straight accumulators of five to eight legs, and measured on
     * what they actually paid they were the clearest failure on the board: the
     * five settled ones had stated chances of 0.6%, 0.5%, 0.0%, 0.0% and 0.0%,
     * and all five lost. Nothing had gone wrong with the predictions — those
     * coupons were never going to land, because a long accumulator multiplies
     * the bookmaker's margin once per leg.
     *
     * The same selections as a 4/5/6 come in 42.6% of the time against 2.5%
     * straight, for twenty-two columns. That is the whole change: the legs are
     * unchanged, the demand on them is not.
     */
    key: 'surprise_system',
    category: 'HIGH_VALUE',
    couponCount: 3,
    // Every market the category allows: the change here is the shape of the
    // coupon, not which bets go into it.
    allowedMarkets: [],
    minSelections: 5,
    maxSelections: 6,
    minProbability: 0.35,
    minConfidence: 0.35,
    minEdge: NO_EDGE_REQUIREMENT,
    minExpectedValue: NO_EDGE_REQUIREMENT,
    maxRisk: 0.85,
    // A system's return comes off its columns, so the parent's 100.0 floor —
    // written for an accumulator — would refuse every one of these.
    minTotalOdds: 20,
    minCombinedProbability: 0,
    system: { systemType: 'SYSTEM_4_5_6', minBaseSelections: 5, maxBaseSelections: 6 },
  },
  {
    /**
     * The goal leagues, played as a system.
     *
     * Chosen by the archive, not by reputation: six or more goals lands in
     * 11.0% of Bundesliga matches, 9.7% of the Eredivisie's, 8.7% of
     * 2. Bundesliga's, 8.2% of Eliteserien and MLS, 8.1% of Süper Lig's, 7.1%
     * of the Superliga's and 6.6% of the Allsvenskan's — against 3.5% in La
     * Liga 2 and 3.7% in Brazil's top flight. A goal slate filled from
     * wherever the week's fixtures happen to be is filled from the wrong
     * places most weeks; this one is told where the bet lands.
     */
    key: 'goal_leagues',
    category: 'HIGH_VALUE',
    couponCount: 3,
    allowedMarkets: [MARKET.OVER_UNDER, MARKET.BTTS],
    // Goals, not their absence: the over lines that pay and both teams scoring.
    allowedSelections: ['OVER_1_5', 'OVER_2_5', 'OVER_3_5', 'BTTS_YES'],
    allowedLeagues: ['D1', 'N1', 'D2', 'NOR1', 'USA1', 'T1', 'DNK1', 'SWE1'],
    minSelections: 5,
    maxSelections: 6,
    minProbability: 0.4,
    minConfidence: 0.35,
    minEdge: NO_EDGE_REQUIREMENT,
    minExpectedValue: NO_EDGE_REQUIREMENT,
    maxRisk: 0.85,
    minTotalOdds: 20,
    minCombinedProbability: 0,
    system: { systemType: 'SYSTEM_4_5_6', minBaseSelections: 5, maxBaseSelections: 6 },
  },
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
    minEdge: NO_EDGE_REQUIREMENT,
    minExpectedValue: NO_EDGE_REQUIREMENT,
    maxRisk: 0.95,
    // Never smaller than a three: a two-leg column is barely a system. Three of
    // six is a materially harder ask than two of five, so the floor on a
    // column's chance comes down with it — the number the reader sees is the
    // chance the coupon returns, and that is reported as it falls out.
    minCombinedProbability: 0.005,
    /**
     * Five or six legs, played 3/4/5.
     *
     * Seven legs produced a 91-column slip whose total return only a
     * spreadsheet could read, and a column count that size is not a coupon a
     * reader plays — it is a number. Six legs at 3/4/5 is 41 columns, which is
     * still a real system and still legible.
     */
    system: { systemType: 'SYSTEM_3_4_5', minBaseSelections: 5, maxBaseSelections: 6 },
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
    minEdge: NO_EDGE_REQUIREMENT,
    minExpectedValue: NO_EDGE_REQUIREMENT,
    maxRisk: 0.98,
    /**
     * 6+ goals lands about once in twenty. Three of them is a hard ask however
     * it is played, so the slate is given more legs to draw three from — three
     * of eight rather than three of five — and the floor reflects what that
     * actually comes to rather than what would be nice.
     */
    minCombinedProbability: 0.0005,
    // Same shape as the İY/MS slate: five or six legs, played 3/4/5. Eight legs
    // was the widest slip in the product and the least readable.
    system: { systemType: 'SYSTEM_3_4_5', minBaseSelections: 5, maxBaseSelections: 6 },
  },
];

export const DEFAULT_CATEGORY_SETTINGS: Record<CouponCategory, CouponCategorySettings> = {
  HIGH_CONFIDENCE: {
    category: 'HIGH_CONFIDENCE',
    enabled: true,
    couponCount: 3,
    /**
     * 2.00 and a high chance pull against each other, and the pool decides
     * where they meet. Adding legs does not help: holding a floor means every
     * extra leg has to be shorter, and the shortening outruns the multiplying.
     * With the handicap markets no longer offered, 2.00 is first reachable at a
     * 55% floor — 65% caps out at 1.80. Raise the floor and the odds ceiling
     * comes down with it; there is no setting where both go up.
     */
    minTotalOdds: 2,
    maxTotalOdds: 4,
    minSelections: 2,
    maxSelections: 6,
    minConfidence: 0.6,
    // A Banko is heavy favourites at short prices. Demanding edge on top of
    // that is what emptied the category: the market prices a 92% shot keenly,
    // so the most likely legs carry almost none. Zero is the floor — we still
    // never back a selection the market rates above our own model.
    minExpectedValue: NO_EDGE_REQUIREMENT,
    minEdge: NO_EDGE_REQUIREMENT,
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
     * The safe end of the bulletin, in markets a reader already knows. 6+ goals
     * stays out — a Banko is not built on a five-percent event.
     */
    allowedMarkets: [
      MARKET.DOUBLE_CHANCE,
      MARKET.OVER_UNDER,
      MARKET.MATCH_RESULT,
      MARKET.BTTS,
      MARKET.TEAM_TOTAL,
      MARKET.HALF_TIME_RESULT,
    ],
  },
  BALANCED_PICKS: {
    category: 'BALANCED_PICKS',
    enabled: true,
    // §30's example default range.
    couponCount: 3,
    minTotalOdds: 5,
    maxTotalOdds: 6,
    minSelections: 2,
    maxSelections: 5,
    minConfidence: 0.55,
    /**
     * Zero, and deliberately.
     *
     * A positive floor here selects the candidates where the model sits
     * furthest above the price, which measures as a ranking of the model's
     * errors rather than of its value — see STRATEGIES in the coupon
     * generator for the 17,057-prediction measurement behind that.
     */
    minExpectedValue: NO_EDGE_REQUIREMENT,
    minEdge: NO_EDGE_REQUIREMENT,
    minProbability: 0.4,
    maxRisk: 0.6,
    maxCorrelation: 0.4,
    minDataQuality: 0.5,
    // 5.00 prices at roughly 20%, so the floor follows the odds down.
    minCombinedProbability: 0.15,
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
    /**
     * Zero, where a long shot used to be asked to "beat the price".
     *
     * That requirement is what made this the worst category on the board:
     * demanding edge at long odds is demanding the model's largest positive
     * errors. Its own legs came in at 24.1% against a promised 51.1%.
     */
    minExpectedValue: NO_EDGE_REQUIREMENT,
    minEdge: NO_EDGE_REQUIREMENT,
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
    minExpectedValue: NO_EDGE_REQUIREMENT,
    minEdge: NO_EDGE_REQUIREMENT,
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
  /**
   * Turkish slips combine sizes: "Sistem 3,4,5" over six legs is
   * C(6,3)+C(6,4)+C(6,5) = 41 columns on one coupon.
   *
   * Eight legs at 3,4,5 is 182 columns, which is not a slip anyone reads — the
   * total return runs to six figures and the reader cannot see what has to
   * happen for it to pay. Six is the ceiling, and only threes-and-up are
   * offered: a two-of-n fills half its columns with pairs, which returns little
   * and costs the same per column as a three.
   */
  allowedSystemTypes: ['SYSTEM_3_4_5', 'SYSTEM_4_5_6'],
  defaultSystemType: 'SYSTEM_3_4_5',
  // A system is a way of playing a set of picks, not a separate product, so it
  // is generated from a real category's pool rather than its own.
  sourceCategories: ['HIGH_VALUE'],
  minBaseSelections: 5,
  maxBaseSelections: 6,
  stakePerColumn: 1,
  maxTotalStake: 5000,
  // The operator's own currency: system stakes are real money in TL, not a
  // converted EUR figure.
  currency: 'TRY',
  minCombinedProbability: 0.02,
  // Zero for the same measured reason as every other category above.
  minExpectedValue: NO_EDGE_REQUIREMENT,
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
