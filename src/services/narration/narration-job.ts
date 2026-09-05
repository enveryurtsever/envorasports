import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { narrate } from '@/lib/narration/narration-service';
import { getAppSetting } from '@/lib/config/settings-service';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';
import { getStandaloneIntl } from '@/i18n/standalone';
import { buildCouponNarrationPayload } from '@/services/narration/coupon-payload';

const log = createLogger('narration:job');

/**
 * Pre-generates match analyses into the narration cache.
 *
 * The Gemini free tier rate-limits per minute, so generating on page render
 * means the first visitor of each minute gets the template while the model
 * returns 429. Producing them in a paced background pass and serving from the
 * cache makes the page fast and the limit irrelevant.
 */

export interface NarrationJobResult {
  considered: number;
  generated: number;
  fromTemplate: number;
  callsMade: number;
  coupons: number;
}

export async function narrateWindow(
  window: CoverageWindow,
  options: { locales?: Array<'en' | 'tr'>; maxPerRun?: number } = {},
): Promise<NarrationJobResult> {
  // Turkish first: it is the default locale, so if the daily free-tier budget
  // runs out mid-pass, the language most readers see is the one with model copy.
  const locales = options.locales ?? ['tr', 'en'];
  const maxPerRun = options.maxPerRun ?? (await getAppSetting<number>('narration.maxPerRun', 20));
  const delayMs = await getAppSetting<number>('narration.delayBetweenCallsMs', 4000);

  const matches = await prisma.match.findMany({
    where: {
      scheduledKickoffUtc: { gte: window.startUtc, lt: window.endUtc },
      predictions: { some: {} },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true } },
      predictions: {
        orderBy: { predictionTimestamp: 'desc' },
        take: 6,
        select: {
          probability: true,
          oddsUsed: true,
          edge: true,
          confidenceScore: true,
          dataQualityScore: true,
          breakdown: true,
          market: { select: { code: true } },
          selection: { select: { code: true } },
        },
      },
    },
  });

  const result: NarrationJobResult = {
    considered: matches.length,
    generated: 0,
    fromTemplate: 0,
    callsMade: 0,
    coupons: 0,
  };

  // Coupons first: their analyses are what the reader opens from the card, so
  // they are the ones worth having in the cache before anyone asks.
  const coupons = await prisma.coupon.findMany({
    where: { targetDate: { gte: window.startUtc, lte: window.endUtc }, resultStatus: 'PENDING' },
    select: {
      id: true,
      reference: true,
      category: true,
      totalOdds: true,
      estimatedProbability: true,
      expectedValue: true,
      confidenceScore: true,
      riskScore: true,
      systemCoupon: {
        select: { systemSizes: true, baseSelectionCount: true, columnCount: true },
      },
      selections: {
        orderBy: { sortOrder: 'asc' },
        select: {
          marketCode: true,
          selectionCode: true,
          odds: true,
          probability: true,
          impliedProbability: true,
          edge: true,
          match: {
            select: {
              homeTeam: { select: { name: true } },
              awayTeam: { select: { name: true } },
              league: { select: { name: true } },
            },
          },
        },
      },
    },
  });

  for (const coupon of coupons) {
    if (result.callsMade >= maxPerRun) break;

    for (const locale of locales) {
      if (result.callsMade >= maxPerRun) break;

      // The payload is built per locale with readable picks and formatted
      // percentages. Handing the model `UNDER_3_5` and `0.5086` is how the
      // analysis ends up reading like a database dump.
      const { t, format } = await getStandaloneIntl(locale);

      const payload = buildCouponNarrationPayload(
        {
          reference: coupon.reference,
          category: coupon.category,
          totalOdds: Number(coupon.totalOdds),
          estimatedProbability: Number(coupon.estimatedProbability),
          expectedValue: Number(coupon.expectedValue),
          confidenceScore: Number(coupon.confidenceScore),
          riskScore: Number(coupon.riskScore),
          system: coupon.systemCoupon
            ? {
                label: coupon.systemCoupon.systemSizes.join(','),
                legs: coupon.systemCoupon.baseSelectionCount,
                columns: coupon.systemCoupon.columnCount,
              }
            : null,
          selections: coupon.selections.map((s) => ({
            homeTeam: s.match.homeTeam.name,
            awayTeam: s.match.awayTeam.name,
            league: s.match.league.name,
            marketCode: s.marketCode,
            selectionCode: s.selectionCode,
            odds: Number(s.odds),
            probability: Number(s.probability),
            impliedProbability: Number(s.impliedProbability),
            edge: Number(s.edge),
          })),
        },
        t,
        format,
      );

      const outcome = await narrate(
        { entityType: 'coupon', entityId: coupon.id, locale, payload },
        { allowGeneration: true },
      );

      if (outcome.source === 'model') result.generated++;
      else result.fromTemplate++;

      result.callsMade++;
      result.coupons++;
      if (result.callsMade < maxPerRun) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  for (const match of matches) {
    if (result.callsMade >= maxPerRun) break;

    const breakdown = match.predictions[0]?.breakdown as
      | { modelAgreement?: number; models?: Record<string, unknown> }
      | null;

    const payload = {
      homeTeam: match.homeTeam.name,
      awayTeam: match.awayTeam.name,
      league: match.league.name,
      kickoff: match.scheduledKickoffUtc.toISOString(),
      modelAgreement: breakdown?.modelAgreement ?? null,
      dataQuality: match.predictions[0] ? Number(match.predictions[0].dataQualityScore) : null,
      hasXg: Boolean((breakdown?.models as Record<string, unknown> | undefined)?.xg),
      selections: match.predictions.map((p) => ({
        market: p.market.code,
        selection: p.selection.code,
        probability: Number(p.probability),
        odds: p.oddsUsed === null ? null : Number(p.oddsUsed),
        edge: p.edge === null ? null : Number(p.edge),
        confidence: Number(p.confidenceScore),
      })),
    };

    for (const locale of locales) {
      if (result.callsMade >= maxPerRun) break;

      const outcome = await narrate(
        { entityType: 'match', entityId: match.id, locale, payload },
        { allowGeneration: true },
      );

      if (outcome.source === 'model') result.generated++;
      else result.fromTemplate++;

      result.callsMade++;
      // Pace the calls: the free tier's per-minute limit is the binding one.
      if (result.callsMade < maxPerRun) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  log.info('narration pass complete', { ...result });
  return result;
}
