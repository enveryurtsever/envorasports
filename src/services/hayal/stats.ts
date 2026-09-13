import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { HAYAL_DEFAULTS, loadHayalThresholds } from './signal';

const log = createLogger('hayal:stats');

/**
 * Grading the claim, separately from everything else.
 *
 * The outcomes below are read straight off the finished match. No prediction,
 * no coupon and no model version is involved, which is what lets the HAYAL
 * numbers stay true whether the main model is having a good month or a bad one.
 *
 * Every signal row is graded, including the ones that did not qualify — those
 * are the baseline. A hit rate with nothing to compare it against cannot answer
 * the only question worth asking: does the signal add anything over simply
 * looking at every match on the bulletin?
 */

/** The goal markets the claim is about. */
export const HAYAL_OUTCOME_KEYS = [
  'over1_5',
  'over2_5',
  'over3_5',
  'over4_5',
  'over5_5',
  'over6_5',
  'htOver0_5',
  'htOver1_5',
  'htOver2_5',
  'bttsBothHalves',
] as const;

export type HayalOutcomeKey = (typeof HAYAL_OUTCOME_KEYS)[number];
export type HayalOutcomes = Record<HayalOutcomeKey, boolean>;

export interface GradableMatch {
  homeScore: number;
  awayScore: number;
  halfTimeHomeScore: number;
  halfTimeAwayScore: number;
}

export function gradeMatch(match: GradableMatch): HayalOutcomes {
  const total = match.homeScore + match.awayScore;
  const halfTimeTotal = match.halfTimeHomeScore + match.halfTimeAwayScore;

  const secondHalfHome = match.homeScore - match.halfTimeHomeScore;
  const secondHalfAway = match.awayScore - match.halfTimeAwayScore;

  return {
    over1_5: total > 1.5,
    over2_5: total > 2.5,
    over3_5: total > 3.5,
    over4_5: total > 4.5,
    // Measured but not offered: 7+ goals is not on a Turkish bulletin. A number
    // can be reported without a bet being sold against it.
    over5_5: total > 5.5,
    over6_5: total > 6.5,
    htOver0_5: halfTimeTotal > 0.5,
    htOver1_5: halfTimeTotal > 1.5,
    htOver2_5: halfTimeTotal > 2.5,
    bttsBothHalves:
      match.halfTimeHomeScore > 0 &&
      match.halfTimeAwayScore > 0 &&
      secondHalfHome > 0 &&
      secondHalfAway > 0,
  };
}

export interface GradeRunResult {
  signalsGraded: number;
  matchesFinished: number;
  awaitingHalfTimeScore: number;
}

/**
 * Writes the outcome onto every signal whose match has finished.
 *
 * A match without a half-time score is left ungraded rather than graded on the
 * full-time score alone: half the claim is about the first half, and filling
 * the gap with an assumption would quietly bias every half-time figure.
 */
export async function gradeHayalSignals(options: { limit?: number } = {}): Promise<GradeRunResult> {
  const signals = await prisma.hayalSignal.findMany({
    where: {
      settledAt: null,
      match: { status: { in: ['FINISHED', 'AWARDED'] } },
    },
    take: options.limit ?? 2000,
    select: {
      id: true,
      match: {
        select: {
          homeScore: true,
          awayScore: true,
          halfTimeHomeScore: true,
          halfTimeAwayScore: true,
        },
      },
    },
  });

  const result: GradeRunResult = {
    signalsGraded: 0,
    matchesFinished: signals.length,
    awaitingHalfTimeScore: 0,
  };

  const now = new Date();
  for (const signal of signals) {
    const { homeScore, awayScore, halfTimeHomeScore, halfTimeAwayScore } = signal.match;
    if (
      homeScore === null ||
      awayScore === null ||
      halfTimeHomeScore === null ||
      halfTimeAwayScore === null
    ) {
      result.awaitingHalfTimeScore++;
      continue;
    }

    const outcomes = gradeMatch({ homeScore, awayScore, halfTimeHomeScore, halfTimeAwayScore });
    await prisma.hayalSignal.update({
      where: { id: signal.id },
      data: { outcomes: outcomes as unknown as Prisma.InputJsonValue, settledAt: now },
    });
    result.signalsGraded++;
  }

  log.info('hayal signals graded', { ...result });
  return result;
}

/**
 * Below this many graded fixtures a hit rate is not a finding.
 *
 * One match gives 100% and a fifty-point lift, and the page was presenting
 * that beside a real baseline as though the two were comparable. Thirty is
 * where a rate around a half has a standard error near nine points — still
 * wide, but no longer arithmetic dressed up as evidence.
 */
export const MIN_COHORT_SAMPLE = 30;

export interface CohortReport {
  label: string;
  sampleSize: number;
  hitRates: Record<HayalOutcomeKey, number | null>;
  /** False while the sample is too small for the rates to mean anything. */
  sufficient: boolean;
}

export interface HayalReport {
  generatedAt: Date;
  /** Every graded signal, qualifying or not — the comparison set. */
  baseline: CohortReport;
  cohorts: CohortReport[];
  /** Signal hit rate minus baseline, per market. Positive means it adds value. */
  lift: Record<string, Record<HayalOutcomeKey, number | null>>;
  coupons: HayalCouponReport;
  totals: { signals: number; graded: number; candidates: number; premium: number };
}

export interface HayalCouponReport {
  total: number;
  settled: number;
  won: number;
  lost: number;
  winRate: number | null;
  averageCombinedOdds: number | null;
  /** Sum of (1/odds) over settled coupons — what the prices implied. */
  theoreticalWinRate: number | null;
  /** Flat one-unit stakes: (returns - stakes) / stakes. */
  actualRoi: number | null;
  byVariant: Array<{
    variant: string;
    total: number;
    settled: number;
    won: number;
    winRate: number | null;
    roi: number | null;
  }>;
}

function emptyRates(): Record<HayalOutcomeKey, number | null> {
  return Object.fromEntries(HAYAL_OUTCOME_KEYS.map((key) => [key, null])) as Record<
    HayalOutcomeKey,
    number | null
  >;
}

function summarise(label: string, rows: Array<{ outcomes: unknown }>): CohortReport {
  const counts = Object.fromEntries(HAYAL_OUTCOME_KEYS.map((key) => [key, 0])) as Record<
    HayalOutcomeKey,
    number
  >;
  let sampleSize = 0;

  for (const row of rows) {
    const outcomes = row.outcomes as Partial<HayalOutcomes> | null;
    if (!outcomes) continue;
    sampleSize++;
    for (const key of HAYAL_OUTCOME_KEYS) if (outcomes[key] === true) counts[key]++;
  }

  const hitRates = emptyRates();
  if (sampleSize > 0) {
    for (const key of HAYAL_OUTCOME_KEYS) hitRates[key] = counts[key] / sampleSize;
  }
  return { label, sampleSize, hitRates, sufficient: sampleSize >= MIN_COHORT_SAMPLE };
}

/**
 * The report the whole category exists to produce.
 *
 * Cohorts are cut on the *stored* prices rather than on the stored verdict, so
 * "under 7.00" can be asked of rows that were written when the threshold was
 * 8.00 — the question "was 8.00 the right number" needs exactly that.
 *
 * The first cohorts are the test actually running: the live thresholds, read
 * at report time. The page was still cutting at 8.00 after the threshold moved
 * to 9.50, and so showed a five-fixture cohort as the state of a test that had
 * fifteen — the wrong test, presented as the right one.
 */
export async function buildHayalReport(): Promise<HayalReport> {
  const thresholds = await loadHayalThresholds();
  /**
   * One row per fixture, whatever the signal history holds.
   *
   * Signals are append-only and a fixture accumulates a row every time its
   * price moves. Counting them all would weight a fixture by how often it was
   * repriced — a busy market would dominate the hit rate for no reason that has
   * anything to do with goals. The last verdict before kickoff is the one that
   * stands, so that is the one counted.
   */
  const gradedRows = await prisma.hayalSignal.findMany({
    where: { settledAt: { not: null }, outcomes: { not: Prisma.DbNull } },
    orderBy: { signalCapturedAt: 'desc' },
    select: {
      matchId: true,
      outcomes: true,
      premium: true,
      bttsUnderThreshold: true,
      bttsBothHalvesOdds: true,
      halfTime22Odds: true,
      proxyBothHalvesOdds: true,
    },
  });

  const byMatch = new Map<string, (typeof gradedRows)[number]>();
  for (const row of gradedRows) if (!byMatch.has(row.matchId)) byMatch.set(row.matchId, row);
  const graded = [...byMatch.values()];

  const priced = graded.filter((row) => row.bttsBothHalvesOdds !== null);
  const under = (row: (typeof graded)[number], limit: number) =>
    row.bttsBothHalvesOdds !== null && Number(row.bttsBothHalvesOdds) < limit;
  const ht22Under = (row: (typeof graded)[number], limit: number) =>
    row.halfTime22Odds !== null && Number(row.halfTime22Odds) < limit;

  // Baseline: every fixture the signal market was priced for, signal or not.
  // Comparing against *all* fixtures would flatter the signal, because the
  // fixtures carrying this market are not a random sample of the bulletin.
  const baseline = summarise(
    'all priced fixtures',
    // Fall back to the proxy-priced set while the real market is unavailable,
    // so the cohorts below still have something to be measured against.
    priced.length > 0 ? priced : graded.filter((row) => row.proxyBothHalvesOdds !== null),
  );

  const btts = thresholds.bttsThreshold;
  const ht22 = thresholds.ht22Threshold;
  const price = (value: number) => value.toFixed(2);

  const cohorts: CohortReport[] = [
    summarise(
      `BTTS both halves < ${price(btts)}`,
      priced.filter((row) => under(row, btts)),
    ),
    summarise(
      `BTTS < ${price(btts)} + HT 2-2 < ${price(ht22)} (premium)`,
      priced.filter((row) => under(row, btts) && ht22Under(row, ht22)),
    ),
    // The fixtures the signal passed over. Lift against the baseline mixes the
    // signal into its own comparison set; against this cohort it does not.
    summarise(
      `BTTS both halves >= ${price(btts)} (control)`,
      priced.filter((row) => !under(row, btts)),
    ),
  ];

  // The claim as originally stated, kept so the retuned test is never
  // mistaken for the original one.
  const original = HAYAL_DEFAULTS.originalBttsThreshold;
  if (original !== btts) {
    cohorts.push(
      summarise(
        `BTTS both halves < ${price(original)} (as stated)`,
        priced.filter((row) => under(row, original)),
      ),
      summarise(
        `BTTS < ${price(original)} + HT 2-2 < ${price(ht22)} (as stated)`,
        priced.filter((row) => under(row, original) && ht22Under(row, ht22)),
      ),
    );
  }

  /**
   * The proxy, reported beside the real thing rather than mixed into it.
   *
   * Its cohort is drawn from every fixture where both halves were priced, which
   * is a different — and today much larger — set than the one the real market
   * covers. Kept separate so that when both exist over the same fixtures, the
   * question "does multiplying the halves say the same thing" has an answer.
   */
  const withProxy = graded.filter((row) => row.proxyBothHalvesOdds !== null);
  const proxyUnder = (row: (typeof graded)[number], limit: number) =>
    row.proxyBothHalvesOdds !== null && Number(row.proxyBothHalvesOdds) < limit;

  if (withProxy.length > 0) {
    cohorts.push(
      summarise(
        `proxy (half x half) < ${price(btts)}`,
        withProxy.filter((row) => proxyUnder(row, btts)),
      ),
      summarise(
        `proxy < ${price(btts)} + HT 2-2 < ${price(ht22)}`,
        withProxy.filter((row) => proxyUnder(row, btts) && ht22Under(row, ht22)),
      ),
    );
  }

  const lift: HayalReport['lift'] = {};
  for (const cohort of cohorts) {
    const entry = emptyRates();
    for (const key of HAYAL_OUTCOME_KEYS) {
      const cohortRate = cohort.hitRates[key];
      const baseRate = baseline.hitRates[key];
      entry[key] = cohortRate === null || baseRate === null ? null : cohortRate - baseRate;
    }
    lift[cohort.label] = entry;
  }

  // Counted as distinct fixtures, for the same reason the cohorts are.
  const [totalSignals, candidates, premium] = await Promise.all([
    prisma.hayalSignal.findMany({ distinct: ['matchId'], select: { matchId: true } }),
    prisma.hayalSignal.findMany({
      where: { bttsUnderThreshold: true },
      distinct: ['matchId'],
      select: { matchId: true },
    }),
    prisma.hayalSignal.findMany({
      where: { premium: true },
      distinct: ['matchId'],
      select: { matchId: true },
    }),
  ]);

  return {
    generatedAt: new Date(),
    baseline,
    cohorts,
    lift,
    coupons: await buildCouponReport(),
    totals: {
      signals: totalSignals.length,
      graded: graded.length,
      candidates: candidates.length,
      premium: premium.length,
    },
  };
}

async function buildCouponReport(): Promise<HayalCouponReport> {
  const coupons = await prisma.coupon.findMany({
    where: { category: 'HAYAL' },
    select: {
      resultStatus: true,
      totalOdds: true,
      effectiveOdds: true,
      hayal: { select: { variant: true } },
    },
  });

  const settledStatuses = new Set(['WON', 'LOST', 'VOID']);
  const settled = coupons.filter((c) => settledStatuses.has(c.resultStatus));
  const won = settled.filter((c) => c.resultStatus === 'WON');

  const stake = settled.length;
  const returns = won.reduce((sum, c) => sum + Number(c.effectiveOdds ?? c.totalOdds), 0);

  const byVariantMap = new Map<string, typeof coupons>();
  for (const coupon of coupons) {
    const key = coupon.hayal?.variant ?? 'UNKNOWN';
    byVariantMap.set(key, [...(byVariantMap.get(key) ?? []), coupon]);
  }

  return {
    total: coupons.length,
    settled: settled.length,
    won: won.length,
    lost: settled.filter((c) => c.resultStatus === 'LOST').length,
    winRate: settled.length === 0 ? null : won.length / settled.length,
    averageCombinedOdds:
      coupons.length === 0
        ? null
        : coupons.reduce((sum, c) => sum + Number(c.totalOdds), 0) / coupons.length,
    // What the prices themselves implied, so the realised rate has something to
    // be measured against rather than being reported on its own.
    theoreticalWinRate:
      settled.length === 0
        ? null
        : settled.reduce((sum, c) => sum + 1 / Number(c.totalOdds), 0) / settled.length,
    actualRoi: stake === 0 ? null : (returns - stake) / stake,
    byVariant: [...byVariantMap].map(([variant, list]) => {
      const s = list.filter((c) => settledStatuses.has(c.resultStatus));
      const w = s.filter((c) => c.resultStatus === 'WON');
      const r = w.reduce((sum, c) => sum + Number(c.effectiveOdds ?? c.totalOdds), 0);
      return {
        variant,
        total: list.length,
        settled: s.length,
        won: w.length,
        winRate: s.length === 0 ? null : w.length / s.length,
        roi: s.length === 0 ? null : (r - s.length) / s.length,
      };
    }),
  };
}
