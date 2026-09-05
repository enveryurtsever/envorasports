import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { Decimal, dec, toOdds } from '@/lib/math/decimal';
import { combinedProbability } from '@/lib/math/probability';
import {
  DEFAULT_SCORING_WEIGHTS,
  type CouponCategory,
  type CouponCategorySettings,
  type CouponFocusGroup,
  type CouponScoringWeights,
  type SystemCouponSettings,
} from '@/lib/config/coupon-settings';
import { getAppSetting } from '@/lib/config/settings-service';
import { dateKeyToUtcMidnight, localDateKey, type LocalDateKey } from '@/lib/time/zoned';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';
import {
  couponCorrelation,
  loadCorrelationMatrix,
  maxCorrelationWith,
  type CorrelationMatrix,
  type SelectionRef,
} from './correlation';
import { buildSystemPlan, parseSystemSizes, SystemPlanError } from '@/lib/coupons/system-math';
import {
  MARKET,
  findSelection,
  handicapDuplicatesMatchResult,
  handicapPushes,
} from '@/lib/markets/registry';

const log = createLogger('coupons:generator');

/**
 * The coupon generator (§28-§34).
 *
 * Rules it exists to enforce:
 *  - counts come from settings, never from a constant (§30)
 *  - a category that cannot be filled honestly produces fewer coupons and
 *    records why, rather than being padded with weak selections (§30.7)
 *  - the coupons within a category must be genuinely different (§32)
 *  - correlated legs are not treated as independent (§33)
 */

export interface Candidate {
  predictionId: string;
  matchId: string;
  marketCode: string;
  selectionCode: string;
  odds: Decimal;
  probability: Decimal;
  impliedProbability: Decimal;
  edge: Decimal;
  expectedValue: Decimal;
  confidence: number;
  risk: number;
  dataQuality: number;
  kickoffUtc: Date;
  targetDate: LocalDateKey;
}

export interface BuiltCoupon {
  category: CouponCategory;
  targetDate: LocalDateKey;
  strategy: string;
  selections: Candidate[];
  totalOdds: Decimal;
  estimatedProbability: Decimal;
  expectedValue: Decimal;
  confidence: number;
  risk: number;
  correlation: number;
  diversification: number;
  score: number;
}

export interface CategoryOutcome {
  category: CouponCategory;
  requested: number;
  produced: number;
  candidatePool: number;
  /** Why fewer coupons than requested were produced, when that happened. */
  shortfallReason: string | null;
}

export interface GenerationResult {
  runId: string;
  couponsGenerated: number;
  candidatesEvaluated: number;
  matchesConsidered: number;
  outcomes: CategoryOutcome[];
}

/** Ranking functions that make the coupons in a category actually differ (§32). */
const STRATEGIES = [
  { name: 'highest_ev', rank: (c: Candidate) => Number(c.expectedValue) },
  { name: 'highest_confidence', rank: (c: Candidate) => c.confidence },
  { name: 'balanced_risk', rank: (c: Candidate) => Number(c.expectedValue) * (1 - c.risk) },
  { name: 'highest_edge', rank: (c: Candidate) => Number(c.edge) },
  { name: 'best_data_quality', rank: (c: Candidate) => c.dataQuality * Number(c.probability) },
  { name: 'highest_probability', rank: (c: Candidate) => Number(c.probability) },
] as const;

export async function loadCandidates(
  window: CoverageWindow,
  timezone: string,
  modelVersionId: string,
  asOf: Date,
): Promise<Candidate[]> {
  const predictions = await prisma.prediction.findMany({
    where: {
      modelVersionId,
      /**
       * Deliberately not filtered on `recommended`. That flag is one global
       * "worth backing" bar, and it requires positive edge — which a 92%
       * favourite priced at 1.05 never has, so exactly the legs a Banko is made
       * of were being filtered out before any category could see them. Each
       * category carries its own minEdge and minExpectedValue, and
       * filterForCategory applies them; that is the gate.
       */
      status: 'PENDING',
      predictionTimestamp: { lte: asOf },
      match: {
        status: 'SCHEDULED',
        excludedFromGeneration: false,
        scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
      },
    },
    // Predictions are append-only, so a re-run leaves several generations of
    // the same selection. Newest first, then deduplicated below — otherwise the
    // candidate pool doubles every time the engine runs.
    orderBy: { predictionTimestamp: 'desc' },
    select: {
      selectionId: true,
      predictionTimestamp: true,
      id: true,
      matchId: true,
      probability: true,
      impliedProbability: true,
      oddsUsed: true,
      edge: true,
      expectedValue: true,
      confidenceScore: true,
      riskScore: true,
      dataQualityScore: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
      match: { select: { scheduledKickoffUtc: true } },
    },
  });

  const latest = new Map<string, (typeof predictions)[number]>();
  for (const prediction of predictions) {
    const key = `${prediction.matchId}:${prediction.selectionId}`;
    if (!latest.has(key)) latest.set(key, prediction);
  }

  return [...latest.values()]
    .filter((p) => p.oddsUsed !== null && p.edge !== null && p.expectedValue !== null)
    .map((p) => ({
      predictionId: p.id,
      matchId: p.matchId,
      marketCode: p.market.code,
      selectionCode: p.selection.code,
      odds: dec(p.oddsUsed as Prisma.Decimal),
      probability: dec(p.probability),
      impliedProbability: dec(p.impliedProbability ?? 0),
      edge: dec(p.edge as Prisma.Decimal),
      expectedValue: dec(p.expectedValue as Prisma.Decimal),
      confidence: Number(p.confidenceScore),
      risk: Number(p.riskScore),
      dataQuality: Number(p.dataQualityScore),
      kickoffUtc: p.match.scheduledKickoffUtc,
      targetDate: localDateKey(p.match.scheduledKickoffUtc, timezone),
    }));
}

/** Candidates that clear a category's quality bar before any coupon is built. */
export function filterForCategory(
  candidates: Candidate[],
  settings: CouponCategorySettings,
): Candidate[] {
  const allowed = new Set(settings.allowedMarkets);

  return candidates.filter((candidate) => {
    if (allowed.size > 0 && !allowed.has(candidate.marketCode)) return false;
    if (isUnofferableHandicap(candidate)) return false;
    if (Number(candidate.probability) < settings.minProbability) return false;
    if (candidate.confidence < settings.minConfidence) return false;
    if (Number(candidate.expectedValue) < settings.minExpectedValue) return false;
    if (Number(candidate.edge) < settings.minEdge) return false;
    if (candidate.risk > settings.maxRisk) return false;
    if (candidate.dataQuality < settings.minDataQuality) return false;
    return true;
  });
}

/**
 * Handicaps not offered on a coupon: whole lines, which refund on an exact
 * margin and cannot say so in a chip, and +/-0.5, which is the match result
 * under another name.
 */
function isUnofferableHandicap(candidate: Candidate): boolean {
  if (candidate.marketCode !== MARKET.ASIAN_HANDICAP) return false;
  const definition = findSelection(candidate.marketCode, candidate.selectionCode);
  const handicap = definition?.parameters?.handicap;
  if (typeof handicap !== 'number') return false;
  return handicapPushes(handicap) || handicapDuplicatesMatchResult(handicap);
}

function refOf(candidate: Candidate): SelectionRef {
  return {
    matchId: candidate.matchId,
    marketCode: candidate.marketCode,
    selectionCode: candidate.selectionCode,
  };
}

/**
 * Greedily assembles one coupon.
 *
 * It stops as soon as the configured minimums are met rather than piling on
 * legs: every extra selection multiplies the odds but divides the probability,
 * and §30 asks for the target odds band, not the longest possible accumulator.
 */
export function buildCoupon(
  pool: Candidate[],
  settings: CouponCategorySettings,
  matrix: CorrelationMatrix,
  strategy: (typeof STRATEGIES)[number],
  usedMatches: Set<string>,
  usedMarkets: Set<string>,
  weights: CouponScoringWeights,
  /**
   * Skips this many of the best-ranked candidates.
   *
   * Six strategies over a small pool keep returning the same few legs, which is
   * why a category asked for five coupons and produced two. Building the next
   * one from further down the ranking gives a genuinely different coupon out of
   * the same candidates — the legs may be shared with an earlier coupon, which
   * is allowed, but the combination is not.
   */
  offset = 0,
  /** Keeps a category's coupons on different fixtures; see `eligible` below. */
  excludeUsedMatches = false,
): BuiltCoupon | null {
  const ranked = [...pool].sort((a, b) => {
    // Push the coupon toward matches and markets the earlier coupons did not
    // use, which is what makes five coupons five different coupons.
    const noveltyA = (usedMatches.has(a.matchId) ? 0 : 0.15) + (usedMarkets.has(a.marketCode) ? 0 : 0.1);
    const noveltyB = (usedMatches.has(b.matchId) ? 0 : 0.15) + (usedMarkets.has(b.marketCode) ? 0 : 0.1);
    return strategy.rank(b) + noveltyB - (strategy.rank(a) + noveltyA);
  });

  /**
   * Matches an earlier coupon in this category already used.
   *
   * `usedMatches` had only ever nudged the ranking, so with a wide bulletin the
   * same fixture still landed in three of five Banko coupons — the reader sees
   * one match, priced three ways, presented as three tips. Excluded outright
   * here; the caller retries without the exclusion only if the category cannot
   * otherwise be filled.
   */
  const eligible = excludeUsedMatches
    ? ranked.filter((candidate) => !usedMatches.has(candidate.matchId))
    : ranked;

  const available = offset > 0 ? eligible.slice(offset) : eligible;

  const chosen: Candidate[] = [];
  const chosenMatches = new Set<string>();
  let totalOdds = dec(1);

  for (const candidate of available) {
    if (chosen.length >= settings.maxSelections) break;

    if (settings.oneSelectionPerMatch && chosenMatches.has(candidate.matchId)) continue;

    const correlation = maxCorrelationWith(matrix, refOf(candidate), chosen.map(refOf));
    if (correlation > settings.maxCorrelation) continue;

    const nextOdds = totalOdds.times(candidate.odds);
    // Overshooting the ceiling is a rejection, not something to fix later.
    if (settings.maxTotalOdds !== null && nextOdds.greaterThan(settings.maxTotalOdds)) {
      // A shorter-priced candidate may still fit, so keep scanning.
      continue;
    }

    chosen.push(candidate);
    chosenMatches.add(candidate.matchId);
    totalOdds = nextOdds;

    if (chosen.length >= settings.minSelections && totalOdds.greaterThanOrEqualTo(settings.minTotalOdds)) {
      break;
    }
  }

  if (chosen.length < settings.minSelections) return null;
  if (totalOdds.lessThan(settings.minTotalOdds)) return null;
  if (settings.maxTotalOdds !== null && totalOdds.greaterThan(settings.maxTotalOdds)) return null;

  const refs = chosen.map(refOf);
  const correlation = couponCorrelation(matrix, refs);

  // Independent combined probability, then discounted for correlation: legs
  // that move together are less likely to all land than the product implies.
  const naive = combinedProbability(chosen.map((c) => c.probability));
  const estimatedProbability = naive.times(1 - correlation * 0.25);

  // The floor on the whole coupon, not on any single leg. A category asking
  // for both long odds and a high chance produces nothing and says so, rather
  // than being satisfied by a probability bent to fit.
  if (Number(estimatedProbability) < settings.minCombinedProbability) return null;

  const couponEv = estimatedProbability.times(totalOdds).minus(1);

  /**
   * Mean leg confidence measures how well-supported each individual pick is —
   * data quality, model agreement. It is not the coupon's chance of coming in,
   * and it does not fall as legs are added, so an eight-leg surprise coupon
   * read as 77% confident on an outcome that lands 3% of the time. It stays as
   * a ranking input, where comparing coupons of similar length is exactly what
   * it is good for.
   */
  const legConfidence = chosen.reduce((sum, c) => sum + c.confidence, 0) / chosen.length;

  // What a reader means by confidence in a coupon is the chance every leg lands
  // together, which is what the joint probability already measures.
  const confidence = Number(estimatedProbability);
  const risk = chosen.reduce((sum, c) => sum + c.risk, 0) / chosen.length;

  const distinctMarkets = new Set(chosen.map((c) => c.marketCode)).size;
  const diversification = Math.min(1, distinctMarkets / Math.max(1, chosen.length));

  const score =
    Number(estimatedProbability) * weights.probabilityWeight +
    Number(couponEv) * weights.valueWeight +
    legConfidence * weights.confidenceWeight +
    diversification * weights.diversificationWeight -
    correlation * weights.correlationPenalty -
    risk * weights.riskPenalty;

  return {
    category: settings.category,
    targetDate: chosen[0]!.targetDate,
    strategy: strategy.name,
    selections: chosen,
    totalOdds: toOdds(totalOdds),
    estimatedProbability,
    expectedValue: couponEv,
    confidence,
    risk,
    correlation,
    diversification,
    score,
  };
}

/**
 * Probability that any one k-selection column lands, approximated from the
 * geometric mean of the base selections.
 *
 * Exact would mean averaging over all C(n,k) subsets; the geometric mean gives
 * the same answer for a uniform set and is close enough for a threshold check,
 * at a fraction of the cost.
 */
export function expectedColumnProbability(probabilities: number[], k: number): number {
  if (probabilities.length === 0 || k <= 0) return 0;
  const usable = probabilities.filter((p) => p > 0);
  if (usable.length === 0) return 0;

  const logSum = usable.reduce((sum, p) => sum + Math.log(p), 0);
  const geometricMean = Math.exp(logSum / usable.length);
  return geometricMean ** k;
}

/** How many extra coupons to build so the likeliest can be chosen. */
const OVERBUILD = 3;

/** Two coupons sharing most of their legs are one coupon (§32). */
function isDistinct(coupon: BuiltCoupon, existing: BuiltCoupon[]): boolean {
  const ids = new Set(coupon.selections.map((s) => s.predictionId));

  return existing.every((other) => {
    const otherIds = new Set(other.selections.map((s) => s.predictionId));
    const overlap = [...ids].filter((id) => otherIds.has(id)).length;
    return overlap / Math.max(ids.size, otherIds.size) < 0.7;
  });
}

export function buildCategoryCoupons(
  candidates: Candidate[],
  settings: CouponCategorySettings,
  matrix: CorrelationMatrix,
  weights: CouponScoringWeights,
  groupKeys: LocalDateKey[],
): { coupons: BuiltCoupon[]; poolSize: number; shortfallReason: string | null } {
  const pool = filterForCategory(candidates, settings);
  if (pool.length === 0) {
    return { coupons: [], poolSize: 0, shortfallReason: 'no_candidate_met_thresholds' };
  }

  const coupons: BuiltCoupon[] = [];
  const usedMatches = new Set<string>();
  const usedMarkets = new Set<string>();

  /**
   * Spread the requested count across the match days that actually have
   * candidates.
   *
   * Dividing by every day in the window caps a category at ceil(count/days)
   * even when only one day has fixtures — five coupons over a four-day window
   * became two, every time, and the shortfall was reported as a thin candidate
   * pool rather than as the arithmetic it was.
   */
  const activeKeys = groupKeys.filter((key) => pool.some((c) => c.targetDate === key));
  const perGroup = Math.max(1, Math.ceil(settings.couponCount / Math.max(1, activeKeys.length)));

  for (const groupKey of activeKeys) {
    const groupPool = pool.filter((c) => c.targetDate === groupKey);

    // Six strategies over a small pool converge on the same few legs, which is
    // why a category asked for five and produced two. Once they are exhausted
    // the same strategies run again from further down the ranking, which yields
    // a different combination out of the same candidates. Legs may repeat
    // across coupons; a whole coupon may not.
    const maxAttempts = STRATEGIES.length * 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (coupons.length >= settings.couponCount * OVERBUILD) break;
      if (coupons.filter((c) => c.targetDate === groupKey).length >= perGroup) break;

      const strategy = STRATEGIES[attempt % STRATEGIES.length]!;
      const offset = Math.floor(attempt / STRATEGIES.length);

      const coupon = buildCoupon(
        groupPool,
        settings,
        matrix,
        strategy,
        usedMatches,
        usedMarkets,
        weights,
        offset,
        true,
      );
      if (!coupon || !isDistinct(coupon, coupons)) continue;

      coupons.push(coupon);
      coupon.selections.forEach((s) => {
        usedMatches.add(s.matchId);
        usedMarkets.add(s.marketCode);
      });
    }
  }

  // Build past the requested count so there is something to choose between,
  // then keep the likeliest. Any day may fill what the per-day share left over.
  const target = settings.couponCount * OVERBUILD;

  if (coupons.length < target) {
    for (const groupKey of activeKeys) {
      if (coupons.length >= target) break;
      const groupPool = pool.filter((c) => c.targetDate === groupKey);

      for (let attempt = 0; attempt < STRATEGIES.length * 5; attempt++) {
        if (coupons.length >= target) break;

        const coupon = buildCoupon(
          groupPool,
          settings,
          matrix,
          STRATEGIES[attempt % STRATEGIES.length]!,
          usedMatches,
          usedMarkets,
          weights,
          Math.floor(attempt / STRATEGIES.length),
        );
        if (!coupon || !isDistinct(coupon, coupons)) continue;

        coupons.push(coupon);
        coupon.selections.forEach((s) => {
          usedMatches.add(s.matchId);
          usedMarkets.add(s.marketCode);
        });
      }
    }
  }

  /**
   * Rank by the chance the coupon lands and keep the best.
   *
   * The strategies produce coupons in the order they were tried, which is an
   * artefact of the ranking function rather than a judgement. What a reader
   * should be shown first is the one most likely to come in, so the slate is
   * built past the requested count and then cut down to the likeliest.
   */
  coupons.sort((a, b) => Number(b.estimatedProbability) - Number(a.estimatedProbability));

  /**
   * Take the likeliest coupons that do not repeat a fixture.
   *
   * Ranking alone puts the same safe legs at the top of every coupon, so a
   * category of five showed one match three times, priced three ways. Selection
   * happens after ranking: walk down the list and skip a coupon whose fixtures
   * are already spoken for. Repeats are only allowed at the end, if the slate
   * cannot be filled without them — an honest shortfall beats a padded one, but
   * a duplicate beats an empty slot.
   */
  const chosen: BuiltCoupon[] = [];
  const spokenFor = new Set<string>();

  for (const coupon of coupons) {
    if (chosen.length >= settings.couponCount) break;
    if (coupon.selections.some((s) => spokenFor.has(s.matchId))) continue;
    chosen.push(coupon);
    coupon.selections.forEach((s) => spokenFor.add(s.matchId));
  }

  for (const coupon of coupons) {
    if (chosen.length >= settings.couponCount) break;
    if (!chosen.includes(coupon)) chosen.push(coupon);
  }

  const shortfallReason =
    chosen.length >= settings.couponCount
      ? null
      : chosen.length === 0
        ? 'no_valid_combination_within_odds_band'
        : 'insufficient_distinct_candidates';

  return { coupons: chosen, poolSize: pool.length, shortfallReason };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function referenceFor(category: CouponCategory, targetDate: string, index: number): string {
  const prefix = {
    HIGH_CONFIDENCE: 'HC',
    BALANCED_PICKS: 'BP',
    HIGH_VALUE: 'HV',
    COMBINATION_SYSTEM: 'CS',
  }[category];
  return `${prefix}-${targetDate}-${String(index + 1).padStart(2, '0')}`;
}

export interface GenerateOptions {
  window: CoverageWindow;
  timezone: string;
  grouping: 'PER_DAY' | 'WINDOW';
  modelVersionId: string;
  settingsSnapshotId: string;
  categorySettings: Record<CouponCategory, CouponCategorySettings>;
  systemSettings: SystemCouponSettings;
  /** Market-specific slates inside a category; empty means none. */
  focusGroups?: CouponFocusGroup[];
  asOf?: Date;
}

export async function generateCoupons(options: GenerateOptions): Promise<GenerationResult> {
  const asOf = options.asOf ?? new Date();
  const publicationDate = dateKeyToUtcMidnight(options.window.publicationDate);

  const weights = await getAppSetting<CouponScoringWeights>(
    'scoring.weights',
    DEFAULT_SCORING_WEIGHTS,
  );

  const [candidates, matrix] = await Promise.all([
    loadCandidates(options.window, options.timezone, options.modelVersionId, asOf),
    loadCorrelationMatrix(),
  ]);

  const run = await prisma.couponGenerationRun.upsert({
    where: {
      publicationDate_modelVersionId: {
        publicationDate,
        modelVersionId: options.modelVersionId,
      },
    },
    update: { status: 'RUNNING', startedAt: new Date(), error: null },
    create: {
      publicationDate,
      coverageStartDate: dateKeyToUtcMidnight(options.window.startDate),
      coverageEndDate: dateKeyToUtcMidnight(options.window.endDate),
      scheduleTimezone: options.timezone,
      grouping: options.grouping,
      modelVersionId: options.modelVersionId,
      settingsSnapshotId: options.settingsSnapshotId,
      status: 'RUNNING',
      startedAt: new Date(),
    },
  });

  // Regenerating a day replaces that day's coupons rather than duplicating.
  await prisma.coupon.deleteMany({ where: { generationRunId: run.id } });

  const groupKeys =
    options.grouping === 'PER_DAY' ? options.window.days : [options.window.startDate];

  const outcomes: CategoryOutcome[] = [];
  let couponsGenerated = 0;

  for (const [category, settings] of Object.entries(options.categorySettings) as Array<
    [CouponCategory, CouponCategorySettings]
  >) {
    if (!settings.enabled || settings.couponCount === 0) {
      outcomes.push({
        category,
        requested: settings.couponCount,
        produced: 0,
        candidatePool: 0,
        shortfallReason: settings.enabled ? null : 'category_disabled',
      });
      continue;
    }

    if (category === 'COMBINATION_SYSTEM') continue; // handled separately

    const { coupons, poolSize, shortfallReason } = buildCategoryCoupons(
      candidates,
      settings,
      matrix,
      weights,
      groupKeys,
    );

    for (const [index, coupon] of coupons.entries()) {
      await persistCoupon(coupon, run.id, options, index);
      couponsGenerated++;
    }

    outcomes.push({
      category,
      requested: settings.couponCount,
      produced: coupons.length,
      candidatePool: poolSize,
      shortfallReason,
    });
  }

  /**
   * Focus groups: market-specific slates inside a category.
   *
   * Surprise is one bucket of long shots, which is hard to read — an İY/MS
   * coupon and a 6+ goals coupon are different bets. Each group runs the parent
   * category's rules with the markets narrowed, and the coupons carry the group
   * key as their strategy so the page can section them.
   */
  // Each group gets its own block of reference numbers; two groups in the same
  // category starting from the same offset collide on the reference.
  let focusOffset = 1000;

  for (const group of options.focusGroups ?? []) {
    const parent = options.categorySettings[group.category];
    if (!parent || !parent.enabled || group.couponCount === 0) continue;

    const settings: CouponCategorySettings = {
      ...parent,
      couponCount: group.couponCount,
      allowedMarkets: group.allowedMarkets,
      minTotalOdds: group.minTotalOdds ?? parent.minTotalOdds,
      minCombinedProbability: group.minCombinedProbability ?? parent.minCombinedProbability,
      minSelections: group.minSelections ?? parent.minSelections,
      maxSelections: group.maxSelections ?? parent.maxSelections,
      minProbability: group.minProbability ?? parent.minProbability,
      minConfidence: group.minConfidence ?? parent.minConfidence,
      minEdge: group.minEdge ?? parent.minEdge,
      minExpectedValue: group.minExpectedValue ?? parent.minExpectedValue,
      maxRisk: group.maxRisk ?? parent.maxRisk,
    };

    if (group.system) {
      // Played as a system: the same narrowed markets, but returning on k of n
      // rather than only when every leg lands.
      const { outcome } = await generateSystemCoupons(
        candidates,
        matrix,
        options,
        run.id,
        weights,
        groupKeys,
        group.category,
        focusOffset,
        {
          settings,
          couponCount: group.couponCount,
          systemType: group.system.systemType,
          minBaseSelections: group.system.minBaseSelections,
          maxBaseSelections: group.system.maxBaseSelections,
          minCombinedProbability: group.minCombinedProbability,
          strategyLabel: `focus_${group.key}`,
        },
      );
      couponsGenerated += outcome.produced;
      outcomes.push(outcome);
      focusOffset += 100;
      continue;
    }

    const built = buildCategoryCoupons(candidates, settings, matrix, weights, groupKeys);

    for (const [index, coupon] of built.coupons.entries()) {
      await persistCoupon(
        { ...coupon, strategy: `focus_${group.key}` },
        run.id,
        options,
        focusOffset + index,
      );
      couponsGenerated++;
    }

    focusOffset += 100;

    outcomes.push({
      category: group.category,
      requested: group.couponCount,
      produced: built.coupons.length,
      candidatePool: built.poolSize,
      shortfallReason: built.shortfallReason,
    });
  }

  // System coupons last: they reuse the same candidate pool, and can be built
  // from more than one category — a high-variance set benefits most, since a
  // system only needs k of n legs to return anything.
  for (const sourceCategory of options.systemSettings.sourceCategories) {
    const settings = options.categorySettings[sourceCategory as CouponCategory];
    if (!settings) continue;

    const systemOutcome = await generateSystemCoupons(
      candidates,
      matrix,
      options,
      run.id,
      weights,
      groupKeys,
      sourceCategory as CouponCategory,
      couponsGenerated,
    );
    outcomes.push(systemOutcome.outcome);
    couponsGenerated += systemOutcome.produced;
  }

  await prisma.couponGenerationRun.update({
    where: { id: run.id },
    data: {
      status: 'SUCCESS',
      finishedAt: new Date(),
      matchesConsidered: new Set(candidates.map((c) => c.matchId)).size,
      candidatesEvaluated: candidates.length,
      couponsGenerated,
      // §30.7: record why a category came up short instead of hiding it.
      shortfallReasons: outcomes as unknown as Prisma.InputJsonValue,
    },
  });

  log.info('coupon generation complete', {
    publicationDate: options.window.publicationDate,
    couponsGenerated,
    candidates: candidates.length,
  });

  return {
    runId: run.id,
    couponsGenerated,
    candidatesEvaluated: candidates.length,
    matchesConsidered: new Set(candidates.map((c) => c.matchId)).size,
    outcomes,
  };
}

async function persistCoupon(
  coupon: BuiltCoupon,
  runId: string,
  options: GenerateOptions,
  index: number,
): Promise<string> {
  const kickoffs = coupon.selections.map((s) => s.kickoffUtc.getTime());

  const created = await prisma.coupon.create({
    data: {
      generationRunId: runId,
      category: coupon.category,
      kind: 'STANDARD',
      reference: referenceFor(coupon.category, coupon.targetDate, index),
      name: coupon.strategy,
      targetDate: dateKeyToUtcMidnight(coupon.targetDate),
      firstKickoffUtc: new Date(Math.min(...kickoffs)),
      lastKickoffUtc: new Date(Math.max(...kickoffs)),
      totalOdds: new Prisma.Decimal(coupon.totalOdds.toFixed(4)),
      estimatedProbability: new Prisma.Decimal(coupon.estimatedProbability.toFixed(8)),
      expectedValue: new Prisma.Decimal(coupon.expectedValue.toFixed(6)),
      confidenceScore: new Prisma.Decimal(coupon.confidence.toFixed(4)),
      riskScore: new Prisma.Decimal(coupon.risk.toFixed(4)),
      correlationScore: new Prisma.Decimal(coupon.correlation.toFixed(4)),
      diversificationScore: new Prisma.Decimal(coupon.diversification.toFixed(4)),
      score: new Prisma.Decimal(coupon.score.toFixed(6)),
      selectionCount: coupon.selections.length,
      modelVersionId: options.modelVersionId,
      settingsSnapshotId: options.settingsSnapshotId,
      generationTimestamp: new Date(),
      selections: {
        create: coupon.selections.map((selection, order) => ({
          predictionId: selection.predictionId,
          matchId: selection.matchId,
          marketCode: selection.marketCode,
          selectionCode: selection.selectionCode,
          odds: new Prisma.Decimal(selection.odds.toFixed(3)),
          probability: new Prisma.Decimal(selection.probability.toFixed(8)),
          impliedProbability: new Prisma.Decimal(selection.impliedProbability.toFixed(8)),
          edge: new Prisma.Decimal(selection.edge.toFixed(6)),
          expectedValue: new Prisma.Decimal(selection.expectedValue.toFixed(6)),
          sortOrder: order,
        })),
      },
    },
    select: { id: true },
  });

  return created.id;
}

/**
 * System coupons (§18).
 *
 * A base set of selections is chosen the same way as a normal coupon, then
 * every k-combination becomes an independently settled column.
 */
async function generateSystemCoupons(
  candidates: Candidate[],
  matrix: CorrelationMatrix,
  options: GenerateOptions,
  runId: string,
  weights: CouponScoringWeights,
  groupKeys: LocalDateKey[],
  sourceCategory: CouponCategory,
  referenceOffset: number,
  /**
   * Lets a focus slate be played as a system too. Surprise coupons are all
   * systems now: a straight seven-leg accumulator returns nothing unless every
   * leg lands, while the same seven as a 3/4/5 returns on three — the same
   * selections, a real chance of a return instead of a notional one.
   */
  override: {
    settings?: CouponCategorySettings;
    couponCount?: number;
    systemType?: string;
    minBaseSelections?: number;
    maxBaseSelections?: number;
    minCombinedProbability?: number;
    strategyLabel?: string;
  } = {},
): Promise<{ outcome: CategoryOutcome; produced: number }> {
  const baseSystem = options.systemSettings;
  const system = {
    ...baseSystem,
    couponCount: override.couponCount ?? baseSystem.couponCount,
    defaultSystemType: override.systemType ?? baseSystem.defaultSystemType,
    minBaseSelections: override.minBaseSelections ?? baseSystem.minBaseSelections,
    maxBaseSelections: override.maxBaseSelections ?? baseSystem.maxBaseSelections,
    // A 6+ goals system cannot clear the general slate's floor: two of four
    // five-percent events is a low number however it is played.
    minCombinedProbability:
      override.minCombinedProbability ?? baseSystem.minCombinedProbability,
  };
  const settings = override.settings ?? options.categorySettings[sourceCategory];

  const outcome: CategoryOutcome = {
    category: sourceCategory,
    requested: system.couponCount,
    produced: 0,
    candidatePool: 0,
    shortfallReason: null,
  };

  if (!system.enabled || system.couponCount === 0) {
    outcome.shortfallReason = 'systems_disabled';
    return { outcome, produced: 0 };
  }

  const sizes = parseSystemSizes(system.defaultSystemType);
  if (sizes.length === 0) {
    outcome.shortfallReason = 'invalid_system_type';
    return { outcome, produced: 0 };
  }
  const smallestSize = sizes[0] as number;

  const pool = filterForCategory(candidates, settings);
  outcome.candidatePool = pool.length;

  if (pool.length < system.minBaseSelections) {
    outcome.shortfallReason = 'insufficient_candidates_for_base_set';
    return { outcome, produced: 0 };
  }

  let produced = 0;

  /**
   * One base set per day gave one system per day, so a slate of three needed
   * three separate match days and quietly produced one. Each pass starts
   * further down the ranking instead, which yields a genuinely different base
   * set out of the same day's candidates.
   */
  const attemptsPerDay = Math.max(1, system.couponCount);

  for (const groupKey of groupKeys) {
    if (produced >= system.couponCount) break;

    const dayPool = pool
      .filter((c) => c.targetDate === groupKey)
      .sort((a, b) => Number(b.expectedValue) - Number(a.expectedValue));

    for (let pass = 0; pass < attemptsPerDay; pass++) {
    if (produced >= system.couponCount) break;

    // Each pass drops the previous pass's strongest leg, so the sets overlap
    // without repeating. Legs may be shared between systems; a whole set is not.
    const groupPool = pass === 0 ? dayPool : dayPool.slice(pass);

    const base: Candidate[] = [];
    const usedMatches = new Set<string>();

    for (const candidate of groupPool) {
      if (base.length >= system.maxBaseSelections) break;
      if (system.oneSelectionPerMatch && usedMatches.has(candidate.matchId)) continue;
      if (maxCorrelationWith(matrix, refOf(candidate), base.map(refOf)) > system.maxCorrelation) {
        continue;
      }
      base.push(candidate);
      usedMatches.add(candidate.matchId);
    }

    if (base.length < system.minBaseSelections || base.length < Math.max(...sizes)) continue;

    let plan;
    try {
      plan = buildSystemPlan({
        selections: base.map((c) => ({
          id: c.predictionId,
          odds: c.odds,
          matchId: c.matchId,
          probability: c.probability,
        })),
        systemSizes: sizes,
        stakePerColumn: system.stakePerColumn,
        maxTotalStake: system.maxTotalStake,
      });
    } catch (error) {
      // An unaffordable or impossible system is skipped, not forced.
      outcome.shortfallReason =
        error instanceof SystemPlanError ? 'system_exceeds_stake_limit' : 'invalid_system_plan';
      continue;
    }

    const refs = base.map(refOf);
    const correlation = couponCorrelation(matrix, refs);
    const naive = combinedProbability(base.map((c) => c.probability));

    // The meaningful probability for a system is that a *column* lands, not
    // that every base selection does. Requiring all 8 of a System-3's legs to
    // win would reject every system ever built — the whole point is that only
    // k of them need to come in.
    // The easiest size to land is the one that decides whether the system is
    // worth offering at all.
    const columnProbability = expectedColumnProbability(
      base.map((c) => Number(c.probability)),
      smallestSize,
    );
    if (columnProbability < system.minCombinedProbability) {
      outcome.shortfallReason = 'column_probability_below_minimum';
      continue;
    }

    const totalOdds = base.reduce<Decimal>((product, c) => product.times(c.odds), dec(1));
    // Ranking input only — see the note on legConfidence above.
    const legConfidence = base.reduce((sum, c) => sum + c.confidence, 0) / base.length;
    const risk = base.reduce((sum, c) => sum + c.risk, 0) / base.length;
    const distinctMarkets = new Set(base.map((c) => c.marketCode)).size;
    const diversification = Math.min(1, distinctMarkets / base.length);

    // A system is judged on its columns: the chance it returns anything, and
    // the expected return against the whole stake. Using the product of every
    // leg would report a probability near zero and an absurd expected value,
    // because a system never needed all of them to land.
    const estimatedProbability = plan.returnProbability !== null
      ? dec(plan.returnProbability)
      : naive;
    const couponEv =
      plan.expectedReturn !== null && plan.totalStake.greaterThan(0)
        ? plan.expectedReturn.dividedBy(plan.totalStake).minus(1)
        : naive.times(totalOdds).minus(1);

    const built: BuiltCoupon = {
      // The system keeps the category it was drawn from, so a Surprise system
      // is filed under Surprise rather than in a separate bucket.
      category: sourceCategory,
      targetDate: groupKey,
      strategy: override.strategyLabel ?? `system_${plan.systemLabel}`,
      selections: base,
      totalOdds: toOdds(totalOdds),
      estimatedProbability,
      expectedValue: couponEv,
      confidence: Number(estimatedProbability),
      risk,
      correlation,
      diversification,
      score:
        Number(estimatedProbability) * weights.probabilityWeight +
        Number(couponEv) * weights.valueWeight +
        legConfidence * weights.confidenceWeight +
        diversification * weights.diversificationWeight -
        correlation * weights.correlationPenalty -
        risk * weights.riskPenalty,
    };

    const couponId = await persistCoupon(built, runId, options, referenceOffset + produced);
    await prisma.coupon.update({ where: { id: couponId }, data: { kind: 'SYSTEM' } });

    const couponSelections = await prisma.couponSelection.findMany({
      where: { couponId },
      select: { id: true, predictionId: true },
    });
    const selectionIdByPrediction = new Map(
      couponSelections.map((s) => [s.predictionId, s.id]),
    );

    const systemCoupon = await prisma.systemCoupon.create({
      data: {
        couponId,
        systemType: plan.systemType,
        baseSelectionCount: plan.baseSelectionCount,
        systemSelectionCount: plan.systemSelectionCount,
        systemSizes: plan.systemSizes,
        columnCount: plan.columnCount,
        stakePerColumn: new Prisma.Decimal(plan.stakePerColumn.toFixed(2)),
        totalStake: new Prisma.Decimal(plan.totalStake.toFixed(2)),
        maxReturn: new Prisma.Decimal(plan.maxReturn.toFixed(2)),
        currency: system.currency,
      },
      select: { id: true },
    });

    await prisma.systemCouponColumn.createMany({
      data: plan.columns.map((column) => ({
        systemCouponId: systemCoupon.id,
        columnIndex: column.columnIndex,
        size: column.size,
        combinedOdds: new Prisma.Decimal(column.combinedOdds.toFixed(4)),
        stake: new Prisma.Decimal(column.stake.toFixed(2)),
      })),
    });

    const columns = await prisma.systemCouponColumn.findMany({
      where: { systemCouponId: systemCoupon.id },
      select: { id: true, columnIndex: true },
    });
    const columnIdByIndex = new Map(columns.map((c) => [c.columnIndex, c.id]));

    const links = plan.columns.flatMap((column) => {
      const columnId = columnIdByIndex.get(column.columnIndex);
      if (!columnId) return [];
      return column.selectionIds.flatMap((predictionId) => {
        const couponSelectionId = selectionIdByPrediction.get(predictionId);
        return couponSelectionId ? [{ columnId, couponSelectionId }] : [];
      });
    });

    for (let i = 0; i < links.length; i += 2000) {
      await prisma.systemCouponColumnSelection.createMany({
        data: links.slice(i, i + 2000),
        skipDuplicates: true,
      });
    }

    produced++;
    }
  }

  outcome.produced = produced;
  if (produced < system.couponCount && !outcome.shortfallReason) {
    outcome.shortfallReason = 'insufficient_candidates_for_base_set';
  }

  return { outcome, produced };
}
