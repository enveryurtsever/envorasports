import { Prisma, type PredictionCoverageReason } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { Decimal, clampProbability, dec } from '@/lib/math/decimal';
import { edge as computeEdge, expectedValue, impliedProbability } from '@/lib/math/probability';
import { DEFAULT_MODEL_WEIGHTS, type ModelWeights } from '@/lib/config/coupon-settings';
import { getAppSetting } from '@/lib/config/settings-service';
import { getEloForTeams, DEFAULT_ELO_CONFIG } from '@/services/features/elo';
import { getLeagueAverages, getTeamForm, persistFormSnapshot, type TeamFormBundle } from '@/services/features/form';
import { runEloModel } from '@/lib/models/elo-model';
import { runPoissonModel } from '@/lib/models/poisson-model';
import { runFormModel } from '@/lib/models/form-model';
import { runXgModel } from '@/lib/models/xg-model';
import { runEnsemble } from '@/lib/models/ensemble';
import { blendWithMarket } from '@/lib/models/calibration';
import type { ModelOutput } from '@/lib/models/types';

const log = createLogger('predictions');

/**
 * The prediction engine (§25, §26, §44).
 *
 * For each match it assembles features as of a cutoff, runs the models, blends
 * them, and prices every selection the bulletin actually offers. Nothing is
 * predicted for a market with no price — a recommendation you cannot act on is
 * not a recommendation (§41).
 */

export interface PredictionRunOptions {
  /** Matches kicking off inside this window. */
  from: Date;
  to: Date;
  /** Knowledge cutoff. Defaults to now; a backtest passes a past instant. */
  asOf?: Date;
  modelVersionId?: string;
  leagueIds?: string[];
}

export interface PredictionRunResult {
  matchesConsidered: number;
  matchesPriced: number;
  predictionsWritten: number;
  candidatesRecommended: number;
  skippedNoOdds: number;
  skippedNoFeatures: number;
  skippedStaleOdds: number;
  predictionsSuperseded: number;
  /** Fixture counts by coverage reason, so "32 of 48" explains itself. */
  coverage: Record<string, number>;
}

/**
 * How old a price may be and still be worth acting on.
 *
 * A prediction against a stale price is not wrong so much as unactionable: the
 * number it claims an edge over is no longer the number on offer. Predictions
 * are still computed and stored with their age recorded — throwing the
 * information away would hide the problem rather than fix it — but a stale
 * price can never make a selection `recommended`.
 */
export const DEFAULT_ODDS_MAX_AGE_MINUTES = 360;

interface BestPrice {
  price: Decimal;
  bookmakerId: string;
  oddsId: string;
  marketId: string;
  selectionId: string;
  marketCode: string;
  selectionCode: string;
  capturedAt: Date;
  /** How many bookmakers quoted this selection — market agreement. */
  quoteCount: number;
  /** Spread between best and worst quote; wide spreads mean an unsure market. */
  dispersion: number;
}

/**
 * Best available price per selection, as of a cutoff.
 *
 * "Best" is the highest price, because that is the one a user could actually
 * take. Dispersion across books is kept as a signal: a market where books
 * disagree wildly is a market to be careful in.
 */
export async function getBestPrices(matchId: string, asOf: Date): Promise<Map<string, BestPrice>> {
  const rows = await prisma.odds.findMany({
    where: { matchId, capturedAt: { lte: asOf }, available: true },
    orderBy: { capturedAt: 'desc' },
    select: {
      id: true,
      price: true,
      bookmakerId: true,
      capturedAt: true,
      marketId: true,
      selectionId: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
    },
  });

  // Latest quote per (selection, bookmaker); rows arrive newest first.
  const latest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    const key = `${row.selectionId}:${row.bookmakerId}`;
    if (!latest.has(key)) latest.set(key, row);
  }

  const bySelection = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of latest.values()) {
    bySelection.set(row.selectionId, [...(bySelection.get(row.selectionId) ?? []), row]);
  }

  const result = new Map<string, BestPrice>();
  for (const [, quotes] of bySelection) {
    const prices = quotes.map((q) => Number(q.price));
    const best = quotes.reduce((max, q) => (Number(q.price) > Number(max.price) ? q : max));
    const min = Math.min(...prices);
    const max = Math.max(...prices);

    result.set(best.selection.code, {
      price: dec(best.price),
      bookmakerId: best.bookmakerId,
      oddsId: best.id,
      marketId: best.marketId,
      selectionId: best.selectionId,
      marketCode: best.market.code,
      selectionCode: best.selection.code,
      capturedAt: best.capturedAt,
      quoteCount: quotes.length,
      dispersion: max > 0 ? (max - min) / max : 0,
    });
  }

  return result;
}

/**
 * Data quality (§44): how much of what the model wanted actually existed.
 * A prediction built on thin data gets a lower score, and the coupon engine
 * filters on it — rather than pretending the gaps were not there.
 */
export function dataQualityScore(input: {
  homeSample: number;
  awaySample: number;
  hasXg: boolean;
  quoteCount: number;
  leagueQuality: number;
  eloKnown: boolean;
}): number {
  const sample = Math.min(1, Math.min(input.homeSample, input.awaySample) / 10);
  const market = Math.min(1, input.quoteCount / 4);

  const score =
    sample * 0.35 +
    market * 0.2 +
    input.leagueQuality * 0.2 +
    (input.eloKnown ? 0.15 : 0) +
    (input.hasXg ? 0.1 : 0);

  return Math.max(0, Math.min(1, score));
}

/**
 * Attack and defence strengths as ratios against the league baseline.
 *
 * The home side is measured at home and the away side away, each from its own
 * form bundle. Both sides must come from their own team: reading them off one
 * bundle leaves the opponent out of the Poisson model entirely.
 */
function buildAttackDefence(
  homeForm: TeamFormBundle,
  awayForm: TeamFormBundle,
  league: { homeGoals: number; awayGoals: number },
) {
  // Fall back to overall form when a side has barely played at this venue.
  const home = homeForm.home.sampleSize >= 3 ? homeForm.home : homeForm.windows.LAST_10;
  const away = awayForm.away.sampleSize >= 3 ? awayForm.away : awayForm.windows.LAST_10;

  return {
    homeAttack: league.homeGoals > 0 ? home.averageGoalsFor / league.homeGoals : 1,
    homeDefence: league.awayGoals > 0 ? home.averageGoalsAgainst / league.awayGoals : 1,
    awayAttack: league.awayGoals > 0 ? away.averageGoalsFor / league.awayGoals : 1,
    awayDefence: league.homeGoals > 0 ? away.averageGoalsAgainst / league.homeGoals : 1,
  };
}

export interface MatchPredictionInput {
  matchId: string;
  leagueId: string;
  homeTeamId: string;
  awayTeamId: string;
  leagueDataQuality: number;
}

export interface MatchPrediction {
  probabilities: Map<string, Decimal>;
  models: ModelOutput[];
  modelAgreement: number;
  effectiveWeights: Record<string, number>;
  configuredWeights: Record<string, number>;
  contributingModels: string[];
  disabledModels: string[];
  unavailableModels: Array<{ name: string; reason: string; configuredWeight: number }>;
  redistributedWeight: number;
  perModel: Record<string, Record<string, number>>;
  homeForm: TeamFormBundle;
  awayForm: TeamFormBundle;
  eloKnown: boolean;
  hasXg: boolean;
}

export interface ModelConfiguration {
  /**
   * Revision of the configuration *inside* a model version.
   *
   * The model version says which code ran; this says which numbers it ran
   * with. Two publications of "ensemble v2" with different weights are
   * otherwise indistinguishable in the record, which makes an audit of a past
   * prediction impossible.
   */
  configVersion: string;
  weights: ModelWeights;
  elo: typeof DEFAULT_ELO_CONFIG;
  poisson: { maxGoals: number; shrinkage: number; homeAdvantage: number };
  /**
   * How far to pull model probabilities toward the vig-free market price.
   * 0 = ignore the market entirely (measurably overconfident), 1 = follow it
   * exactly (no edge by construction).
   */
  marketPriorWeight: number;
}

/**
 * Values used only when the stored model version omits them.
 *
 * These are a compatibility floor for rows written before a field existed, not
 * the place to tune the model: a live change belongs in the ModelVersion
 * configuration, where it is versioned and shows up in the audit trail.
 */
export const MODEL_CONFIGURATION_FALLBACKS = {
  configVersion: 'unversioned',
  marketPriorWeight: 0.35,
  poisson: { maxGoals: 10, shrinkage: 0.25, homeAdvantage: 1.12 },
} as const;

export function readModelConfiguration(configuration: unknown): ModelConfiguration {
  const config = (configuration ?? {}) as Record<string, unknown>;
  const poisson = (config.poisson ?? {}) as Record<string, number>;

  return {
    configVersion:
      typeof config.configVersion === 'string'
        ? config.configVersion
        : MODEL_CONFIGURATION_FALLBACKS.configVersion,
    weights: (config.weights as ModelWeights) ?? DEFAULT_MODEL_WEIGHTS,
    elo: { ...DEFAULT_ELO_CONFIG, ...((config.elo ?? {}) as object) },
    poisson: {
      maxGoals: poisson.maxGoals ?? MODEL_CONFIGURATION_FALLBACKS.poisson.maxGoals,
      shrinkage: poisson.shrinkage ?? MODEL_CONFIGURATION_FALLBACKS.poisson.shrinkage,
      homeAdvantage:
        poisson.homeAdvantage ?? MODEL_CONFIGURATION_FALLBACKS.poisson.homeAdvantage,
    },
    marketPriorWeight:
      typeof config.marketPriorWeight === 'number'
        ? config.marketPriorWeight
        : MODEL_CONFIGURATION_FALLBACKS.marketPriorWeight,
  };
}

/**
 * Runs every model for one match at one cutoff and blends them.
 *
 * Deliberately does no database writes: the live engine persists the result,
 * the backtest does not. Sharing this function is what guarantees a backtest
 * measures the same model the product actually ships (§37).
 */
export async function computeMatchPrediction(
  match: MatchPredictionInput,
  asOf: Date,
  config: ModelConfiguration,
  leagueAverages: { homeGoals: number; awayGoals: number; sampleSize: number },
): Promise<MatchPrediction | null> {
  const [homeForm, awayForm, elo] = await Promise.all([
    getTeamForm(match.homeTeamId, asOf),
    getTeamForm(match.awayTeamId, asOf),
    getEloForTeams([match.homeTeamId, match.awayTeamId], asOf, config.elo),
  ]);

  if (!homeForm.hasUsableSample && !awayForm.hasUsableSample) return null;

  const homeElo = elo.get(match.homeTeamId)!;
  const awayElo = elo.get(match.awayTeamId)!;
  const strengths = buildAttackDefence(homeForm, awayForm, leagueAverages);

  const models: ModelOutput[] = [
    runEloModel({
      homeRating: homeElo.rating,
      awayRating: awayElo.rating,
      homeMatchesPlayed: homeElo.matchesPlayed,
      awayMatchesPlayed: awayElo.matchesPlayed,
      homeAdvantage: config.elo.homeAdvantage,
      expectedTotalGoals: leagueAverages.homeGoals + leagueAverages.awayGoals,
    }),
    runPoissonModel({
      ...strengths,
      leagueHomeGoals: leagueAverages.homeGoals,
      leagueAwayGoals: leagueAverages.awayGoals,
      homeSampleSize: homeForm.windows.LAST_10.sampleSize,
      awaySampleSize: awayForm.windows.LAST_10.sampleSize,
      shrinkage: config.poisson.shrinkage,
      maxGoals: config.poisson.maxGoals,
    }),
    runFormModel({ home: homeForm, away: awayForm, venueWeight: 0.6 }),
    runXgModel({
      home: homeForm,
      away: awayForm,
      homeAdvantageMultiplier: config.poisson.homeAdvantage,
    }),
  ];

  const ensemble = runEnsemble(models, config.weights);
  if (ensemble.probabilities.size === 0) return null;

  return {
    probabilities: ensemble.probabilities,
    models,
    modelAgreement: ensemble.modelAgreement,
    effectiveWeights: ensemble.effectiveWeights,
    configuredWeights: ensemble.configuredWeights,
    contributingModels: ensemble.contributingModels,
    disabledModels: ensemble.disabledModels,
    unavailableModels: ensemble.unavailableModels,
    redistributedWeight: ensemble.redistributedWeight,
    perModel: ensemble.perModel,
    homeForm,
    awayForm,
    eloKnown: homeElo.known && awayElo.known,
    hasXg: models.some((m) => m.name === 'xg' && m.available),
  };
}

export async function runPredictions(
  options: PredictionRunOptions,
): Promise<PredictionRunResult> {
  const asOf = options.asOf ?? new Date();

  const modelVersion = options.modelVersionId
    ? await prisma.modelVersion.findUnique({ where: { id: options.modelVersionId } })
    : await prisma.modelVersion.findFirst({ where: { active: true } });

  if (!modelVersion) throw new Error('No active model version');

  const config = readModelConfiguration(modelVersion.configuration);

  const [minEdge, minEv, minProbability, oddsMaxAgeMinutes] = await Promise.all([
    getAppSetting<number>('prediction.minEdge', 0.02),
    getAppSetting<number>('prediction.minExpectedValue', 0.02),
    /**
     * Below roughly this probability the engine has no measured skill: the
     * first walk-forward backtest put predicted 17% at an observed 7.6%, and
     * ROI was negative for every threshold under 0.25 and positive above it.
     * The gate sits at the point the calibration error stops dominating, not
     * at the best-looking ROI bucket — that would be fitting to one sample.
     */
    getAppSetting<number>('prediction.minProbability', 0.25),
    getAppSetting<number>('prediction.oddsMaxAgeMinutes', DEFAULT_ODDS_MAX_AGE_MINUTES),
  ]);

  const matches = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: { gte: options.from, lt: options.to },
      status: 'SCHEDULED',
      // An operator-excluded match is left out entirely rather than predicted
      // and then filtered later — nothing downstream can accidentally use it.
      excludedFromGeneration: false,
      ...(options.leagueIds ? { leagueId: { in: options.leagueIds } } : {}),
    },
    select: {
      id: true,
      leagueId: true,
      seasonId: true,
      homeTeamId: true,
      awayTeamId: true,
      scheduledKickoffUtc: true,
      league: { select: { dataQuality: true } },
    },
  });

  const result: PredictionRunResult = {
    matchesConsidered: matches.length,
    matchesPriced: 0,
    predictionsWritten: 0,
    candidatesRecommended: 0,
    skippedNoOdds: 0,
    skippedNoFeatures: 0,
    skippedStaleOdds: 0,
    predictionsSuperseded: 0,
    coverage: {},
  };

  const coverageRows: Prisma.PredictionCoverageCreateManyInput[] = [];
  /** Records why a fixture ended up where it did, exactly once per run. */
  const noteCoverage = (
    matchId: string,
    reason: PredictionCoverageReason,
    extra: Partial<Prisma.PredictionCoverageCreateManyInput> = {},
  ) => {
    result.coverage[reason] = (result.coverage[reason] ?? 0) + 1;
    coverageRows.push({
      matchId,
      modelVersionId: modelVersion.id,
      reason,
      runAt: asOf,
      ...extra,
    });
  };

  const leagueAverageCache = new Map<string, { homeGoals: number; awayGoals: number; sampleSize: number }>();

  for (const match of matches) {
    const prices = await getBestPrices(match.id, asOf);
    if (prices.size === 0) {
      result.skippedNoOdds++;
      noteCoverage(match.id, 'NO_ODDS');
      continue;
    }

    /**
     * Age of the freshest price this fixture has.
     *
     * Measured once per fixture rather than per selection: a bulletin is
     * captured in one pass, so the whole fixture is fresh or the whole fixture
     * is stale, and reporting it per fixture is what a coverage report needs.
     */
    const newestCapture = [...prices.values()].reduce(
      (newest, quote) => (quote.capturedAt > newest ? quote.capturedAt : newest),
      new Date(0),
    );
    const oddsAgeMinutes = Math.max(
      0,
      Math.round((asOf.getTime() - newestCapture.getTime()) / 60_000),
    );
    const oddsAreStale = oddsAgeMinutes > oddsMaxAgeMinutes;
    if (oddsAreStale) result.skippedStaleOdds++;

    let leagueAverages = leagueAverageCache.get(match.leagueId);
    if (!leagueAverages) {
      leagueAverages = await getLeagueAverages(match.leagueId, asOf);
      leagueAverageCache.set(match.leagueId, leagueAverages);
    }

    const prediction = await computeMatchPrediction(
      {
        matchId: match.id,
        leagueId: match.leagueId,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        leagueDataQuality: Number(match.league.dataQuality),
      },
      asOf,
      config,
      leagueAverages,
    );

    if (!prediction) {
      result.skippedNoFeatures++;
      noteCoverage(match.id, 'NO_FEATURES', {
        selectionsPriced: prices.size,
        oddsCapturedAt: newestCapture,
        oddsAgeMinutes,
      });
      continue;
    }

    // Every model reported itself unavailable: there is no opinion to store.
    if (prediction.contributingModels.length === 0) {
      result.skippedNoFeatures++;
      noteCoverage(match.id, 'MODEL_ERROR', {
        selectionsPriced: prices.size,
        oddsCapturedAt: newestCapture,
        oddsAgeMinutes,
        detail: {
          unavailableModels: prediction.unavailableModels,
          disabledModels: prediction.disabledModels,
        } as Prisma.InputJsonValue,
      });
      continue;
    }
    result.matchesPriced++;

    const { homeForm, awayForm, models } = prediction;
    const ensemble = prediction;

    // Freeze the form that produced this prediction so it can be re-read later.
    await Promise.all([
      persistFormSnapshot(homeForm.windows.LAST_10, match.leagueId),
      persistFormSnapshot(awayForm.windows.LAST_10, match.leagueId),
    ]);

    const hasXg = prediction.hasXg;

    // Calibrate against the market before anything is priced, so edge, EV and
    // every stored figure reflect the calibrated probability.
    const quotes = new Map([...prices].map(([code, quote]) => [code, quote.price]));
    const calibrated = blendWithMarket(
      prediction.probabilities,
      quotes,
      config.marketPriorWeight,
    );

    const rows: Prisma.PredictionCreateManyInput[] = [];

    for (const [selectionCode, price] of prices) {
      const probability = calibrated.probabilities.get(selectionCode);
      // No model view on this market: nothing is invented to fill the gap.
      if (!probability || probability.lessThanOrEqualTo(0)) continue;

      const implied = impliedProbability(price.price);
      const edgeValue = computeEdge(probability, price.price);
      const ev = expectedValue(probability, price.price);

      const quality = dataQualityScore({
        homeSample: homeForm.windows.LAST_10.sampleSize,
        awaySample: awayForm.windows.LAST_10.sampleSize,
        hasXg,
        quoteCount: price.quoteCount,
        leagueQuality: Number(match.league.dataQuality),
        eloKnown: prediction.eloKnown,
      });

      /**
       * Confidence is how much the *inputs* can be trusted, not how likely the
       * outcome is.
       *
       * Probability answers "will this happen"; confidence answers "should this
       * number be believed at all" — model agreement, data completeness, market
       * depth and how old the price is. The two were entangled: a 30%
       * probability term meant a longshot could never be confidently priced
       * even on perfect data, and a favourite looked well-supported on none.
       * Keeping them separate is what lets a coupon filter on one without
       * silently filtering on the other.
       */
      const freshness = Math.max(0, 1 - oddsAgeMinutes / Math.max(1, oddsMaxAgeMinutes));
      const confidence = clampProbability(
        dec(ensemble.modelAgreement * 0.4)
          .plus(dec(quality).times(0.35))
          .plus(dec(freshness).times(0.15))
          .plus(dec(Math.min(1, price.quoteCount / 4)).times(0.1)),
      );

      // Risk rises with longshots, model disagreement, thin data and a market
      // whose books cannot agree on a price.
      const risk = clampProbability(
        dec(1)
          .minus(probability)
          .times(0.45)
          .plus(dec(1 - ensemble.modelAgreement).times(0.25))
          .plus(dec(1 - quality).times(0.2))
          .plus(dec(Math.min(1, price.dispersion * 2)).times(0.1)),
      );

      /**
       * Recommendation is a separate decision from prediction.
       *
       * A prediction is a view; a recommendation is a claim that the view is
       * actionable at the price on offer. A stale price fails that test however
       * good the model's opinion is — the number the edge was measured against
       * is no longer the number being sold.
       */
      const recommended =
        !oddsAreStale &&
        Number(edgeValue) >= minEdge &&
        Number(ev) >= minEv &&
        Number(probability) >= minProbability;
      if (recommended) result.candidatesRecommended++;

      const marketProbability = calibrated.marketProbabilities.get(selectionCode) ?? null;
      // Break-even price for the model's own number. Stored rather than derived
      // on read so an audit sees exactly what was claimed at the time.
      const fairOdds = probability.greaterThan(0) ? dec(1).dividedBy(probability) : null;

      rows.push({
        matchId: match.id,
        marketId: price.marketId,
        selectionId: price.selectionId,
        modelVersionId: modelVersion.id,
        probability: new Prisma.Decimal(probability.toFixed(8)),
        oddsUsed: new Prisma.Decimal(price.price.toFixed(3)),
        oddsId: price.oddsId,
        impliedProbability: new Prisma.Decimal(implied.toFixed(8)),
        marketProbability:
          marketProbability === null ? null : new Prisma.Decimal(marketProbability.toFixed(8)),
        fairOdds: fairOdds === null ? null : new Prisma.Decimal(fairOdds.toFixed(3)),
        oddsCapturedAt: price.capturedAt,
        oddsAgeMinutes,
        modelConfigVersion: config.configVersion,
        edge: new Prisma.Decimal(edgeValue.toFixed(6)),
        expectedValue: new Prisma.Decimal(ev.toFixed(6)),
        confidenceScore: new Prisma.Decimal(confidence.toFixed(4)),
        riskScore: new Prisma.Decimal(risk.toFixed(4)),
        dataQualityScore: new Prisma.Decimal(quality.toFixed(4)),
        recommended,
        predictionTimestamp: asOf,
        // Real feature values only — this is what the explanation is built from.
        breakdown: {
          models: Object.fromEntries(models.map((m) => [m.name, m.features])),
          modelAgreement: Number(ensemble.modelAgreement.toFixed(4)),
          effectiveWeights: ensemble.effectiveWeights,
          configuredWeights: ensemble.configuredWeights,
          contributingModels: ensemble.contributingModels,
          // Off by configuration versus absent for want of data: two different
          // facts, and only one of them is a reason to change anything.
          disabledModels: ensemble.disabledModels,
          unavailableModels: ensemble.unavailableModels,
          redistributedWeight: Number(ensemble.redistributedWeight.toFixed(4)),
          perModelResult: ensemble.perModel,
          modelConfigVersion: config.configVersion,
          calibration: {
            marketPriorWeight: config.marketPriorWeight,
            groupsCalibrated: calibrated.calibratedGroups.length,
          },
          oddsFreshness: {
            capturedAt: price.capturedAt.toISOString(),
            ageMinutes: oddsAgeMinutes,
            maxAgeMinutes: oddsMaxAgeMinutes,
            stale: oddsAreStale,
          },
          market: {
            quoteCount: price.quoteCount,
            dispersion: Number(price.dispersion.toFixed(4)),
            capturedAt: price.capturedAt.toISOString(),
          },
        } as Prisma.InputJsonValue,
      });
    }

    if (rows.length > 0) {
      /**
       * Retire the previous generation before writing the new one.
       *
       * Predictions are append-only, so a re-run leaves several opinions about
       * the same selection and downstream readers had to guess which was
       * current by comparing timestamps. Marking the old rows superseded says
       * so outright, keeps the full history for audit, and means a coupon can
       * never be built on a view the engine has already withdrawn.
       */
      const superseded = await prisma.prediction.updateMany({
        where: {
          matchId: match.id,
          modelVersionId: modelVersion.id,
          predictionTimestamp: { lt: asOf },
          supersededAt: null,
          // A settled prediction is a historical fact, not a live view.
          status: 'PENDING',
        },
        data: { supersededAt: asOf, supersededReason: 'REPLACED_BY_NEWER_RUN' },
      });
      result.predictionsSuperseded += superseded.count;

      const written = await prisma.prediction.createMany({ data: rows, skipDuplicates: true });
      result.predictionsWritten += written.count;

      noteCoverage(match.id, oddsAreStale ? 'STALE_ODDS' : 'PREDICTED', {
        selectionsPriced: prices.size,
        predictionsMade: written.count,
        recommendations: rows.filter((row) => row.recommended).length,
        oddsCapturedAt: newestCapture,
        oddsAgeMinutes,
      });
    } else {
      // Priced, modelled, but no selection the model had a view on.
      noteCoverage(match.id, 'NO_FEATURES', {
        selectionsPriced: prices.size,
        oddsCapturedAt: newestCapture,
        oddsAgeMinutes,
        detail: { note: 'no_modelled_selection_priced' } as Prisma.InputJsonValue,
      });
    }
  }

  if (coverageRows.length > 0) {
    await prisma.predictionCoverage.createMany({ data: coverageRows, skipDuplicates: true });
  }

  log.info('prediction run complete', { ...result, asOf: asOf.toISOString() });
  return result;
}
