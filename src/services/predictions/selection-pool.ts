import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { getAppSetting } from '@/lib/config/settings-service';
import { DEFAULT_ODDS_MAX_AGE_MINUTES } from './prediction-engine';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';

const log = createLogger('predictions:pool');

/**
 * The master selection pool.
 *
 * Coupons used to be assembled straight from predictions, which put the
 * eligibility rules inside the coupon builder — so every category re-derived
 * them, slightly differently, and "how many backable selections did we have
 * today" had no answer at all.
 *
 * One pool decides what is fit to back. The builders then only decide how to
 * combine it. Nothing is dropped silently: an ineligible selection is stored
 * with the reason it failed, which is what turns "we made eight coupons" into
 * "we made eight because eleven selections were stale and nine were on
 * three-match teams".
 */

export type FreshnessBand = 'FRESH' | 'AGING' | 'STALE';

export const REASON = {
  STALE_ODDS: 'STALE_ODDS',
  MISSING_MARKET: 'MISSING_MARKET',
  LOW_CONFIDENCE: 'LOW_CONFIDENCE',
  LOW_DATA_QUALITY: 'LOW_DATA_QUALITY',
  INSUFFICIENT_HISTORY: 'INSUFFICIENT_HISTORY',
  MISSING_XG: 'MISSING_XG',
  BELOW_MIN_PROBABILITY: 'BELOW_MIN_PROBABILITY',
  NEGATIVE_EV: 'NEGATIVE_EV',
  NO_MARKET_PRICE: 'NO_MARKET_PRICE',
} as const;

export interface PoolThresholds {
  minProbability: number;
  minExpectedValue: number;
  minConfidence: number;
  minDataQuality: number;
  freshMinutes: number;
  staleMinutes: number;
}

export async function loadPoolThresholds(): Promise<PoolThresholds> {
  const [minProbability, minExpectedValue, minConfidence, minDataQuality, freshMinutes, staleMinutes] =
    await Promise.all([
      getAppSetting<number>('pool.minProbability', 0.2),
      getAppSetting<number>('pool.minExpectedValue', -0.05),
      getAppSetting<number>('pool.minConfidence', 0.35),
      getAppSetting<number>('pool.minDataQuality', 0.3),
      getAppSetting<number>('odds.freshMinutes', 120),
      getAppSetting<number>('prediction.oddsMaxAgeMinutes', DEFAULT_ODDS_MAX_AGE_MINUTES),
    ]);
  return {
    minProbability,
    minExpectedValue,
    minConfidence,
    minDataQuality,
    freshMinutes,
    staleMinutes,
  };
}

export function classifyFreshness(ageMinutes: number, thresholds: PoolThresholds): FreshnessBand {
  if (ageMinutes <= thresholds.freshMinutes) return 'FRESH';
  if (ageMinutes <= thresholds.staleMinutes) return 'AGING';
  return 'STALE';
}

export interface PoolBuildResult {
  predictionsConsidered: number;
  eligible: number;
  rejected: number;
  /** How many selections each reason code accounted for. */
  reasons: Record<string, number>;
  /** Distinct fixtures and leagues represented among the eligible selections. */
  fixtures: number;
  leagues: number;
  marketsCovered: string[];
}

export interface BuildPoolOptions {
  window: CoverageWindow;
  modelVersionId: string;
  generationRunId: string;
  asOf?: Date;
}

export async function buildSelectionPool(options: BuildPoolOptions): Promise<PoolBuildResult> {
  const asOf = options.asOf ?? new Date();
  const thresholds = await loadPoolThresholds();

  const predictions = await prisma.prediction.findMany({
    where: {
      modelVersionId: options.modelVersionId,
      supersededAt: null,
      status: 'PENDING',
      predictionTimestamp: { lte: asOf },
      match: {
        status: 'SCHEDULED',
        excludedFromGeneration: false,
        scheduledKickoffUtc: { gte: options.window.startUtc, lt: options.window.endUtc },
      },
    },
    orderBy: { predictionTimestamp: 'desc' },
    select: {
      id: true,
      matchId: true,
      probability: true,
      marketProbability: true,
      impliedProbability: true,
      fairOdds: true,
      oddsUsed: true,
      oddsCapturedAt: true,
      oddsAgeMinutes: true,
      edge: true,
      expectedValue: true,
      confidenceScore: true,
      riskScore: true,
      dataQualityScore: true,
      breakdown: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
      match: { select: { leagueId: true } },
    },
  });

  // Predictions are append-only; keep the newest view of each selection.
  const latest = new Map<string, (typeof predictions)[number]>();
  for (const prediction of predictions) {
    const key = `${prediction.matchId}:${prediction.selection.code}`;
    if (!latest.has(key)) latest.set(key, prediction);
  }

  const result: PoolBuildResult = {
    predictionsConsidered: latest.size,
    eligible: 0,
    rejected: 0,
    reasons: {},
    fixtures: 0,
    leagues: 0,
    marketsCovered: [],
  };

  const note = (code: string) => {
    result.reasons[code] = (result.reasons[code] ?? 0) + 1;
  };

  /**
   * How rare a market and a league are in this pool.
   *
   * A selection from the only Greek fixture on the slate widens a coupon more
   * than the fifth pick from the Championship, and that is worth knowing before
   * the builder starts rather than after it has spent its slots.
   */
  const leagueCounts = new Map<string, number>();
  const marketCounts = new Map<string, number>();
  for (const prediction of latest.values()) {
    leagueCounts.set(
      prediction.match.leagueId,
      (leagueCounts.get(prediction.match.leagueId) ?? 0) + 1,
    );
    marketCounts.set(prediction.market.code, (marketCounts.get(prediction.market.code) ?? 0) + 1);
  }
  const maxLeague = Math.max(1, ...leagueCounts.values());
  const maxMarket = Math.max(1, ...marketCounts.values());

  const rows: Prisma.SelectionPoolCreateManyInput[] = [];
  const eligibleFixtures = new Set<string>();
  const eligibleLeagues = new Set<string>();
  const eligibleMarkets = new Set<string>();

  for (const prediction of latest.values()) {
    if (prediction.oddsUsed === null) {
      note(REASON.MISSING_MARKET);
      continue;
    }

    const ageMinutes = prediction.oddsAgeMinutes ?? Number.MAX_SAFE_INTEGER;
    const freshness = classifyFreshness(ageMinutes, thresholds);

    const probability = Number(prediction.probability);
    const marketProbability =
      prediction.marketProbability === null ? null : Number(prediction.marketProbability);
    const expectedValue = Number(prediction.expectedValue ?? 0);
    const confidence = Number(prediction.confidenceScore);
    const dataQuality = Number(prediction.dataQualityScore);

    /**
     * Probability points, not a ratio.
     *
     * A model at 55% against a market at 32% is 23 points apart. Calling that
     * "a 23% edge" invites it to be read as a return, which it is not — the
     * return is the expected value, computed separately from the price.
     */
    const probabilityEdge = marketProbability === null ? null : probability - marketProbability;

    const reasons: string[] = [];
    if (freshness === 'STALE') reasons.push(REASON.STALE_ODDS);
    if (probability < thresholds.minProbability) reasons.push(REASON.BELOW_MIN_PROBABILITY);
    if (expectedValue < thresholds.minExpectedValue) reasons.push(REASON.NEGATIVE_EV);
    if (confidence < thresholds.minConfidence) reasons.push(REASON.LOW_CONFIDENCE);
    if (dataQuality < thresholds.minDataQuality) reasons.push(REASON.LOW_DATA_QUALITY);
    if (marketProbability === null) reasons.push(REASON.NO_MARKET_PRICE);

    // Recorded as a penalty, never as a disqualification: the ensemble already
    // carries xG at weight zero, so its absence is the normal case, not a fault.
    const breakdown = prediction.breakdown as { models?: Record<string, unknown> } | null;
    const xg = breakdown?.models?.xg as { reason?: string } | undefined;
    if (xg?.reason) reasons.push(REASON.MISSING_XG);

    const sample = readSampleSize(breakdown);
    if (sample !== null && sample < 5) reasons.push(REASON.INSUFFICIENT_HISTORY);

    // A selection is eligible unless something disqualifying is against it.
    // MISSING_XG and NO_MARKET_PRICE are recorded but do not disqualify.
    const disqualifying = reasons.filter(
      (code) => code !== REASON.MISSING_XG && code !== REASON.NO_MARKET_PRICE,
    );
    const eligible = disqualifying.length === 0;

    if (eligible) {
      result.eligible++;
      eligibleFixtures.add(prediction.matchId);
      eligibleLeagues.add(prediction.match.leagueId);
      eligibleMarkets.add(prediction.market.code);
    } else {
      result.rejected++;
      for (const code of disqualifying) note(code);
    }

    const leagueRarity = 1 - (leagueCounts.get(prediction.match.leagueId) ?? 1) / maxLeague;
    const marketRarity = 1 - (marketCounts.get(prediction.market.code) ?? 1) / maxMarket;
    const diversityScore = Math.max(0, Math.min(1, leagueRarity * 0.6 + marketRarity * 0.4));

    rows.push({
      generationRunId: options.generationRunId,
      matchId: prediction.matchId,
      predictionId: prediction.id,
      marketCode: prediction.market.code,
      selectionCode: prediction.selection.code,
      odds: prediction.oddsUsed,
      oddsSource: freshness,
      oddsCapturedAt: prediction.oddsCapturedAt ?? asOf,
      oddsAgeMinutes: Math.min(ageMinutes, 2_000_000_000),
      oddsFreshness: freshness,
      bookmakerCount: readQuoteCount(breakdown),
      modelProbability: prediction.probability,
      marketProbability: prediction.marketProbability,
      fairOdds: prediction.fairOdds,
      probabilityEdge:
        probabilityEdge === null ? null : new Prisma.Decimal(probabilityEdge.toFixed(6)),
      expectedValue: prediction.expectedValue ?? new Prisma.Decimal(0),
      confidence: prediction.confidenceScore,
      riskScore: prediction.riskScore,
      dataQualityScore: prediction.dataQualityScore,
      diversityScore: new Prisma.Decimal(diversityScore.toFixed(4)),
      eligible,
      reasonCodes: reasons,
      leagueId: prediction.match.leagueId,
      modelVersionId: options.modelVersionId,
      builtAt: asOf,
    });
  }

  if (rows.length > 0) {
    // Rebuilt per generation run, so a re-run replaces its own pool rather than
    // stacking a second copy beside it.
    await prisma.selectionPool.deleteMany({ where: { generationRunId: options.generationRunId } });
    await prisma.selectionPool.createMany({ data: rows, skipDuplicates: true });
  }

  result.fixtures = eligibleFixtures.size;
  result.leagues = eligibleLeagues.size;
  result.marketsCovered = [...eligibleMarkets].sort();

  log.info('selection pool built', {
    considered: result.predictionsConsidered,
    eligible: result.eligible,
    fixtures: result.fixtures,
    leagues: result.leagues,
    reasons: result.reasons,
  });
  return result;
}

/** Smallest sample either side had, from the stored feature breakdown. */
function readSampleSize(breakdown: { models?: Record<string, unknown> } | null): number | null {
  const models = breakdown?.models;
  if (!models) return null;

  const sizes: number[] = [];
  for (const features of Object.values(models)) {
    const value = (features as { sampleSize?: unknown })?.sampleSize;
    if (typeof value === 'number') sizes.push(value);
  }
  return sizes.length === 0 ? null : Math.min(...sizes);
}

/** How many bookmakers quoted the price this selection was measured against. */
function readQuoteCount(breakdown: unknown): number {
  const market = (breakdown as { market?: { quoteCount?: unknown } } | null)?.market;
  const value = market?.quoteCount;
  return typeof value === 'number' && value > 0 ? value : 1;
}
