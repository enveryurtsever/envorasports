import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { Decimal, dec, toOdds } from '@/lib/math/decimal';
import { combinedProbability } from '@/lib/math/probability';
import {
  DEFAULT_SCORING_WEIGHTS,
  EXCLUDED_SELECTIONS,
  SINGLE_MATCH_SURPRISE,
  type CouponCategory,
  type CouponCategorySettings,
  type CouponFocusGroup,
  type CouponScoringWeights,
  type SystemCouponSettings,
} from '@/lib/config/coupon-settings';
import { buildSingleMatchStacks } from './single-match-surprise';
import { getAppSetting } from '@/lib/config/settings-service';
import { dateKeyToUtcMidnight, localDateKey, type LocalDateKey } from '@/lib/time/zoned';
import { buildSelectionPool } from '@/services/predictions/selection-pool';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';
import {
  couponCorrelation,
  loadCorrelationMatrix,
  maxCorrelationWith,
  type CorrelationMatrix,
  type SelectionRef,
} from './correlation';
import { buildSystemPlan, parseSystemSizes, SystemPlanError } from '@/lib/coupons/system-math';
import { combinationCount } from '@/lib/math/combinatorics';
import { MIN_COUPON_STAKE } from '@/lib/format/currency';
import { MARKET } from '@/lib/markets/registry';

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
  /** The league's archive code (E0, NOR1, ...), for slates scoped to leagues. */
  leagueCode: string | null;
  /**
   * home|away|date — the fixture itself, whichever row it came from.
   *
   * A fixture discovered from the odds provider and the same fixture from
   * the football provider are two match rows until they are reconciled after
   * kick-off, and both carry predictions. Counting exposure by matchId let
   * Elche–Real Madrid sit on nine coupons while each of its two rows looked
   * within the cap of two.
   */
  fixtureKey: string;
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
  /** What the master pool offered, and why anything was left out of it. */
  pool: {
    considered: number;
    eligible: number;
    rejected: number;
    fixtures: number;
    leagues: number;
    reasons: Record<string, number>;
  };
}

/**
 * Ranking functions that make the coupons in a category actually differ (§32).
 *
 * Every one of them scores a candidate on the model's own terms. None compares
 * the model's probability to the price, and that is the point.
 *
 * Ranking by expected value or edge selects, by construction, the candidates
 * where the model sits furthest above the market — which on a model with any
 * error at all is a ranking of its mistakes, not of its insights. Measured over
 * 17,057 settled predictions the model is well calibrated overall (38.3%
 * predicted against 39.1% observed, a better calibration error than the market
 * itself), and yet sorting those same predictions by expected value produces a
 * clean monotonic gradient: the lowest tenth beats its forecast by 14.9 points
 * and the highest tenth falls short of it by 19.8, promising 32.1% and
 * returning 12.3% at -36% ROI. It survives every control — inside MATCH_RESULT
 * alone the top fifth promises 33.7% and returns 8.5%, and inside a 1.5-4.0
 * odds band it promises 48.7% and returns 31.6%. So it is not a long-shot
 * artefact or a mixing artefact; it is the selection itself.
 *
 * `value_density` looked like a different measure and was not: log(odds) /
 * -log(probability) exceeds 1 exactly when probability x odds exceeds 1, so it
 * ranked on the same axis and is gone with the other two.
 *
 * This is also why the one category that never asked for edge — Banko, at
 * minEdge 0 and ranked on probability — is the one that has held up.
 */
const STRATEGIES = [
  { name: 'highest_probability', rank: (c: Candidate) => Number(c.probability) },
  { name: 'highest_confidence', rank: (c: Candidate) => c.confidence },
  // Was expectedValue x (1 - risk); the risk half was never the problem.
  { name: 'balanced_risk', rank: (c: Candidate) => Number(c.probability) * (1 - c.risk) },
  { name: 'best_data_quality', rank: (c: Candidate) => c.dataQuality * Number(c.probability) },
  {
    /**
     * What the model believes, weighted by how well it knows the fixture.
     *
     * Keeps a fifth ordering so a category asking for several coupons still
     * gets several different ones, without reaching for the price to do it.
     */
    name: 'confident_probability',
    rank: (c: Candidate) => Number(c.probability) * c.confidence,
  },
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
      // A withdrawn view must never reach a coupon. The engine marks the old
      // generation superseded when it re-runs; this is where that matters.
      supersededAt: null,
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
      match: {
        select: {
          scheduledKickoffUtc: true,
          homeTeamId: true,
          awayTeamId: true,
          league: { select: { csvDivision: true } },
        },
      },
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
      leagueCode: p.match.league.csvDivision,
      fixtureKey: `${p.match.homeTeamId}|${p.match.awayTeamId}|${p.match.scheduledKickoffUtc.toISOString().slice(0, 10)}`,
      targetDate: localDateKey(p.match.scheduledKickoffUtc, timezone),
    }));
}

/** Candidates that clear a category's quality bar before any coupon is built. */
export function filterForCategory(
  candidates: Candidate[],
  settings: CouponCategorySettings,
): Candidate[] {
  const allowed = new Set(settings.allowedMarkets);
  const leagues = new Set(settings.allowedLeagues ?? []);
  const selections = new Set(settings.allowedSelections ?? []);

  return candidates.filter((candidate) => {
    if (EXCLUDED_SELECTIONS.includes(candidate.selectionCode)) return false;
    if (allowed.size > 0 && !allowed.has(candidate.marketCode)) return false;
    if (leagues.size > 0 && (!candidate.leagueCode || !leagues.has(candidate.leagueCode))) return false;
    if (selections.size > 0 && !selections.has(candidate.selectionCode)) return false;
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
 * Mean probability of a coupon's legs — the figure shown as "tahmin gücü".
 *
 * Not the chance the coupon lands: three legs at 75% average 75% and come in
 * 42% of the time. The two answer different questions and are kept apart
 * everywhere they appear.
 */
function legStrength(coupon: BuiltCoupon): number {
  if (coupon.selections.length === 0) return 0;
  const total = coupon.selections.reduce((sum, s) => sum + Number(s.probability), 0);
  return total / coupon.selections.length;
}

/** Columns a system of these sizes over this many legs will produce. */
function plannedColumns(sizes: number[], legs: number): number {
  return sizes.reduce((total, k) => total + Number(combinationCount(legs, k)), 0);
}

/**
 * Raises the misli until columns x stake clears the minimum slip.
 *
 * Ten columns at one lira is a ten-lira coupon, which no shop would take. The
 * per-column stake is the lever a real slip uses, so it goes up rather than the
 * column count coming down.
 */
function systemStakePerColumn(configured: number, columns: number): number {
  if (columns <= 0) return configured;
  return Math.max(configured, Math.ceil(MIN_COUPON_STAKE / columns));
}

/**
 * Asian handicap is priced and modelled, but never put on a coupon.
 *
 * It is not a market a Turkish bulletin carries in this form. Nesine's
 * "Handikaplı Maç Sonucu" is a different bet — three-way, whole goals, quoted
 * as a virtual score — so borrowing its name would be wrong, and two attempts
 * at plain language ("2+ fark kaybetmez", "Heerenveen +1,5") both came back as
 * unreadable. A selection nobody can read is not a tip, whatever its edge.
 *
 * The prices stay: they are a real second opinion on the same match and the
 * model is better for having them.
 */
function isUnofferableHandicap(candidate: Candidate): boolean {
  return candidate.marketCode === MARKET.ASIAN_HANDICAP;
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
/**
 * How far outside its odds band a coupon may land and still be offered.
 *
 * The band is a target, not a rule of the game: a slate that can make a good
 * coupon at 5.4 against a floor of 6.0 should not be thrown away over the
 * difference. Ten per cent is wide enough to stop the band rejecting near
 * misses and narrow enough that a "6 to 25" coupon is still recognisably one.
 *
 * It is deliberately not applied to the quality gates — probability,
 * confidence, data quality and risk are answers about the selections, and a
 * near miss there is still a miss.
 */
const ODDS_BAND_TOLERANCE = 0.1;

function oddsFloor(settings: CouponCategorySettings): number {
  return Number(settings.minTotalOdds) * (1 - ODDS_BAND_TOLERANCE);
}

function oddsCeiling(settings: CouponCategorySettings): number | null {
  return settings.maxTotalOdds === null
    ? null
    : Number(settings.maxTotalOdds) * (1 + ODDS_BAND_TOLERANCE);
}

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
  /** Drops the per-market cap when a slate cannot otherwise be filled. */
  relaxMarketMix = false,
): BuiltCoupon | null {
  const ranked = [...pool].sort((a, b) => {
    // Push the coupon toward matches and markets the earlier coupons did not
    // use, which is what makes five coupons five different coupons.
    const noveltyA = (usedMatches.has(a.fixtureKey) ? 0 : 0.15) + (usedMarkets.has(a.marketCode) ? 0 : 0.1);
    const noveltyB = (usedMatches.has(b.fixtureKey) ? 0 : 0.15) + (usedMarkets.has(b.marketCode) ? 0 : 0.1);
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
    ? ranked.filter((candidate) => !usedMatches.has(candidate.fixtureKey))
    : ranked;

  const available = offset > 0 ? eligible.slice(offset) : eligible;

  const chosen: Candidate[] = [];
  const chosenMatches = new Set<string>();
  let runningProbability = dec(1);

  /**
   * Legs already taken from each market.
   *
   * Ranking by edge alone put Asian handicap on every leg of every coupon —
   * the market where the model most often disagrees with the price, so it wins
   * the ranking every time. A slate of five identical-looking coupons is worth
   * less than five that read differently, so no market may take more than half
   * a coupon's legs; on a two-leg coupon that means two different markets.
   */
  const marketCounts = new Map<string, number>();
  /**
   * Short coupons must mix markets — two legs of Asian handicap is one idea
   * twice. Long ones need the room: a ten-leg coupon can only be built from the
   * markets that happen to be priced, and refusing it for being handicap-heavy
   * means no coupon at all.
   */
  /**
   * How much of one coupon a single market may fill.
   *
   * Over/under and double chance were briefly exempted from this on a
   * measurement that turned out to be worthless: it counted 5,024 "settled
   * predictions" from a table that keeps every superseded run alongside the
   * current one, so the sample was inflated about ninefold, and it measured
   * predictions rather than the legs actually played. On the 86 settled coupon
   * legs, over/under is the weakest market on the board — 69.8% promised
   * against 50.0% delivered at -24.7% ROI — the opposite of what the exemption
   * assumed. Neither sample is big enough to justify steering toward a market
   * or away from one, so the cap treats them all alike again.
   */
  const perMarketCap =
    settings.maxSelections <= 3 ? 1 : Math.max(2, Math.ceil(settings.maxSelections * 0.6));
  let totalOdds = dec(1);

  for (const candidate of available) {
    if (chosen.length >= settings.maxSelections) break;

    if (settings.oneSelectionPerMatch && chosenMatches.has(candidate.fixtureKey)) continue;
    if (!relaxMarketMix && (marketCounts.get(candidate.marketCode) ?? 0) >= perMarketCap) continue;

    const correlation = maxCorrelationWith(matrix, refOf(candidate), chosen.map(refOf));
    if (correlation > settings.maxCorrelation) continue;

    const nextOdds = totalOdds.times(candidate.odds);
    // Overshooting the ceiling is a rejection, not something to fix later.
    const ceiling = oddsCeiling(settings);
    if (ceiling !== null && nextOdds.greaterThan(ceiling)) {
      // A shorter-priced candidate may still fit, so keep scanning.
      continue;
    }

    /**
     * Check the probability floor before taking the leg, not after.
     *
     * The builder used to add whatever ranked highest and discover at the end
     * that the coupon had fallen through its floor, which threw away the whole
     * attempt. A category asked to hold 70% and clear 2.00 can be built — the
     * legs just have to be chosen with the floor in mind. Below the minimum leg
     * count there is nothing to protect yet, so the guard waits.
     */
    const nextProbability = runningProbability.times(candidate.probability);
    if (
      chosen.length + 1 > settings.minSelections &&
      settings.minCombinedProbability > 0 &&
      nextProbability.lessThan(settings.minCombinedProbability)
    ) {
      continue;
    }

    runningProbability = nextProbability;
    chosen.push(candidate);
    chosenMatches.add(candidate.fixtureKey);
    marketCounts.set(candidate.marketCode, (marketCounts.get(candidate.marketCode) ?? 0) + 1);
    totalOdds = nextOdds;

    if (chosen.length >= settings.minSelections && totalOdds.greaterThanOrEqualTo(oddsFloor(settings))) {
      break;
    }
  }

  if (chosen.length < settings.minSelections) return null;
  if (totalOdds.lessThan(oddsFloor(settings))) return null;
  const finalCeiling = oddsCeiling(settings);
  if (finalCeiling !== null && totalOdds.greaterThan(finalCeiling)) return null;

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

/**
 * Fixtures and markets already spent, shared across an entire generation run.
 *
 * Scoped to a single category, this only ever stopped a fixture appearing twice
 * *within* Banko — it reset before Dengeli and again before each Sürpriz slate,
 * so the same match reappeared in three categories and the reader saw one
 * fixture presented as three separate tips. Passing one pair of sets through
 * the whole run makes "different matches" mean different across the day's
 * coupons, not merely within a category.
 */
export interface GenerationLedger {
  usedMatches: Set<string>;
  usedMarkets: Set<string>;
}

/**
 * Largest share of a candidate coupon's fixtures that any existing coupon
 * already has.
 *
 * Measured against each coupon separately rather than against the union: two
 * coupons that each share half a slate are a different problem from one that
 * duplicates another outright, and it is the outright duplicate a reader
 * notices.
 */
function fixtureOverlap(candidate: BuiltCoupon, existing: BuiltCoupon[]): number {
  if (existing.length === 0) return 0;

  const fixtures = new Set(candidate.selections.map((s) => s.fixtureKey));
  if (fixtures.size === 0) return 0;

  let worst = 0;
  for (const coupon of existing) {
    let shared = 0;
    for (const selection of coupon.selections) {
      if (fixtures.has(selection.fixtureKey)) shared++;
    }
    worst = Math.max(worst, shared / fixtures.size);
  }
  return worst;
}

export function buildCategoryCoupons(
  candidates: Candidate[],
  settings: CouponCategorySettings,
  matrix: CorrelationMatrix,
  weights: CouponScoringWeights,
  groupKeys: LocalDateKey[],
  ledger?: GenerationLedger,
  /**
   * Whether a coupon must stay inside one match day.
   *
   * Under WINDOW grouping `groupKeys` holds a single key — the window's first
   * day — and filtering candidates on it silently discarded every fixture from
   * the other two days. A coupon does not have to be one day's football, and
   * when it is not, the group is the whole window.
   */
  perDay = true,
): { coupons: BuiltCoupon[]; poolSize: number; shortfallReason: string | null } {
  const pool = filterForCategory(candidates, settings);
  if (pool.length === 0) {
    return { coupons: [], poolSize: 0, shortfallReason: 'no_candidate_met_thresholds' };
  }

  const coupons: BuiltCoupon[] = [];
  // Falls back to a run-local ledger so a direct caller (and the tests) keep
  // the previous per-category behaviour.
  const usedMatches = ledger?.usedMatches ?? new Set<string>();
  const usedMarkets = ledger?.usedMarkets ?? new Set<string>();

  /**
   * Spread the requested count across the match days that actually have
   * candidates.
   *
   * Dividing by every day in the window caps a category at ceil(count/days)
   * even when only one day has fixtures — five coupons over a four-day window
   * became two, every time, and the shortfall was reported as a thin candidate
   * pool rather than as the arithmetic it was.
   */
  const inGroup = (candidate: Candidate, key: LocalDateKey) =>
    perDay ? candidate.targetDate === key : true;

  const activeKeys = groupKeys.filter((key) => pool.some((c) => inGroup(c, key)));
  const perGroup = Math.max(1, Math.ceil(settings.couponCount / Math.max(1, activeKeys.length)));

  for (const groupKey of activeKeys) {
    const groupPool = pool.filter((c) => inGroup(c, groupKey));

    // Six strategies over a small pool converge on the same few legs, which is
    // why a category asked for five and produced two. Once they are exhausted
    // the same strategies run again from further down the ranking, which yields
    // a different combination out of the same candidates. Legs may repeat
    // across coupons; a whole coupon may not.
    const maxAttempts = STRATEGIES.length * 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (coupons.length >= settings.couponCount * OVERBUILD) break;
      if (!perDay ? coupons.length >= perGroup : coupons.filter((c) => c.targetDate === groupKey).length >= perGroup) break;

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
        usedMatches.add(s.fixtureKey);
        usedMarkets.add(s.marketCode);
      });
    }
  }

  // Build past the requested count so there is something to choose between,
  // then keep the likeliest. Any day may fill what the per-day share left over.
  const target = settings.couponCount * OVERBUILD;

  /**
   * Reuse fixtures reluctantly, in steps, rather than all at once.
   *
   * The strict pass above refuses a fixture another coupon already used, and
   * exhausts a thin pool quickly — a six-leg slate takes six fixtures out of
   * circulation per coupon. What followed was a single fallback that dropped
   * the rule entirely, so coupons two and three came back as near-copies of
   * coupon one: eight legs, seven of them shared, presented as three tips.
   *
   * `isDistinct` did not catch it because it asks whether the *combination*
   * differs, and swapping one leg of eight satisfies that while looking
   * identical to a reader. Nor did a partial cap: with three eligible fixtures
   * and two-leg coupons, "at most a third shared" still let every Banko share a
   * match with every other Banko.
   *
   * So within a category no coupon reuses another's fixture at all. The second
   * tier lifts that only when the first produced nothing — the case of a pool
   * so thin that the alternative is an empty category, which is the only time
   * repeating a match beats showing fewer coupons.
   */
  const OVERLAP_TIERS = [0, 1];

  for (const maxOverlap of OVERLAP_TIERS) {
    if (coupons.length >= target) break;
    /**
     * Fewer coupons beats the same coupon twice.
     *
     * The final tier accepts any overlap, which is the right answer only when
     * the alternative is an empty slate — a pool of six İY/MS fixtures cannot
     * make three genuinely different six-leg coupons, and forcing it produced
     * three slips with identical legs. So unlimited reuse is reserved for the
     * case the user actually asked about: nothing else could be found at all.
     */
    // "Nothing produced yet" has to mean nothing in the *category*, not
    // nothing from this builder. Sürpriz runs three of them — straight, system
    // and tenfold — and each starting from an empty local list re-opened
    // unlimited reuse of fixtures the previous builder had already spent.
    if (maxOverlap >= 1 && (coupons.length > 0 || (ledger?.usedMatches.size ?? 0) > 0)) break;

    for (const groupKey of activeKeys) {
      if (coupons.length >= target) break;
      const groupPool = pool.filter((c) => inGroup(c, groupKey));

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
          false,
          true,
        );
        if (!coupon || !isDistinct(coupon, coupons)) continue;
        if (fixtureOverlap(coupon, coupons) > maxOverlap) continue;

        coupons.push(coupon);
        coupon.selections.forEach((s) => {
          usedMatches.add(s.fixtureKey);
          usedMarkets.add(s.marketCode);
        });
      }
    }
  }

  /**
   * Rank by the strength of the legs, not by the product of them.
   *
   * The strategies produce coupons in the order they were tried, which is an
   * artefact of the ranking function rather than a judgement, so the slate is
   * built past the requested count and then cut down.
   *
   * Cutting on the coupon's own chance sounds right and is not: that number
   * falls with every leg added, so a two-leg coupon of 65% picks outranks a
   * five-leg coupon of 80% picks purely for being shorter. The category is
   * asked for four to six legs, and ranking that way quietly fought it.
   * Average leg strength is what the card leads with and what the reader is
   * comparing, and it does not move with the count.
   */
  coupons.sort((a, b) => legStrength(b) - legStrength(a));

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
    if (coupon.selections.some((s) => spokenFor.has(s.fixtureKey))) continue;
    chosen.push(coupon);
    coupon.selections.forEach((s) => spokenFor.add(s.fixtureKey));
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

const REFERENCE_PREFIX: Record<CouponCategory, string> = {
  HIGH_CONFIDENCE: 'HC',
  BALANCED_PICKS: 'BP',
  HIGH_VALUE: 'HV',
  COMBINATION_SYSTEM: 'CS',
};

/**
 * The next free reference for a category on a date.
 *
 * Numbering used to restart at 01 on every run, which was safe only while a
 * regeneration wiped every pending coupon for the date first. It no longer
 * does — a coupon whose first match has kicked off is kept — so the next run
 * would hand out HC-2026-09-12-01 while the surviving coupon still held it,
 * and the whole publication failed on the unique constraint at 00:09. The
 * number now continues from whatever the date already carries.
 */
async function referenceFor(category: CouponCategory, targetDate: string): Promise<string> {
  const prefix = `${REFERENCE_PREFIX[category]}-${targetDate}-`;
  const existing = await prisma.coupon.findMany({
    where: { reference: { startsWith: prefix } },
    select: { reference: true },
  });
  const taken = existing
    .map((row) => Number(row.reference.slice(prefix.length)))
    .filter((n) => Number.isInteger(n));
  // Coupons are persisted one after another, so each call sees the last one.
  const floor = taken.length > 0 ? Math.max(...taken) : 0;
  return `${prefix}${String(floor + 1).padStart(2, '0')}`;
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

  const [allCandidates, matrix] = await Promise.all([
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

  /**
   * Regenerating a day replaces that day's coupons rather than duplicating —
   * but never the settled ones. A coupon that has been graded is the record of
   * what was actually predicted, and a re-run for any reason (a settings
   * change, a wider bulletin) was quietly erasing yesterday's results along
   * with the tips that produced them.
   *
   * Scoped to the publication *date*, not to this run. A generation run is
   * keyed on (publicationDate, modelVersionId), so publishing a new model
   * version created a new run whose delete matched nothing: the previous
   * version's pending coupons stayed live on the site, and the new ones then
   * collided with them on `reference`. A pending coupon built by a model that
   * has since been withdrawn is exactly the thing that must not survive a
   * regeneration.
   */
  const runsForDate = await prisma.couponGenerationRun.findMany({
    where: { publicationDate },
    select: { id: true },
  });

  /**
   * Nothing is deleted. A published coupon stands until its result settles it.
   *
   * Regeneration used to wipe the date's pending coupons and rebuild, which
   * on the day a window's matches were played destroyed five coupons with legs
   * still to be played and built nothing in their place. Now a run only fills
   * what the date is short of: each category and each focus slate is asked for
   * its target minus what already stands pending, so re-running on a full
   * slate produces nothing and re-running on a gap produces the gap.
   *
   * The cost is that a settings change no longer replaces the live slate — the
   * coupons already published were published, and they play out as they were.
   */
  const standing = await prisma.coupon.findMany({
    where: {
      generationRunId: { in: runsForDate.map((previous) => previous.id) },
      resultStatus: 'PENDING',
    },
    select: {
      category: true,
      name: true,
      selections: {
        select: {
          match: { select: { homeTeamId: true, awayTeamId: true, scheduledKickoffUtc: true } },
        },
      },
    },
  });
  const fixtureKeyOf = (m: { homeTeamId: string; awayTeamId: string; scheduledKickoffUtc: Date }) =>
    `${m.homeTeamId}|${m.awayTeamId}|${m.scheduledKickoffUtc.toISOString().slice(0, 10)}`;

  /**
   * How many coupons on the slate a single match may sit on.
   *
   * Levante–Barcelona was on ten: Under 4.5 in Banko, Dengeli and the
   * tenfold, Under 3.5 in a surprise system, Under 2.5 in six combination
   * systems. It finished 2-4 and all ten lost. Every category has its own
   * one-selection-per-match rule and its own ledger; nothing looked across
   * them, so one opinion — and a wrong one — became the whole slate's
   * opinion. Two is the ceiling now, counted across every category and
   * every slate, including what already stands pending for the date.
   */
  const MAX_COUPONS_PER_MATCH = 2;
  const exposure = new Map<string, number>();
  for (const coupon of standing) {
    for (const key of new Set(coupon.selections.map((s) => fixtureKeyOf(s.match)))) {
      exposure.set(key, (exposure.get(key) ?? 0) + 1);
    }
  }
  const underCap = (pool: Candidate[]): Candidate[] =>
    pool.filter((c) => (exposure.get(c.fixtureKey) ?? 0) < MAX_COUPONS_PER_MATCH);
  const noteExposure = (coupon: BuiltCoupon): void => {
    for (const key of new Set(coupon.selections.map((s) => s.fixtureKey))) {
      exposure.set(key, (exposure.get(key) ?? 0) + 1);
    }
  };
  const standingCount = (category: CouponCategory, focusKey?: string): number =>
    standing.filter((c) =>
      focusKey
        ? c.name === `focus_${focusKey}`
        : c.category === category && !(c.name ?? '').startsWith('focus_'),
    ).length;

  const perDay = options.grouping === 'PER_DAY';
  const groupKeys = perDay ? options.window.days : [options.window.startDate];

  /**
   * Build the master selection pool before anything is combined.
   *
   * The builders below take what this leaves them. Eligibility is decided once,
   * here, and recorded with reasons — so a thin slate is explained by the pool
   * rather than discovered as an empty category at the end.
   */
  const pool = await buildSelectionPool({
    window: options.window,
    modelVersionId: options.modelVersionId,
    generationRunId: run.id,
    asOf,
  });

  /**
   * The pool's verdict is the one that counts.
   *
   * Building it and then ignoring it was the worst of both: the reasons were
   * recorded and nothing acted on them, so a side with three matches of history
   * — flagged INSUFFICIENT_HISTORY right there in the pool — still walked onto
   * a Sürpriz coupon. The builders now see only what the pool passed.
   */
  const eligibleIds = new Set(
    (
      await prisma.selectionPool.findMany({
        where: { generationRunId: run.id, eligible: true },
        select: { predictionId: true },
      })
    ).map((row) => row.predictionId),
  );

  const candidates = allCandidates.filter((candidate) => eligibleIds.has(candidate.predictionId));
  log.info('pool applied to candidate set', {
    before: allCandidates.length,
    after: candidates.length,
    rejected: allCandidates.length - candidates.length,
  });

  const outcomes: CategoryOutcome[] = [];
  let couponsGenerated = 0;

  /**
   * A ledger per category, not one for the publication.
   *
   * Inside a category, two coupons on the same fixture are one tip shown twice.
   * Across categories they are not: Banko backing a side to avoid defeat and
   * Sürpriz backing the same match to go over 3.5 are different bets on
   * different questions, and a shared ledger was starving the later categories
   * of the day's best fixtures to enforce a rule nobody wanted.
   */
  /**
   * One ledger per slate, not per category.
   *
   * A slate is the unit a reader compares within: three İY/MS coupons on the
   * same fixture are one tip shown three times, and that is what the rule is
   * for. But Sürpriz's İY/MS slate and its 6+ goals slate are asking different
   * questions of the bulletin, and forcing them onto disjoint fixtures starved
   * whichever ran second — the tenfold slate could reach only one coupon out of
   * a pool that supports two, because the straight Sürpriz coupons had spent
   * the fixtures first.
   *
   * Categories with a single builder are unaffected: for Banko and Dengeli the
   * slate and the category are the same thing.
   */
  const ledgers = new Map<string, GenerationLedger>();
  const ledgerFor = (slate: string): GenerationLedger => {
    const existing = ledgers.get(slate);
    if (existing) return existing;
    const created: GenerationLedger = { usedMatches: new Set(), usedMarkets: new Set() };
    ledgers.set(slate, created);
    return created;
  };

  for (const [category, configured] of Object.entries(options.categorySettings) as Array<
    [CouponCategory, CouponCategorySettings]
  >) {
    const settings: CouponCategorySettings = {
      ...configured,
      couponCount: Math.max(0, configured.couponCount - standingCount(category)),
    };
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
      underCap(candidates),
      settings,
      matrix,
      weights,
      groupKeys,
      ledgerFor(category),
      perDay,
    );

    for (const coupon of coupons) {
      await persistCoupon(coupon, run.id, options);
      noteExposure(coupon);
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

  for (const group of options.focusGroups ?? []) {
    const parent = options.categorySettings[group.category];
    const wanted = Math.max(0, group.couponCount - standingCount(group.category, group.key));
    if (!parent || !parent.enabled || wanted === 0) continue;

    const settings: CouponCategorySettings = {
      ...parent,
      couponCount: wanted,
      allowedMarkets: group.allowedMarkets,
      allowedLeagues: group.allowedLeagues,
      allowedSelections: group.allowedSelections,
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
      const { outcome, persisted } = await generateSystemCoupons(
        underCap(candidates),
        matrix,
        options,
        run.id,
        weights,
        groupKeys,
        group.category,
        {
          ledger: ledgerFor(`${group.category}:${group.key}`),
          perDay,
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
      for (const built of persisted) noteExposure(built);
      continue;
    }

    const built = buildCategoryCoupons(underCap(candidates), settings, matrix, weights, groupKeys, ledgerFor(`${group.category}:${group.key}`), perDay);

    for (const coupon of built.coupons) {
      await persistCoupon({ ...coupon, strategy: `focus_${group.key}` }, run.id, options);
      noteExposure(coupon);
      couponsGenerated++;
    }


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
  // --- Single-match surprise: one match, its goal markets stacked ----------
  {
    const wanted = Math.max(0, SINGLE_MATCH_SURPRISE.count - standingCount('HIGH_VALUE', 'single_match'));
    if (wanted > 0 && options.categorySettings.HIGH_VALUE?.enabled) {
      const stacks = buildSingleMatchStacks(underCap(candidates), { ...SINGLE_MATCH_SURPRISE, count: wanted, asOf });
      for (const stack of stacks) {
        await persistCoupon(stack, run.id, options);
        noteExposure(stack);
        couponsGenerated++;
      }
      outcomes.push({
        category: 'HIGH_VALUE',
        requested: SINGLE_MATCH_SURPRISE.count,
        produced: stacks.length,
        candidatePool: candidates.filter((c) => (SINGLE_MATCH_SURPRISE.leagues as readonly string[]).includes(c.leagueCode ?? '')).length,
        shortfallReason: stacks.length < wanted ? 'no_match_with_anchor_and_btts_priced' : null,
      });
    }
  }

  for (const sourceCategory of options.systemSettings.sourceCategories) {
    const settings = options.categorySettings[sourceCategory as CouponCategory];
    if (!settings) continue;

    const systemOutcome = await generateSystemCoupons(
      underCap(candidates),
      matrix,
      options,
      run.id,
      weights,
      groupKeys,
      sourceCategory as CouponCategory,
      { ledger: ledgerFor(`${sourceCategory}:system`), perDay },
    );
    outcomes.push(systemOutcome.outcome);
    couponsGenerated += systemOutcome.produced;
    for (const built of systemOutcome.persisted) noteExposure(built);
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
    poolEligible: pool.eligible,
    poolFixtures: pool.fixtures,
  });

  return {
    runId: run.id,
    couponsGenerated,
    candidatesEvaluated: candidates.length,
    matchesConsidered: new Set(candidates.map((c) => c.matchId)).size,
    outcomes,
    pool: {
      considered: pool.predictionsConsidered,
      eligible: pool.eligible,
      rejected: pool.rejected,
      fixtures: pool.fixtures,
      leagues: pool.leagues,
      reasons: pool.reasons,
    },
  };
}

export async function persistCoupon(
  coupon: BuiltCoupon,
  runId: string,
  options: GenerateOptions,
): Promise<string> {
  const kickoffs = coupon.selections.map((s) => s.kickoffUtc.getTime());

  const created = await prisma.coupon.create({
    data: {
      generationRunId: runId,
      category: coupon.category,
      kind: 'STANDARD',
      reference: await referenceFor(coupon.category, coupon.targetDate),
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
    /** Fixtures the rest of this publication has already spent. */
    ledger?: GenerationLedger;
    /** False when a slate may draw across the whole coverage window. */
    perDay?: boolean;
  } = {},
): Promise<{ outcome: CategoryOutcome; produced: number; persisted: BuiltCoupon[] }> {
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
    return { outcome, produced: 0, persisted: [] as BuiltCoupon[] };
  }

  const sizes = parseSystemSizes(system.defaultSystemType);
  if (sizes.length === 0) {
    outcome.shortfallReason = 'invalid_system_type';
    return { outcome, produced: 0, persisted: [] as BuiltCoupon[] };
  }
  const smallestSize = sizes[0] as number;

  const pool = filterForCategory(candidates, settings);
  outcome.candidatePool = pool.length;

  if (pool.length < system.minBaseSelections) {
    outcome.shortfallReason = 'insufficient_candidates_for_base_set';
    return { outcome, produced: 0, persisted: [] as BuiltCoupon[] };
  }

  const persisted: BuiltCoupon[] = [];
  let produced = 0;

  /**
   * One base set per day gave one system per day, so a slate of three needed
   * three separate match days and quietly produced one. Each pass starts
   * further down the ranking instead, which yields a genuinely different base
   * set out of the same day's candidates.
   */
  const attemptsPerDay = Math.max(1, system.couponCount);

  /**
   * Fixtures an earlier system in this slate already used.
   *
   * Without it three systems drawn from the same day's ranking share most of
   * their legs, and the slate is one coupon shown three times. The first round
   * insists on fresh fixtures; a second round drops the insistence only if the
   * slate could not otherwise be filled.
   */
  /**
   * Seeded from the run-wide ledger, not empty.
   *
   * Each slate kept its own list, so the İY/MS system and the plain system
   * drawn from the same HIGH_VALUE pool produced the identical six fixtures —
   * two coupons on one page, same matches, presented as two ideas. Starting
   * from what the run has already spent makes the first round reach for
   * something new; the later rounds still relax when the pool has nothing.
   */
  const slateMatches = new Set<string>(override?.ledger?.usedMatches ?? []);
  /**
   * Base sets already produced.
   *
   * The relaxed second round draws from the same ranking with the exclusion
   * lifted, so without this it rebuilds the set the first round already used
   * and the slate shows the same coupon twice at the same odds.
   */
  const slateSignatures = new Set<string>();
  /** Fixture sets already published in this slate, for the overlap check. */
  const slateFixtureSets: Array<Set<string>> = [];

  /**
   * How much of a new system may repeat an earlier one, round by round.
   *
   * Round 0 insists on entirely fresh fixtures. The relaxed round used to drop
   * that outright, and `slateSignatures` did not catch the result because it
   * compares *selections*: two systems over the identical eight fixtures with
   * one leg picked differently are different signatures and the same coupon to
   * a reader. Overlap is now capped on fixtures and loosened a step at a time,
   * so a slate reuses a match only when there is genuinely nothing else left.
   */
  // Same rule as the straight coupons: no shared fixture inside a slate, and
  // the exception only where the alternative is producing nothing at all.
  const ROUND_MAX_OVERLAP = [0, 1];

  for (const round of ROUND_MAX_OVERLAP.keys()) {
    // Same rule as the straight coupons: a slate that already has something
    // stops rather than repeating it. See OVERLAP_TIERS above.
    // Same rule: slateMatches is seeded from the category ledger, so a slate
    // that follows another in the same category is never "the first".
    if ((ROUND_MAX_OVERLAP[round] ?? 1) >= 1 && (produced > 0 || slateMatches.size > 0)) break;

  for (const groupKey of groupKeys) {
    if (produced >= system.couponCount) break;

    const dayPool = pool
      .filter((c) => (override.perDay !== false ? c.targetDate === groupKey : true))
      .sort((a, b) => Number(b.expectedValue) - Number(a.expectedValue));

    for (let pass = 0; pass < attemptsPerDay; pass++) {
    if (produced >= system.couponCount) break;

    /**
     * Filtered per pass, not per day: the exclusion list grows as each system
     * is built, and a snapshot taken before the first one is empty for all
     * three. Each pass also starts further down the ranking, so two systems
     * drawn from the same day are different sets rather than the same set
     * shifted by one.
     */
    const fresh =
      round > 0 ? dayPool : dayPool.filter((c) => !slateMatches.has(c.fixtureKey));
    const groupPool = pass === 0 ? fresh : fresh.slice(pass);

    const base: Candidate[] = [];
    const usedMatches = new Set<string>();

    for (const candidate of groupPool) {
      if (base.length >= system.maxBaseSelections) break;
      if (system.oneSelectionPerMatch && usedMatches.has(candidate.fixtureKey)) continue;
      if (maxCorrelationWith(matrix, refOf(candidate), base.map(refOf)) > system.maxCorrelation) {
        continue;
      }
      base.push(candidate);
      usedMatches.add(candidate.fixtureKey);
    }

    if (base.length < system.minBaseSelections || base.length < Math.max(...sizes)) continue;

    const signature = base
      .map((c) => c.predictionId)
      .sort()
      .join('|');
    if (slateSignatures.has(signature)) continue;

    const fixtures = new Set(base.map((c) => c.fixtureKey));
    const maxOverlap = ROUND_MAX_OVERLAP[round] ?? 1;
    const worstOverlap = slateFixtureSets.reduce((worst, previous) => {
      let shared = 0;
      for (const matchId of fixtures) if (previous.has(matchId)) shared++;
      return Math.max(worst, shared / fixtures.size);
    }, 0);
    if (worstOverlap > maxOverlap) continue;

    slateSignatures.add(signature);
    slateFixtureSets.push(fixtures);

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
        /**
         * A system's cost is columns x stake per column, and that total still
         * has to clear the minimum a slip can be placed for. Ten columns at one
         * lira is ten lira, which no shop would take — the misli goes up until
         * the coupon is playable.
         */
        stakePerColumn: systemStakePerColumn(system.stakePerColumn, plannedColumns(sizes, base.length)),
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

    /**
     * The category's odds band applies to a system too.
     *
     * A system's headline number is the full parlay — what every leg landing
     * would return — and the band was only ever checked on straight coupons, so
     * a category asking for 500 was handed systems at 202 and 36. The same ten
     * per cent tolerance applies, for the same reason: a near miss is not worth
     * discarding a slate over.
     */
    const settingsForBand = settings;
    if (settingsForBand) {
      if (Number(totalOdds) < oddsFloor(settingsForBand)) {
        outcome.shortfallReason = 'system_below_odds_floor';
        continue;
      }
      const ceiling = oddsCeiling(settingsForBand);
      if (ceiling !== null && Number(totalOdds) > ceiling) {
        outcome.shortfallReason = 'system_above_odds_ceiling';
        continue;
      }
    }

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

    const couponId = await persistCoupon(built, runId, options);
    persisted.push(built);
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
    base.forEach((c) => {
      slateMatches.add(c.fixtureKey);
      override?.ledger?.usedMatches.add(c.fixtureKey);
      override?.ledger?.usedMarkets.add(c.marketCode);
    });
    }
  }
  if (produced >= system.couponCount) break;
  }

  outcome.produced = produced;
  if (produced < system.couponCount && !outcome.shortfallReason) {
    outcome.shortfallReason = 'insufficient_candidates_for_base_set';
  }

  return { outcome, produced, persisted };
}
