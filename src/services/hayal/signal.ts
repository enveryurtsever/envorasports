import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { MARKET, halfTimeCorrectScoreCode } from '@/lib/markets/registry';
import { getAppSetting } from '@/lib/config/settings-service';

const log = createLogger('hayal:signal');

/**
 * The HAYAL signal, applied exactly as it was stated.
 *
 * The claim: a short price on "both teams score in both halves" marks a match
 * the bookmakers expect goals in, and a short price on a 2-2 half time marks it
 * more strongly still. Nothing else enters the decision — no Elo, no Poisson,
 * no form, no model probability. Adding any of those would produce a better
 * filter and a worthless test, because whatever came out could no longer be
 * attributed to the claim.
 *
 * The thresholds are configurable so a later analysis can ask whether 8.00 and
 * 38.00 were the right numbers, but every signal row records the thresholds it
 * was judged under, so retuning them can never rewrite an earlier verdict.
 */

export const HAYAL_DEFAULTS = {
  /** "HT/FT BTTS < 8.00" as stated. */
  bttsThreshold: 8,
  /** "HT 2-2 < 38.00" as stated. */
  ht22Threshold: 38,
} as const;

export interface HayalThresholds {
  bttsThreshold: number;
  ht22Threshold: number;
}

export async function loadHayalThresholds(): Promise<HayalThresholds> {
  const [bttsThreshold, ht22Threshold] = await Promise.all([
    getAppSetting<number>('hayal.bttsThreshold', HAYAL_DEFAULTS.bttsThreshold),
    getAppSetting<number>('hayal.ht22Threshold', HAYAL_DEFAULTS.ht22Threshold),
  ]);
  return { bttsThreshold, ht22Threshold };
}

export interface HayalVerdict {
  matchId: string;
  bttsBothHalvesOdds: number | null;
  halfTime22Odds: number | null;
  bttsUnderThreshold: boolean;
  ht22UnderThreshold: boolean;
  /** Both conditions together. */
  premium: boolean;
  /** True when the fixture is a candidate at all. */
  qualifies: boolean;
  oddsCapturedAt: Date | null;
}

/**
 * Judges one fixture from two prices.
 *
 * A market the bulletin did not carry is `null`, which is not the same as a
 * long price: an absent price is no evidence either way and can never satisfy
 * a "below X" test. Treating a missing quote as passing is the single easiest
 * way to manufacture a signal that is not there.
 */
export function judge(
  input: {
    matchId: string;
    bttsBothHalvesOdds: number | null;
    halfTime22Odds: number | null;
    oddsCapturedAt: Date | null;
  },
  thresholds: HayalThresholds,
): HayalVerdict {
  const bttsUnderThreshold =
    input.bttsBothHalvesOdds !== null && input.bttsBothHalvesOdds < thresholds.bttsThreshold;
  const ht22UnderThreshold =
    input.halfTime22Odds !== null && input.halfTime22Odds < thresholds.ht22Threshold;

  return {
    matchId: input.matchId,
    bttsBothHalvesOdds: input.bttsBothHalvesOdds,
    halfTime22Odds: input.halfTime22Odds,
    bttsUnderThreshold,
    ht22UnderThreshold,
    // Rule 3: the strongest candidate needs both. Rule 1 alone is enough to be
    // a candidate at all.
    premium: bttsUnderThreshold && ht22UnderThreshold,
    qualifies: bttsUnderThreshold,
    oddsCapturedAt: input.oddsCapturedAt,
  };
}

/**
 * Best price per selection as of a cutoff.
 *
 * "Best" is the shortest price, not the longest — the opposite of the value
 * engine's rule, and deliberately so. The signal is "the market thinks this is
 * likely", and the market's strongest opinion is its shortest quote. Taking the
 * longest would let one outlying book turn a non-signal into a signal.
 */
async function shortestPrices(
  matchIds: string[],
  asOf: Date,
): Promise<Map<string, Map<string, { price: number; capturedAt: Date }>>> {
  if (matchIds.length === 0) return new Map();

  const rows = await prisma.odds.findMany({
    where: {
      matchId: { in: matchIds },
      capturedAt: { lte: asOf },
      available: true,
      market: {
        code: { in: [MARKET.BTTS_BOTH_HALVES, MARKET.HALF_TIME_CORRECT_SCORE] },
      },
    },
    select: {
      matchId: true,
      price: true,
      capturedAt: true,
      selection: { select: { code: true } },
    },
  });

  const byMatch = new Map<string, Map<string, { price: number; capturedAt: Date }>>();
  for (const row of rows) {
    const price = Number(row.price);
    if (!Number.isFinite(price) || price <= 1) continue;

    const forMatch = byMatch.get(row.matchId) ?? new Map();
    const current = forMatch.get(row.selection.code);
    if (!current || price < current.price) {
      forMatch.set(row.selection.code, { price, capturedAt: row.capturedAt });
    }
    byMatch.set(row.matchId, forMatch);
  }
  return byMatch;
}

export interface SignalRunResult {
  fixturesConsidered: number;
  /** Fixtures the bulletin priced the signal market for. */
  fixturesWithSignalMarket: number;
  candidates: number;
  premium: number;
  signalsWritten: number;
  thresholds: HayalThresholds;
}

/**
 * Evaluates every scheduled fixture in a window and records the verdict.
 *
 * Runs whether or not a fixture qualifies: a rule that only writes down its
 * hits cannot be graded against a baseline, and the baseline is the whole
 * point of asking whether the signal adds anything.
 */
export async function detectHayalSignals(options: {
  from: Date;
  to: Date;
  asOf?: Date;
}): Promise<SignalRunResult> {
  const asOf = options.asOf ?? new Date();
  const thresholds = await loadHayalThresholds();

  const matches = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: { gte: options.from, lt: options.to },
      status: 'SCHEDULED',
      excludedFromGeneration: false,
    },
    select: { id: true, scheduledKickoffUtc: true },
  });

  const result: SignalRunResult = {
    fixturesConsidered: matches.length,
    fixturesWithSignalMarket: 0,
    candidates: 0,
    premium: 0,
    signalsWritten: 0,
    thresholds,
  };
  if (matches.length === 0) return result;

  const prices = await shortestPrices(
    matches.map((m) => m.id),
    asOf,
  );
  const ht22Code = halfTimeCorrectScoreCode(2, 2);

  const rows: Prisma.HayalSignalCreateManyInput[] = [];
  for (const match of matches) {
    const forMatch = prices.get(match.id);
    const btts = forMatch?.get('BTTS_BOTH_HALVES_YES') ?? null;
    const ht22 = forMatch?.get(ht22Code) ?? null;

    if (btts) result.fixturesWithSignalMarket++;

    const verdict = judge(
      {
        matchId: match.id,
        bttsBothHalvesOdds: btts?.price ?? null,
        halfTime22Odds: ht22?.price ?? null,
        oddsCapturedAt: btts?.capturedAt ?? ht22?.capturedAt ?? null,
      },
      thresholds,
    );

    if (verdict.qualifies) result.candidates++;
    if (verdict.premium) result.premium++;

    rows.push({
      matchId: match.id,
      bttsBothHalvesOdds:
        verdict.bttsBothHalvesOdds === null
          ? null
          : new Prisma.Decimal(verdict.bttsBothHalvesOdds.toFixed(3)),
      halfTime22Odds:
        verdict.halfTime22Odds === null
          ? null
          : new Prisma.Decimal(verdict.halfTime22Odds.toFixed(3)),
      bttsUnderThreshold: verdict.bttsUnderThreshold,
      ht22UnderThreshold: verdict.ht22UnderThreshold,
      bttsThreshold: new Prisma.Decimal(thresholds.bttsThreshold.toFixed(3)),
      ht22Threshold: new Prisma.Decimal(thresholds.ht22Threshold.toFixed(3)),
      premium: verdict.premium,
      signalCapturedAt: asOf,
      oddsCapturedAt: verdict.oddsCapturedAt,
      matchStartTime: match.scheduledKickoffUtc,
    });
  }

  const written = await prisma.hayalSignal.createMany({ data: rows, skipDuplicates: true });
  result.signalsWritten = written.count;

  log.info('hayal signals evaluated', {
    ...result,
    asOf: asOf.toISOString(),
  });
  return result;
}
