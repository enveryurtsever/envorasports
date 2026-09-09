import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { MARKET, overUnderCode, halfTimeOverUnderCode } from '@/lib/markets/registry';
import { dateKeyToUtcMidnight, localDateKey, type LocalDateKey } from '@/lib/time/zoned';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';

const log = createLogger('hayal:coupons');

/**
 * The three HAYAL slates.
 *
 * Which fixtures are eligible is decided entirely by the signal. The model is
 * consulted only for a leg's probability, and only to display it and to
 * multiply the legs together — never to admit or reject a fixture. If that
 * distinction is ever lost, the category stops testing the claim it was built
 * to test.
 *
 * "Over 6.5" appears in the specification for the Cilgin slate and is not
 * offered here, because it is the same event as 7+ goals, which a Turkish
 * bulletin does not carry and which this system deliberately stopped pricing.
 * The highest line the slate can reach is Over 5.5.
 */

export type HayalVariantKey = 'HAYAL_NORMAL' | 'HAYAL_STRONG' | 'HAYAL_PREMIUM' | 'HAYAL_CRAZY';

interface SlateDefinition {
  key: 'NORMAL' | 'STRONG' | 'CRAZY';
  /** Markets in preference order; earlier entries are chosen first. */
  markets: string[];
  minSelections: number;
  maxSelections: number;
  /** CRAZY draws only from fixtures carrying both signals. */
  premiumOnly: boolean;
  couponCount: number;
}

export const HAYAL_SLATES: SlateDefinition[] = [
  {
    key: 'NORMAL',
    markets: [overUnderCode('OVER', 2.5), overUnderCode('OVER', 3.5)],
    minSelections: 2,
    maxSelections: 4,
    premiumOnly: false,
    couponCount: 2,
  },
  {
    key: 'STRONG',
    markets: [
      overUnderCode('OVER', 2.5),
      overUnderCode('OVER', 3.5),
      overUnderCode('OVER', 4.5),
      overUnderCode('OVER', 5.5),
    ],
    minSelections: 2,
    maxSelections: 4,
    premiumOnly: false,
    couponCount: 2,
  },
  {
    key: 'CRAZY',
    markets: [
      overUnderCode('OVER', 3.5),
      overUnderCode('OVER', 4.5),
      overUnderCode('OVER', 5.5),
      // The claim's own words: "at least two goals in the first half".
      halfTimeOverUnderCode('OVER', 1.5),
      halfTimeOverUnderCode('OVER', 2.5),
    ],
    minSelections: 2,
    maxSelections: 3,
    premiumOnly: true,
    couponCount: 2,
  },
];

interface Leg {
  predictionId: string;
  matchId: string;
  marketCode: string;
  selectionCode: string;
  odds: number;
  probability: number;
  impliedProbability: number;
  edge: number;
  expectedValue: number;
  kickoffUtc: Date;
  premium: boolean;
}

export interface HayalGenerationResult {
  signalsConsidered: number;
  candidates: number;
  premiumCandidates: number;
  couponsGenerated: number;
  /** Per slate: what it produced, or why it produced nothing. */
  slates: Array<{
    variant: HayalVariantKey;
    produced: number;
    pool: number;
    shortfallReason: string | null;
  }>;
}

/** Multiplies probabilities; independence across different fixtures. */
function combinedProbability(legs: Leg[]): number {
  return legs.reduce((product, leg) => product * leg.probability, 1);
}

/**
 * Mean leg probability — the figure shown as "tutma gucu".
 *
 * It is not the chance the coupon lands, and the two are reported separately
 * for exactly that reason: a three-leg coupon of 75% legs averages 75% and
 * comes in 42% of the time. Presenting the average alone would overstate the
 * product by a factor that grows with every leg added.
 */
function averageSelectionStrength(legs: Leg[]): number {
  if (legs.length === 0) return 0;
  return legs.reduce((sum, leg) => sum + leg.probability, 0) / legs.length;
}

export interface HayalGenerateOptions {
  window: CoverageWindow;
  timezone: string;
  modelVersionId: string;
  settingsSnapshotId: string;
  generationRunId: string;
  asOf?: Date;
}

export async function generateHayalCoupons(
  options: HayalGenerateOptions,
): Promise<HayalGenerationResult> {
  const asOf = options.asOf ?? new Date();

  // Latest verdict per fixture in the window.
  const signals = await prisma.hayalSignal.findMany({
    where: {
      matchStartTime: { gte: options.window.startUtc, lt: options.window.endUtc },
      signalCapturedAt: { lte: asOf },
      match: { status: 'SCHEDULED', excludedFromGeneration: false },
    },
    orderBy: { signalCapturedAt: 'desc' },
    select: {
      matchId: true,
      premium: true,
      bttsUnderThreshold: true,
      bttsBothHalvesOdds: true,
      halfTime22Odds: true,
      signalCapturedAt: true,
      oddsCapturedAt: true,
      matchStartTime: true,
    },
  });

  const latest = new Map<string, (typeof signals)[number]>();
  for (const signal of signals) if (!latest.has(signal.matchId)) latest.set(signal.matchId, signal);

  const qualifying = [...latest.values()].filter((s) => s.bttsUnderThreshold);
  const premiumIds = new Set(qualifying.filter((s) => s.premium).map((s) => s.matchId));

  const result: HayalGenerationResult = {
    signalsConsidered: latest.size,
    candidates: qualifying.length,
    premiumCandidates: premiumIds.size,
    couponsGenerated: 0,
    slates: [],
  };

  if (qualifying.length === 0) {
    for (const slate of HAYAL_SLATES) {
      result.slates.push({
        variant: variantFor(slate, false),
        produced: 0,
        pool: 0,
        shortfallReason: 'no_hayal_candidate',
      });
    }
    log.info('no hayal candidates in window', { window: options.window.days });
    return result;
  }

  const legsByMatch = await loadLegs(
    qualifying.map((s) => s.matchId),
    options.modelVersionId,
    asOf,
    premiumIds,
  );

  let referenceIndex = 0;
  const usedFixtures = new Set<string>();
  /**
   * Leg sets already published this run, across every slate.
   *
   * `pickLegs` only *prefers* fixtures no coupon has used, so once a thin pool
   * is exhausted it hands back the same legs again — and a slate asking for two
   * coupons got the same two legs twice, while Normal and Premium published a
   * third and fourth copy of it under different names. Four identical coupons
   * are worse than one, so an exact repeat ends its slate instead.
   */
  const publishedLegSets = new Set<string>();

  for (const slate of HAYAL_SLATES) {
    const eligibleMatches = qualifying
      .filter((s) => (slate.premiumOnly ? s.premium : true))
      .map((s) => s.matchId);

    const pool = eligibleMatches
      .flatMap((matchId) => legsByMatch.get(matchId) ?? [])
      .filter((leg) => slate.markets.includes(leg.selectionCode));

    let produced = 0;
    let shortfallReason: string | null = null;

    for (let attempt = 0; attempt < slate.couponCount; attempt++) {
      const legs = pickLegs(pool, slate, usedFixtures);

      if (legs.length < slate.minSelections) {
        // The instruction is explicit: do not force a coupon out of a thin
        // slate. One qualifying fixture is not a coupon.
        shortfallReason =
          pool.length === 0 ? 'no_priced_selection_for_slate' : 'not_enough_hayal_candidates';
        break;
      }

      const signature = legs
        .map((leg) => `${leg.matchId}:${leg.selectionCode}`)
        .sort()
        .join('|');
      if (publishedLegSets.has(signature)) {
        shortfallReason = 'duplicate_of_existing_coupon';
        break;
      }
      publishedLegSets.add(signature);

      const variant = variantFor(slate, legs.every((leg) => leg.premium));
      const signalsForCoupon = legs.map((leg) => {
        const signal = latest.get(leg.matchId);
        return {
          matchId: leg.matchId,
          bttsBothHalvesOdds: signal?.bttsBothHalvesOdds ? Number(signal.bttsBothHalvesOdds) : null,
          halfTime22Odds: signal?.halfTime22Odds ? Number(signal.halfTime22Odds) : null,
          bttsUnderThreshold: signal?.bttsUnderThreshold ?? false,
          ht22UnderThreshold: signal?.premium ?? false,
          premium: signal?.premium ?? false,
        };
      });

      await persistHayalCoupon({
        legs,
        variant,
        slateKey: slate.key,
        referenceIndex: referenceIndex++,
        options,
        asOf,
        signals: signalsForCoupon,
        signalCapturedAt: legs.reduce(
          (newest, leg) => {
            const captured = latest.get(leg.matchId)?.signalCapturedAt;
            return captured && captured > newest ? captured : newest;
          },
          new Date(0),
        ),
        oddsCapturedAt:
          legs.reduce<Date | null>((newest, leg) => {
            const captured = latest.get(leg.matchId)?.oddsCapturedAt ?? null;
            if (!captured) return newest;
            return !newest || captured > newest ? captured : newest;
          }, null),
      });

      legs.forEach((leg) => usedFixtures.add(leg.matchId));
      produced++;
      result.couponsGenerated++;
    }

    result.slates.push({
      variant: variantFor(slate, slate.premiumOnly),
      produced,
      pool: pool.length,
      shortfallReason,
    });
  }

  log.info('hayal coupons generated', {
    candidates: result.candidates,
    premium: result.premiumCandidates,
    coupons: result.couponsGenerated,
  });
  return result;
}

function variantFor(slate: SlateDefinition, allPremium: boolean): HayalVariantKey {
  if (slate.key === 'CRAZY') return 'HAYAL_CRAZY';
  if (slate.key === 'NORMAL') return 'HAYAL_NORMAL';
  return allPremium ? 'HAYAL_PREMIUM' : 'HAYAL_STRONG';
}

/**
 * One leg per fixture, preferring fixtures no other HAYAL coupon has used and
 * the slate's earlier markets over its later ones.
 */
function pickLegs(pool: Leg[], slate: SlateDefinition, usedFixtures: Set<string>): Leg[] {
  const ranked = [...pool].sort((a, b) => {
    const freshness = Number(usedFixtures.has(a.matchId)) - Number(usedFixtures.has(b.matchId));
    if (freshness !== 0) return freshness;

    const preference =
      slate.markets.indexOf(a.selectionCode) - slate.markets.indexOf(b.selectionCode);
    if (preference !== 0) return preference;

    // Within a market, the fixture the bookmakers rate highest for goals.
    return b.probability - a.probability;
  });

  const legs: Leg[] = [];
  const seen = new Set<string>();
  for (const leg of ranked) {
    if (legs.length >= slate.maxSelections) break;
    // One selection per fixture: two goal lines on one match are the same bet
    // twice and multiplying them overstates the coupon badly.
    if (seen.has(leg.matchId)) continue;
    seen.add(leg.matchId);
    legs.push(leg);
  }
  return legs;
}

/** Model predictions for the goal markets the slates use, where they exist. */
async function loadLegs(
  matchIds: string[],
  modelVersionId: string,
  asOf: Date,
  premiumIds: Set<string>,
): Promise<Map<string, Leg[]>> {
  const wanted = new Set(HAYAL_SLATES.flatMap((slate) => slate.markets));

  const predictions = await prisma.prediction.findMany({
    where: {
      matchId: { in: matchIds },
      modelVersionId,
      supersededAt: null,
      status: 'PENDING',
      predictionTimestamp: { lte: asOf },
      market: { code: { in: [MARKET.OVER_UNDER, MARKET.HALF_TIME_OVER_UNDER] } },
    },
    orderBy: { predictionTimestamp: 'desc' },
    select: {
      id: true,
      matchId: true,
      probability: true,
      impliedProbability: true,
      oddsUsed: true,
      edge: true,
      expectedValue: true,
      market: { select: { code: true } },
      selection: { select: { code: true } },
      match: { select: { scheduledKickoffUtc: true } },
    },
  });

  const byMatch = new Map<string, Leg[]>();
  const seen = new Set<string>();

  for (const prediction of predictions) {
    const key = `${prediction.matchId}:${prediction.selection.code}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (!wanted.has(prediction.selection.code)) continue;
    if (prediction.oddsUsed === null) continue;

    const leg: Leg = {
      predictionId: prediction.id,
      matchId: prediction.matchId,
      marketCode: prediction.market.code,
      selectionCode: prediction.selection.code,
      odds: Number(prediction.oddsUsed),
      probability: Number(prediction.probability),
      impliedProbability: Number(prediction.impliedProbability ?? 0),
      edge: Number(prediction.edge ?? 0),
      expectedValue: Number(prediction.expectedValue ?? 0),
      kickoffUtc: prediction.match.scheduledKickoffUtc,
      premium: premiumIds.has(prediction.matchId),
    };
    byMatch.set(leg.matchId, [...(byMatch.get(leg.matchId) ?? []), leg]);
  }

  return byMatch;
}

interface PersistInput {
  legs: Leg[];
  variant: HayalVariantKey;
  slateKey: SlateDefinition['key'];
  referenceIndex: number;
  options: HayalGenerateOptions;
  asOf: Date;
  signals: unknown;
  signalCapturedAt: Date;
  oddsCapturedAt: Date | null;
}

async function persistHayalCoupon(input: PersistInput): Promise<void> {
  const { legs, options } = input;

  const totalOdds = legs.reduce((product, leg) => product * leg.odds, 1);
  const probability = combinedProbability(legs);
  const strength = averageSelectionStrength(legs);
  const kickoffs = legs.map((leg) => leg.kickoffUtc.getTime());

  const targetDate: LocalDateKey = localDateKey(
    new Date(Math.min(...kickoffs)),
    options.timezone,
  );
  const reference = `HY-${targetDate}-${String(input.referenceIndex + 1).padStart(2, '0')}`;

  const coupon = await prisma.coupon.create({
    data: {
      generationRunId: options.generationRunId,
      category: 'HAYAL',
      kind: 'STANDARD',
      reference,
      name: `hayal_${input.slateKey.toLowerCase()}`,
      targetDate: dateKeyToUtcMidnight(targetDate),
      firstKickoffUtc: new Date(Math.min(...kickoffs)),
      lastKickoffUtc: new Date(Math.max(...kickoffs)),
      totalOdds: new Prisma.Decimal(totalOdds.toFixed(4)),
      estimatedProbability: new Prisma.Decimal(probability.toFixed(8)),
      expectedValue: new Prisma.Decimal((totalOdds * probability - 1).toFixed(6)),
      // A market-pattern coupon has no model confidence of its own. The average
      // leg strength is the nearest honest thing, and it is labelled as such.
      confidenceScore: new Prisma.Decimal(strength.toFixed(4)),
      riskScore: new Prisma.Decimal((1 - probability).toFixed(4)),
      correlationScore: new Prisma.Decimal('0'),
      diversificationScore: new Prisma.Decimal('0'),
      score: new Prisma.Decimal('0'),
      selectionCount: legs.length,
      modelVersionId: options.modelVersionId,
      settingsSnapshotId: options.settingsSnapshotId,
      generationTimestamp: input.asOf,
      selections: {
        create: legs.map((leg, index) => ({
          predictionId: leg.predictionId,
          matchId: leg.matchId,
          marketCode: leg.marketCode,
          selectionCode: leg.selectionCode,
          odds: new Prisma.Decimal(leg.odds.toFixed(3)),
          probability: new Prisma.Decimal(leg.probability.toFixed(8)),
          impliedProbability: new Prisma.Decimal(leg.impliedProbability.toFixed(8)),
          edge: new Prisma.Decimal(leg.edge.toFixed(6)),
          expectedValue: new Prisma.Decimal(leg.expectedValue.toFixed(6)),
          sortOrder: index,
        })),
      },
      hayal: {
        create: {
          variant: input.variant,
          combinedProbability: new Prisma.Decimal(probability.toFixed(8)),
          averageSelectionStrength: new Prisma.Decimal(strength.toFixed(8)),
          signals: input.signals as Prisma.InputJsonValue,
          signalCapturedAt: input.signalCapturedAt,
          oddsCapturedAt: input.oddsCapturedAt,
        },
      },
    },
    select: { id: true },
  });

  log.info('hayal coupon persisted', {
    reference,
    variant: input.variant,
    legs: legs.length,
    couponId: coupon.id,
  });
}
