import { prisma } from '@/lib/db/prisma';
import { MARKET, halfTimeCorrectScoreCode } from '@/lib/markets/registry';
import { gradeMatch, HAYAL_OUTCOME_KEYS, type HayalOutcomeKey, type HayalOutcomes } from './stats';

/**
 * The claim, tested against history.
 *
 * Two rules keep this honest:
 *
 *  1. Only prices captured before a cutoff — a fixed lead on kickoff — are
 *     read. A closing price is contaminated by everything the market learned
 *     up to kick-off, and a price captured after the whistle is contaminated by
 *     the result itself. Either would make the signal look prophetic.
 *  2. Cohorts are cut on the price, not on a stored verdict, so a threshold can
 *     be questioned after the fact without rewriting what was recorded.
 *
 * If the archive carries no price for the signal market, this reports that and
 * returns nothing. It does not substitute a related market, and it does not
 * fall back to the model — either would answer a different question quietly.
 */

export interface HayalBacktestOptions {
  from: Date;
  to: Date;
  /** How long before kickoff the price must have been captured. */
  leadMinutes?: number;
  /** Cohort definitions to compare; defaults to the claim as stated. */
  thresholds?: Array<{ label: string; btts: number; ht22?: number }>;
  maxMatches?: number;
}

export interface HayalBacktestCohort {
  label: string;
  sampleSize: number;
  hitRates: Record<HayalOutcomeKey, number | null>;
  /** Hit rate minus the baseline's, per market. */
  lift: Record<HayalOutcomeKey, number | null>;
}

export interface HayalBacktestResult {
  from: Date;
  to: Date;
  leadMinutes: number;
  matchesInRange: number;
  /** Finished matches with a usable half-time score. */
  gradableMatches: number;
  /** Of those, how many had the signal market priced before the cutoff. */
  matchesWithSignalPrice: number;
  baseline: { label: string; sampleSize: number; hitRates: Record<HayalOutcomeKey, number | null> };
  cohorts: HayalBacktestCohort[];
  /** Set when nothing could be measured, with the reason. */
  unavailableReason: string | null;
}

const DEFAULT_THRESHOLDS = [
  { label: 'BTTS both halves < 8.00', btts: 8 },
  { label: 'BTTS both halves < 7.00', btts: 7 },
  { label: 'BTTS < 8.00 + HT 2-2 < 38.00', btts: 8, ht22: 38 },
];

function rates(rows: HayalOutcomes[]): Record<HayalOutcomeKey, number | null> {
  const result = Object.fromEntries(HAYAL_OUTCOME_KEYS.map((k) => [k, null])) as Record<
    HayalOutcomeKey,
    number | null
  >;
  if (rows.length === 0) return result;

  for (const key of HAYAL_OUTCOME_KEYS) {
    result[key] = rows.filter((row) => row[key]).length / rows.length;
  }
  return result;
}

export async function runHayalBacktest(
  options: HayalBacktestOptions,
): Promise<HayalBacktestResult> {
  const leadMinutes = options.leadMinutes ?? 120;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;

  const matches = await prisma.match.findMany({
    where: {
      status: { in: ['FINISHED', 'AWARDED'] },
      scheduledKickoffUtc: { gte: options.from, lt: options.to },
      homeScore: { not: null },
      awayScore: { not: null },
      halfTimeHomeScore: { not: null },
      halfTimeAwayScore: { not: null },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    ...(options.maxMatches ? { take: options.maxMatches } : {}),
    select: {
      id: true,
      scheduledKickoffUtc: true,
      homeScore: true,
      awayScore: true,
      halfTimeHomeScore: true,
      halfTimeAwayScore: true,
    },
  });

  const matchesInRange = await prisma.match.count({
    where: { scheduledKickoffUtc: { gte: options.from, lt: options.to } },
  });

  const base: HayalBacktestResult = {
    from: options.from,
    to: options.to,
    leadMinutes,
    matchesInRange,
    gradableMatches: matches.length,
    matchesWithSignalPrice: 0,
    baseline: { label: 'all priced fixtures', sampleSize: 0, hitRates: rates([]) },
    cohorts: [],
    unavailableReason: null,
  };

  if (matches.length === 0) {
    base.unavailableReason = 'no finished matches with a half-time score in range';
    return base;
  }

  const ht22Code = halfTimeCorrectScoreCode(2, 2);

  // Prices captured strictly before the cutoff. Everything after it could have
  // been moved by information the signal is not allowed to have.
  const priced = await prisma.odds.findMany({
    where: {
      matchId: { in: matches.map((m) => m.id) },
      market: { code: { in: [MARKET.BTTS_BOTH_HALVES, MARKET.HALF_TIME_CORRECT_SCORE] } },
    },
    select: {
      matchId: true,
      price: true,
      capturedAt: true,
      selection: { select: { code: true } },
    },
  });

  const kickoffs = new Map(matches.map((m) => [m.id, m.scheduledKickoffUtc]));
  const shortest = new Map<string, { btts: number | null; ht22: number | null }>();

  for (const row of priced) {
    const kickoff = kickoffs.get(row.matchId);
    if (!kickoff) continue;

    const cutoff = new Date(kickoff.getTime() - leadMinutes * 60_000);
    if (row.capturedAt > cutoff) continue;

    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 1) continue;

    const entry = shortest.get(row.matchId) ?? { btts: null, ht22: null };
    if (row.selection.code === 'BTTS_BOTH_HALVES_YES') {
      entry.btts = entry.btts === null ? price : Math.min(entry.btts, price);
    } else if (row.selection.code === ht22Code) {
      entry.ht22 = entry.ht22 === null ? price : Math.min(entry.ht22, price);
    }
    shortest.set(row.matchId, entry);
  }

  const graded = matches.map((match) => ({
    matchId: match.id,
    prices: shortest.get(match.id) ?? { btts: null, ht22: null },
    outcomes: gradeMatch({
      homeScore: match.homeScore as number,
      awayScore: match.awayScore as number,
      halfTimeHomeScore: match.halfTimeHomeScore as number,
      halfTimeAwayScore: match.halfTimeAwayScore as number,
    }),
  }));

  const withSignalPrice = graded.filter((row) => row.prices.btts !== null);
  base.matchesWithSignalPrice = withSignalPrice.length;

  if (withSignalPrice.length === 0) {
    base.unavailableReason =
      'the archive holds no "both teams score in both halves" price captured before kickoff — ' +
      'the signal cannot be evaluated historically until that market is ingested';
    // The outcome side is still reported: it is the bar the signal has to beat.
    base.baseline = {
      label: 'all gradable fixtures (outcome baseline only)',
      sampleSize: graded.length,
      hitRates: rates(graded.map((row) => row.outcomes)),
    };
    return base;
  }

  const baselineRates = rates(withSignalPrice.map((row) => row.outcomes));
  base.baseline = {
    label: 'all priced fixtures',
    sampleSize: withSignalPrice.length,
    hitRates: baselineRates,
  };

  base.cohorts = thresholds.map((threshold) => {
    const rows = withSignalPrice.filter((row) => {
      if (row.prices.btts === null || row.prices.btts >= threshold.btts) return false;
      if (threshold.ht22 === undefined) return true;
      return row.prices.ht22 !== null && row.prices.ht22 < threshold.ht22;
    });

    const cohortRates = rates(rows.map((row) => row.outcomes));
    const lift = Object.fromEntries(
      HAYAL_OUTCOME_KEYS.map((key) => {
        const cohortRate = cohortRates[key];
        const baseRate = baselineRates[key];
        return [key, cohortRate === null || baseRate === null ? null : cohortRate - baseRate];
      }),
    ) as Record<HayalOutcomeKey, number | null>;

    return { label: threshold.label, sampleSize: rows.length, hitRates: cohortRates, lift };
  });

  return base;
}
