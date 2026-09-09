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
  /**
   * Was 8.00, as the claim was stated. It never once fired.
   *
   * Across every fixture a provider has priced this market on, the shortest
   * quote was 8.30 and the median 10.25 — so "below 8.00" describes something
   * that did not happen in 1,689 recorded signals, and the test could not
   * begin. 9.50 is not a round number picked to make it fire: it selects the
   * shortest 20.7% of observed prices, against the 21.5% that the HT 2-2 leg
   * of the same claim already selects. Same selectivity, so the two halves of
   * the claim are being asked an equally hard question.
   *
   * Every signal row stores the threshold it was judged under, so the 1,689
   * rows judged at 8.00 stay distinguishable from the ones judged at 9.50 and
   * no earlier verdict is rewritten.
   */
  bttsThreshold: 9.5,
  /** "HT 2-2 < 38.00" as stated. Fires on 21.5% of quotes; left alone. */
  ht22Threshold: 38,
} as const;

export interface HayalThresholds {
  bttsThreshold: number;
  ht22Threshold: number;
  /**
   * Whether the two halves multiplied together may stand in for the combined
   * market when no provider prices it.
   *
   * Off. The product is not the same bet — the halves are positively
   * correlated, so it understates the chance and quotes a longer price, and a
   * "below 8.00" test on it is stricter than the claim. The proxy is recorded
   * on every fixture either way, so turning this on later starts a test that
   * can still be told apart from the real one, row by row.
   */
  allowProxySignal: boolean;
}

export async function loadHayalThresholds(): Promise<HayalThresholds> {
  const [bttsThreshold, ht22Threshold, allowProxySignal] = await Promise.all([
    getAppSetting<number>('hayal.bttsThreshold', HAYAL_DEFAULTS.bttsThreshold),
    getAppSetting<number>('hayal.ht22Threshold', HAYAL_DEFAULTS.ht22Threshold),
    getAppSetting<boolean>('hayal.allowProxySignal', false),
  ]);
  return { bttsThreshold, ht22Threshold, allowProxySignal };
}

export type HayalSignalSourceKey = 'NONE' | 'MARKET' | 'PROXY';

export interface HayalVerdict {
  matchId: string;
  bttsBothHalvesOdds: number | null;
  halfTime22Odds: number | null;
  /** The halves priced separately, and their product. Recorded, not trusted. */
  bttsFirstHalfOdds: number | null;
  bttsSecondHalfOdds: number | null;
  proxyBothHalvesOdds: number | null;
  /** Which price the verdict below was actually taken from. */
  signalSource: HayalSignalSourceKey;
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
    bttsFirstHalfOdds: number | null;
    bttsSecondHalfOdds: number | null;
    oddsCapturedAt: Date | null;
  },
  thresholds: HayalThresholds,
): HayalVerdict {
  /**
   * Both halves multiplied. Recorded on every fixture that has both prices,
   * whether or not it is allowed to decide anything.
   */
  const proxyBothHalvesOdds =
    input.bttsFirstHalfOdds !== null && input.bttsSecondHalfOdds !== null
      ? input.bttsFirstHalfOdds * input.bttsSecondHalfOdds
      : null;

  /**
   * The real market first, always. The proxy is consulted only when the real
   * price is absent *and* it has been explicitly allowed — never as a
   * tie-breaker, and never silently.
   */
  const signalOdds =
    input.bttsBothHalvesOdds !== null
      ? { price: input.bttsBothHalvesOdds, source: 'MARKET' as const }
      : thresholds.allowProxySignal && proxyBothHalvesOdds !== null
        ? { price: proxyBothHalvesOdds, source: 'PROXY' as const }
        : null;

  const bttsUnderThreshold =
    signalOdds !== null && signalOdds.price < thresholds.bttsThreshold;
  const ht22UnderThreshold =
    input.halfTime22Odds !== null && input.halfTime22Odds < thresholds.ht22Threshold;

  return {
    matchId: input.matchId,
    bttsBothHalvesOdds: input.bttsBothHalvesOdds,
    halfTime22Odds: input.halfTime22Odds,
    bttsFirstHalfOdds: input.bttsFirstHalfOdds,
    bttsSecondHalfOdds: input.bttsSecondHalfOdds,
    proxyBothHalvesOdds,
    signalSource: signalOdds?.source ?? 'NONE',
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
        code: {
          in: [
            MARKET.BTTS_BOTH_HALVES,
            MARKET.HALF_TIME_CORRECT_SCORE,
            // Fetched for the record, not for the verdict. See `judge`.
            MARKET.BTTS_FIRST_HALF,
            MARKET.BTTS_SECOND_HALF,
          ],
        },
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
  /** Fixtures the bulletin priced the real signal market for. */
  fixturesWithSignalMarket: number;
  /** Fixtures where both halves were priced, so the proxy could be recorded. */
  fixturesWithProxyMarket: number;
  candidates: number;
  premium: number;
  /** Of the candidates, how many were judged on the proxy rather than the market. */
  candidatesFromProxy: number;
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
    fixturesWithProxyMarket: 0,
    candidates: 0,
    premium: 0,
    candidatesFromProxy: 0,
    signalsWritten: 0,
    thresholds,
  };
  if (matches.length === 0) return result;

  const prices = await shortestPrices(
    matches.map((m) => m.id),
    asOf,
  );
  const ht22Code = halfTimeCorrectScoreCode(2, 2);

  /**
   * What was last recorded for each fixture.
   *
   * The job ticks every half hour, and writing a row each time would put fifty
   * identical rows a day behind one fixture — which is not an audit trail, and
   * worse, the hit-rate report counts rows: one fixture would have carried the
   * weight of fifty. A row is written when the verdict or a price it rests on
   * actually moves.
   */
  const previous = await prisma.hayalSignal.findMany({
    where: { matchId: { in: matches.map((m) => m.id) } },
    orderBy: { signalCapturedAt: 'desc' },
    select: {
      matchId: true,
      bttsBothHalvesOdds: true,
      halfTime22Odds: true,
      proxyBothHalvesOdds: true,
      bttsUnderThreshold: true,
      ht22UnderThreshold: true,
      signalCapturedAt: true,
    },
  });
  const latestByMatch = new Map<string, (typeof previous)[number]>();
  for (const row of previous) if (!latestByMatch.has(row.matchId)) latestByMatch.set(row.matchId, row);

  const same = (stored: Prisma.Decimal | null, fresh: number | null) =>
    stored === null ? fresh === null : fresh !== null && Number(stored) === Number(fresh.toFixed(3));

  const rows: Prisma.HayalSignalCreateManyInput[] = [];
  for (const match of matches) {
    const forMatch = prices.get(match.id);
    const btts = forMatch?.get('BTTS_BOTH_HALVES_YES') ?? null;
    const ht22 = forMatch?.get(ht22Code) ?? null;
    const firstHalf = forMatch?.get('BTTS_H1_YES') ?? null;
    const secondHalf = forMatch?.get('BTTS_H2_YES') ?? null;

    if (btts) result.fixturesWithSignalMarket++;
    if (firstHalf && secondHalf) result.fixturesWithProxyMarket++;

    const verdict = judge(
      {
        matchId: match.id,
        bttsBothHalvesOdds: btts?.price ?? null,
        halfTime22Odds: ht22?.price ?? null,
        bttsFirstHalfOdds: firstHalf?.price ?? null,
        bttsSecondHalfOdds: secondHalf?.price ?? null,
        oddsCapturedAt:
          btts?.capturedAt ?? ht22?.capturedAt ?? firstHalf?.capturedAt ?? null,
      },
      thresholds,
    );

    if (verdict.qualifies) result.candidates++;
    if (verdict.premium) result.premium++;
    if (verdict.qualifies && verdict.signalSource === 'PROXY') result.candidatesFromProxy++;

    const last = latestByMatch.get(match.id);
    const unchanged =
      last !== undefined &&
      last.bttsUnderThreshold === verdict.bttsUnderThreshold &&
      last.ht22UnderThreshold === verdict.ht22UnderThreshold &&
      same(last.bttsBothHalvesOdds, verdict.bttsBothHalvesOdds) &&
      same(last.halfTime22Odds, verdict.halfTime22Odds) &&
      same(last.proxyBothHalvesOdds, verdict.proxyBothHalvesOdds);
    if (unchanged) continue;

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
      bttsFirstHalfOdds:
        verdict.bttsFirstHalfOdds === null
          ? null
          : new Prisma.Decimal(verdict.bttsFirstHalfOdds.toFixed(3)),
      bttsSecondHalfOdds:
        verdict.bttsSecondHalfOdds === null
          ? null
          : new Prisma.Decimal(verdict.bttsSecondHalfOdds.toFixed(3)),
      proxyBothHalvesOdds:
        verdict.proxyBothHalvesOdds === null
          ? null
          : new Prisma.Decimal(verdict.proxyBothHalvesOdds.toFixed(3)),
      signalSource: verdict.signalSource,
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
