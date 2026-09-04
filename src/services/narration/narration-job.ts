import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { narrate } from '@/lib/narration/narration-service';
import { getAppSetting } from '@/lib/config/settings-service';
import type { CoverageWindow } from '@/lib/schedule/bulletin-schedule';

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
}

export async function narrateWindow(
  window: CoverageWindow,
  options: { locales?: Array<'en' | 'tr'>; maxPerRun?: number } = {},
): Promise<NarrationJobResult> {
  const locales = options.locales ?? ['en', 'tr'];
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
  };

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

      const outcome = await narrate({
        entityType: 'match',
        entityId: match.id,
        locale,
        payload,
      });

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
