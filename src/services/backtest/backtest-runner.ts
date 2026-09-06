import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { Decimal, dec, toMoney } from '@/lib/math/decimal';
import {
  brierScore,
  edge as computeEdge,
  expectedValue,
  impliedProbability,
  logLoss,
} from '@/lib/math/probability';
import { getLeagueAverages } from '@/services/features/form';
import {
  computeMatchPrediction,
  readModelConfiguration,
  type ModelConfiguration,
} from '@/services/predictions/prediction-engine';
import { settleSelection } from '@/lib/settlement/evaluators';
import type { MatchResultInput, SettlementOutcome } from '@/lib/settlement/types';
import { settlementMultiplier } from '@/services/settlement/settlement-service';
import { blendWithMarket } from '@/lib/models/calibration';

const log = createLogger('backtest');

/**
 * Walk-forward backtesting (§36, §37, §38).
 *
 * The question it answers is narrow and specific: *if the engine had run before
 * each of these matches, using only what was knowable then, how would it have
 * done?*
 *
 * Two guards make the answer trustworthy:
 *  1. The cutoff is derived from kickoff, and every feature query filters on it.
 *  2. Only prices captured before the cutoff are usable — which, given the
 *     archive stamps opening prices 24h out and closing prices at kickoff,
 *     means the model is graded against the opening line it could have taken,
 *     never the closing line it could not.
 */

export interface BacktestOptions {
  name: string;
  from: Date;
  to: Date;
  /** How long before kickoff the model is assumed to run. */
  leadHours?: number;
  /** Number of chronological folds; never a random split (§37). */
  folds?: number;
  leagueIds?: string[];
  modelVersionId?: string;
  minEdge?: number;
  minProbability?: number;
  stakePerBet?: number;
  /** Cap on matches processed, so an exploratory run stays quick. */
  maxMatches?: number;
  /**
   * Overrides the model version's market-prior weight, so the parameter that
   * decides how hard the model is pulled toward the price can be chosen by
   * measurement instead of taste.
   */
  marketPriorWeight?: number;
}

export interface CalibrationBucket {
  lower: number;
  upper: number;
  predicted: number;
  observed: number;
  count: number;
}

/**
 * One source of probabilities, scored on its own.
 *
 * The ensemble was the only thing ever measured, which makes every question
 * about it unanswerable: whether Poisson's 0.50 is earned, whether Form adds
 * anything Elo does not, whether the blend beats simply following the price.
 * Each source is scored against the same graded outcomes, over the same
 * matches, so the comparison is like-for-like.
 */
export interface ModelMetrics {
  /** "ensemble", "poisson", "elo", "form", "xg", or "market". */
  source: string;
  /** Selections this source had an opinion on and that could be graded. */
  sampleSize: number;
  brierScore: number | null;
  logLoss: number | null;
  /** Share of graded selections that landed, among those it would have backed. */
  accuracy: number | null;
  /** Flat stakes on this source's own picks, under the same edge rule. */
  bets: number;
  roi: number | null;
  calibration: CalibrationBucket[];
}

export interface BacktestSummary {
  backtestId: string;
  totalBets: number;
  winningBets: number;
  losingBets: number;
  voidBets: number;
  hitRate: number | null;
  averageOdds: number | null;
  averageProbability: number | null;
  averageEdge: number | null;
  totalStake: number;
  profit: number;
  roi: number | null;
  maxDrawdown: number;
  brierScore: number | null;
  logLoss: number | null;
  calibration: CalibrationBucket[];
  matchesEvaluated: number;
  matchesSkipped: number;
  /** Per-source scores: the ensemble, each component model, and the market. */
  perModel: ModelMetrics[];
}

const CALIBRATION_BUCKETS = 10;

/** Running totals for one probability source. */
interface ModelAccumulator {
  source: string;
  sample: number;
  brier: number;
  logLoss: number;
  wins: number;
  bets: number;
  stake: number;
  payout: number;
  buckets: CalibrationBucket[];
}

function newAccumulator(source: string): ModelAccumulator {
  return {
    source,
    sample: 0,
    brier: 0,
    logLoss: 0,
    wins: 0,
    bets: 0,
    stake: 0,
    payout: 0,
    buckets: Array.from({ length: CALIBRATION_BUCKETS }, (_, i) => ({
      lower: i / CALIBRATION_BUCKETS,
      upper: (i + 1) / CALIBRATION_BUCKETS,
      predicted: 0,
      observed: 0,
      count: 0,
    })),
  };
}

/**
 * Scores one source's probability against one graded outcome.
 *
 * Scoring happens on *every* selection the source had a view on, not only the
 * ones it would have bet — a proper scoring rule measured on a self-selected
 * subset says nothing. The betting arm is separate and uses the same edge and
 * probability floor the live engine applies.
 */
function accumulate(
  accumulator: ModelAccumulator,
  probability: number,
  won: boolean,
  odds: number,
  multiplier: number,
  gate: { minEdge: number; minProbability: number; stake: number },
): void {
  const p = Math.min(1 - 1e-9, Math.max(1e-9, probability));

  accumulator.sample++;
  accumulator.brier += (p - (won ? 1 : 0)) ** 2;
  accumulator.logLoss += won ? -Math.log(p) : -Math.log(1 - p);

  const index = Math.min(CALIBRATION_BUCKETS - 1, Math.floor(p * CALIBRATION_BUCKETS));
  const bucket = accumulator.buckets[index] as CalibrationBucket;
  bucket.count++;
  bucket.predicted += p;
  if (won) bucket.observed++;

  // Would this source have taken the bet on its own?
  const edge = p - 1 / odds;
  if (p >= gate.minProbability && edge >= gate.minEdge) {
    accumulator.bets++;
    accumulator.stake += gate.stake;
    accumulator.payout += gate.stake * multiplier;
    if (won) accumulator.wins++;
  }
}

function finalise(accumulator: ModelAccumulator): ModelMetrics {
  const { sample, bets, stake, payout } = accumulator;

  return {
    source: accumulator.source,
    sampleSize: sample,
    brierScore: sample === 0 ? null : accumulator.brier / sample,
    logLoss: sample === 0 ? null : accumulator.logLoss / sample,
    accuracy: bets === 0 ? null : accumulator.wins / bets,
    bets,
    roi: stake === 0 ? null : (payout - stake) / stake,
    calibration: accumulator.buckets
      .filter((bucket) => bucket.count > 0)
      .map((bucket) => ({
        ...bucket,
        predicted: bucket.predicted / bucket.count,
        observed: bucket.observed / bucket.count,
      })),
  };
}

/** Chronological folds — the only split shape a time series permits (§37). */
export function buildWalkForwardPlan(
  from: Date,
  to: Date,
  folds: number,
): Array<{ fold: number; testFrom: string; testTo: string; trainTo: string }> {
  const span = to.getTime() - from.getTime();
  const size = span / Math.max(1, folds);

  return Array.from({ length: folds }, (_, i) => {
    const testFrom = new Date(from.getTime() + size * i);
    const testTo = new Date(from.getTime() + size * (i + 1));
    return {
      fold: i,
      // Training is everything strictly before the fold; there is no fitted
      // parameter set, but recording the boundary keeps the claim auditable.
      trainTo: testFrom.toISOString(),
      testFrom: testFrom.toISOString(),
      testTo: testTo.toISOString(),
    };
  });
}

export async function runBacktest(options: BacktestOptions): Promise<BacktestSummary> {
  const leadHours = options.leadHours ?? 2;
  const folds = options.folds ?? 3;
  const stakePerBet = options.stakePerBet ?? 1;
  const minEdge = options.minEdge ?? 0.03;
  const minProbability = options.minProbability ?? 0.05;

  const modelVersion = options.modelVersionId
    ? await prisma.modelVersion.findUnique({ where: { id: options.modelVersionId } })
    : await prisma.modelVersion.findFirst({ where: { active: true } });
  if (!modelVersion) throw new Error('No active model version');

  const stored: ModelConfiguration = readModelConfiguration(modelVersion.configuration);
  const config: ModelConfiguration =
    options.marketPriorWeight === undefined
      ? stored
      : { ...stored, marketPriorWeight: options.marketPriorWeight };
  const plan = buildWalkForwardPlan(options.from, options.to, folds);

  const backtest = await prisma.backtest.create({
    data: {
      name: options.name,
      modelVersionId: modelVersion.id,
      startDate: options.from,
      endDate: options.to,
      walkForwardPlan: plan as unknown as Prisma.InputJsonValue,
      configuration: {
        leadHours,
        folds,
        stakePerBet,
        minEdge,
        minProbability,
        leagueIds: options.leagueIds ?? null,
      } as Prisma.InputJsonValue,
      status: 'RUNNING',
      startedAt: new Date(),
    },
    select: { id: true },
  });

  const matches = await prisma.match.findMany({
    where: {
      status: { in: ['FINISHED', 'AWARDED'] },
      homeScore: { not: null },
      awayScore: { not: null },
      scheduledKickoffUtc: { gte: options.from, lt: options.to },
      ...(options.leagueIds ? { leagueId: { in: options.leagueIds } } : {}),
      // Only matches that actually had prices can be bet on.
      odds: { some: {} },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    ...(options.maxMatches ? { take: options.maxMatches } : {}),
    select: {
      id: true,
      leagueId: true,
      homeTeamId: true,
      awayTeamId: true,
      scheduledKickoffUtc: true,
      status: true,
      homeScore: true,
      awayScore: true,
      halfTimeHomeScore: true,
      halfTimeAwayScore: true,
      league: { select: { dataQuality: true } },
    },
  });

  const leagueAverageCache = new Map<string, { homeGoals: number; awayGoals: number; sampleSize: number }>();
  const rows: Prisma.BacktestPredictionCreateManyInput[] = [];
  /** One accumulator per probability source, created on first sight. */
  const accumulators = new Map<string, ModelAccumulator>();
  const accumulatorFor = (source: string): ModelAccumulator => {
    const existing = accumulators.get(source);
    if (existing) return existing;
    const created = newAccumulator(source);
    accumulators.set(source, created);
    return created;
  };

  let matchesEvaluated = 0;
  let matchesSkipped = 0;

  for (const match of matches) {
    const cutoff = new Date(match.scheduledKickoffUtc.getTime() - leadHours * 3600 * 1000);

    // League baseline must also respect the cutoff, so it is cached per fold
    // boundary rather than per run.
    const cacheKey = `${match.leagueId}:${cutoff.toISOString().slice(0, 7)}`;
    let leagueAverages = leagueAverageCache.get(cacheKey);
    if (!leagueAverages) {
      leagueAverages = await getLeagueAverages(match.leagueId, cutoff);
      leagueAverageCache.set(cacheKey, leagueAverages);
    }

    const prediction = await computeMatchPrediction(
      {
        matchId: match.id,
        leagueId: match.leagueId,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        leagueDataQuality: Number(match.league.dataQuality),
      },
      cutoff,
      config,
      leagueAverages,
    );

    if (!prediction) {
      matchesSkipped++;
      continue;
    }

    // Prices the model could actually have taken: captured before the cutoff.
    const prices = await prisma.odds.findMany({
      where: { matchId: match.id, capturedAt: { lte: cutoff } },
      orderBy: { capturedAt: 'desc' },
      select: {
        price: true,
        selectionId: true,
        market: { select: { code: true } },
        selection: { select: { code: true, parameters: true } },
      },
    });

    if (prices.length === 0) {
      matchesSkipped++;
      continue;
    }
    matchesEvaluated++;

    const bestBySelection = new Map<string, (typeof prices)[number]>();
    for (const price of prices) {
      const current = bestBySelection.get(price.selection.code);
      if (!current || Number(price.price) > Number(current.price)) {
        bestBySelection.set(price.selection.code, price);
      }
    }

    const result: MatchResultInput = {
      status: match.status,
      homeScore: match.homeScore,
      awayScore: match.awayScore,
      halfTimeHomeScore: match.halfTimeHomeScore,
      halfTimeAwayScore: match.halfTimeAwayScore,
      // Corner and card markets need statistics we do not load here; those
      // selections settle PENDING and are excluded rather than guessed.
      totalCorners: null,
      totalCards: null,
    };

    // The backtest must calibrate exactly as the live engine does, or it is
    // measuring a different model than the one that ships.
    const quotes = new Map(
      [...bestBySelection].map(([code, price]) => [code, dec(price.price)] as const),
    );
    const calibrated = blendWithMarket(
      prediction.probabilities,
      quotes,
      config.marketPriorWeight,
    );

    const foldIndex = plan.findIndex(
      (f) =>
        match.scheduledKickoffUtc >= new Date(f.testFrom) &&
        match.scheduledKickoffUtc < new Date(f.testTo),
    );

    for (const [selectionCode, price] of bestBySelection) {
      const odds = dec(price.price);
      if (odds.lessThanOrEqualTo(1)) continue;

      const outcome = settleSelection(
        {
          marketCode: price.market.code,
          selectionCode,
          parameters: price.selection.parameters as Record<string, unknown> | null,
          handicap: 0,
        },
        result,
      );

      // A market we cannot grade is not counted at all — it would otherwise
      // silently inflate or deflate the hit rate.
      if (outcome === 'PENDING') continue;

      const stake = dec(stakePerBet);
      const multiplier = settlementMultiplier(outcome, odds);
      const payout = toMoney(stake.times(multiplier));

      /**
       * Score every source on this graded outcome.
       *
       * Deliberately above the edge and probability gates: a Brier score is
       * only meaningful over everything the source had a view on. The gates
       * still decide what each source would have *bet*, which is what the ROI
       * arm of the accumulator measures.
       */
      const won = outcome === 'WON' || outcome === 'HALF_WON';
      const gate = { minEdge, minProbability, stake: stakePerBet };
      const scoreSource = (source: string, value: Decimal | undefined) => {
        if (!value) return;
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1) return;
        accumulate(
          accumulatorFor(source),
          numeric,
          won,
          Number(odds),
          Number(multiplier),
          gate,
        );
      };

      scoreSource('ensemble', calibrated.probabilities.get(selectionCode));
      // The vig-free price is the benchmark every model has to beat; without it
      // a "good" Brier score has nothing to be good relative to.
      scoreSource('market', calibrated.marketProbabilities.get(selectionCode));
      for (const model of prediction.models) {
        if (!model.available) continue;
        scoreSource(model.name, model.probabilities.get(selectionCode));
      }

      const probability = calibrated.probabilities.get(selectionCode);
      if (!probability || Number(probability) < minProbability) continue;

      const edgeValue = computeEdge(probability, odds);
      if (Number(edgeValue) < minEdge) continue;

      rows.push({
        backtestId: backtest.id,
        matchId: match.id,
        marketCode: price.market.code,
        selectionCode,
        knowledgeCutoff: cutoff,
        probability: new Prisma.Decimal(probability.toFixed(8)),
        odds: new Prisma.Decimal(odds.toFixed(3)),
        impliedProbability: new Prisma.Decimal(impliedProbability(odds).toFixed(8)),
        edge: new Prisma.Decimal(edgeValue.toFixed(6)),
        expectedValue: new Prisma.Decimal(expectedValue(probability, odds).toFixed(6)),
        stake: new Prisma.Decimal(stake.toFixed(2)),
        status: outcome,
        payout: new Prisma.Decimal(payout.toFixed(2)),
        profit: new Prisma.Decimal(payout.minus(stake).toFixed(2)),
        fold: foldIndex >= 0 ? foldIndex : 0,
      });
    }
  }

  for (let i = 0; i < rows.length; i += 2000) {
    await prisma.backtestPrediction.createMany({ data: rows.slice(i, i + 2000) });
  }

  /**
   * Ordered so the comparison reads as an argument: the blend, the price it
   * has to beat, then each component that feeds it.
   */
  const ORDER = ['ensemble', 'market', 'poisson', 'elo', 'form', 'xg'];
  const perModel = [...accumulators.values()]
    .map(finalise)
    .sort((a, b) => ORDER.indexOf(a.source) - ORDER.indexOf(b.source));

  const summary = summarise(rows, matchesEvaluated, matchesSkipped, backtest.id, perModel);

  await prisma.backtest.update({
    where: { id: backtest.id },
    data: {
      status: 'SUCCESS',
      finishedAt: new Date(),
      totalBets: summary.totalBets,
      winningBets: summary.winningBets,
      losingBets: summary.losingBets,
      voidBets: summary.voidBets,
      hitRate: summary.hitRate === null ? null : new Prisma.Decimal(summary.hitRate.toFixed(5)),
      averageOdds:
        summary.averageOdds === null ? null : new Prisma.Decimal(summary.averageOdds.toFixed(4)),
      averageProbability:
        summary.averageProbability === null
          ? null
          : new Prisma.Decimal(summary.averageProbability.toFixed(8)),
      averageEdge:
        summary.averageEdge === null ? null : new Prisma.Decimal(summary.averageEdge.toFixed(6)),
      totalStake: new Prisma.Decimal(summary.totalStake.toFixed(2)),
      profit: new Prisma.Decimal(summary.profit.toFixed(2)),
      roi: summary.roi === null ? null : new Prisma.Decimal(summary.roi.toFixed(6)),
      maxDrawdown: new Prisma.Decimal(summary.maxDrawdown.toFixed(2)),
      brierScore:
        summary.brierScore === null ? null : new Prisma.Decimal(summary.brierScore.toFixed(8)),
      logLoss: summary.logLoss === null ? null : new Prisma.Decimal(summary.logLoss.toFixed(8)),
      calibration: summary.calibration as unknown as Prisma.InputJsonValue,
      perModelMetrics: summary.perModel as unknown as Prisma.InputJsonValue,
    },
  });

  log.info('backtest complete', {
    name: options.name,
    bets: summary.totalBets,
    roi: summary.roi,
    hitRate: summary.hitRate,
  });

  return summary;
}

function summarise(
  rows: Prisma.BacktestPredictionCreateManyInput[],
  matchesEvaluated: number,
  matchesSkipped: number,
  backtestId: string,
  perModel: ModelMetrics[],
): BacktestSummary {
  const empty: BacktestSummary = {
    backtestId,
    totalBets: 0,
    winningBets: 0,
    losingBets: 0,
    voidBets: 0,
    hitRate: null,
    averageOdds: null,
    averageProbability: null,
    averageEdge: null,
    totalStake: 0,
    profit: 0,
    roi: null,
    maxDrawdown: 0,
    brierScore: null,
    logLoss: null,
    calibration: [],
    perModel,
    matchesEvaluated,
    matchesSkipped,
  };

  if (rows.length === 0) return empty;

  let stake = dec(0);
  let profit = dec(0);
  let oddsSum = 0;
  let probabilitySum = 0;
  let edgeSum = 0;
  let brierSum = dec(0);
  let logLossSum = dec(0);

  let wins = 0;
  let losses = 0;
  let voids = 0;

  // Drawdown is measured on the running bankroll, in chronological order.
  let running = dec(0);
  let peak = dec(0);
  let maxDrawdown = dec(0);

  const buckets: CalibrationBucket[] = Array.from({ length: CALIBRATION_BUCKETS }, (_, i) => ({
    lower: i / CALIBRATION_BUCKETS,
    upper: (i + 1) / CALIBRATION_BUCKETS,
    predicted: 0,
    observed: 0,
    count: 0,
  }));

  for (const row of rows) {
    const probability = Number(row.probability);
    const status = row.status as SettlementOutcome;
    const rowStake = dec(row.stake as Prisma.Decimal);
    const rowProfit = dec(row.profit as Prisma.Decimal);

    stake = stake.plus(rowStake);
    profit = profit.plus(rowProfit);
    oddsSum += Number(row.odds);
    probabilitySum += probability;
    edgeSum += Number(row.edge);

    if (status === 'WON' || status === 'HALF_WON') wins++;
    else if (status === 'LOST' || status === 'HALF_LOST') losses++;
    else voids++;

    const won = status === 'WON' || status === 'HALF_WON';
    brierSum = brierSum.plus(brierScore(probability, won));
    logLossSum = logLossSum.plus(logLoss(probability, won));

    const bucketIndex = Math.min(
      CALIBRATION_BUCKETS - 1,
      Math.floor(probability * CALIBRATION_BUCKETS),
    );
    const bucket = buckets[bucketIndex] as CalibrationBucket;
    bucket.count++;
    bucket.predicted += probability;
    if (won) bucket.observed++;

    running = running.plus(rowProfit);
    if (running.greaterThan(peak)) peak = running;
    const drawdown = peak.minus(running);
    if (drawdown.greaterThan(maxDrawdown)) maxDrawdown = drawdown;
  }

  const decided = wins + losses;

  return {
    backtestId,
    totalBets: rows.length,
    winningBets: wins,
    losingBets: losses,
    voidBets: voids,
    hitRate: decided === 0 ? null : wins / decided,
    averageOdds: oddsSum / rows.length,
    averageProbability: probabilitySum / rows.length,
    averageEdge: edgeSum / rows.length,
    totalStake: Number(toMoney(stake)),
    profit: Number(toMoney(profit)),
    roi: stake.isZero() ? null : Number(profit.dividedBy(stake)),
    maxDrawdown: Number(toMoney(maxDrawdown)),
    brierScore: Number(brierSum.dividedBy(rows.length)),
    logLoss: Number(logLossSum.dividedBy(rows.length)),
    perModel,
    calibration: buckets
      .filter((bucket) => bucket.count > 0)
      .map((bucket) => ({
        ...bucket,
        predicted: bucket.predicted / bucket.count,
        observed: bucket.observed / bucket.count,
      })),
    matchesEvaluated,
    matchesSkipped,
  };
}

export type { Decimal };
