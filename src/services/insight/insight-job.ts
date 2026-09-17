import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db/prisma';
import { serverEnv } from '@/lib/env';
import { createLogger } from '@/lib/logging/logger';
import { getAppSetting } from '@/lib/config/settings-service';
import {
  boundedAdjustments,
  researchFixture,
  structureInsight,
  type FixtureDossier,
} from '@/lib/insight/insight-service';
import { runPredictions } from '@/services/predictions/prediction-engine';

const log = createLogger('insight:job');

/**
 * Reads the news for the fixtures about to be played, then re-prices them.
 *
 * A fixture is researched once it is inside the horizon and refreshed once
 * more close to kick-off, when the line-ups and late fitness news are out.
 * Each reading costs one grounded search; the free allowance is 5,000 a
 * month, so the horizon and the refresh are the budget, and both are
 * settings.
 */
export interface InsightJobResult {
  considered: number;
  researched: number;
  discarded: number;
  failed: number;
  repriced: number;
}

/** How long a reading stands before it is refreshed near kick-off. */
const DEFAULT_REFRESH_HOURS = 12;
/** Refresh only inside this window before kick-off; earlier readings stand. */
const DEFAULT_LATE_WINDOW_HOURS = 6;

export async function runInsightPass(
  options: { now?: Date; maxPerRun?: number; horizonHours?: number } = {},
): Promise<InsightJobResult> {
  const result: InsightJobResult = { considered: 0, researched: 0, discarded: 0, failed: 0, repriced: 0 };
  if (serverEnv().INSIGHT_PROVIDER !== 'gemini') return result;

  const now = options.now ?? new Date();
  const [maxPerRun, horizonHours, delayMs, refreshHours, lateWindowHours] = await Promise.all([
    options.maxPerRun ?? getAppSetting<number>('insight.maxPerRun', 25),
    options.horizonHours ?? getAppSetting<number>('insight.horizonHours', 36),
    getAppSetting<number>('insight.delayBetweenCallsMs', 3000),
    getAppSetting<number>('insight.refreshHours', DEFAULT_REFRESH_HOURS),
    getAppSetting<number>('insight.lateWindowHours', DEFAULT_LATE_WINDOW_HOURS),
  ]);

  const horizon = new Date(now.getTime() + horizonHours * 3_600_000);

  // Fixtures the model has an opinion on; a reading for an unpriced match
  // changes nothing and costs a search.
  const fixtures = await prisma.match.findMany({
    where: {
      status: 'SCHEDULED',
      excludedFromGeneration: false,
      scheduledKickoffUtc: { gt: now, lte: horizon },
      predictions: { some: { supersededAt: null, status: 'PENDING' } },
    },
    orderBy: { scheduledKickoffUtc: 'asc' },
    select: {
      id: true,
      scheduledKickoffUtc: true,
      homeTeam: { select: { name: true } },
      awayTeam: { select: { name: true } },
      league: { select: { name: true, country: true } },
      insight: { select: { asOf: true } },
      predictions: {
        where: { supersededAt: null, status: 'PENDING' },
        select: { probability: true, selection: { select: { code: true } }, breakdown: true },
      },
    },
  });

  const due = fixtures.filter((f) => {
    if (!f.insight) return true;
    const hoursToKickoff = (f.scheduledKickoffUtc.getTime() - now.getTime()) / 3_600_000;
    const ageHours = (now.getTime() - f.insight.asOf.getTime()) / 3_600_000;
    return hoursToKickoff <= lateWindowHours && ageHours >= refreshHours;
  });
  result.considered = due.length;

  const repriceFrom: Date[] = [];
  let calls = 0;

  for (const fixture of due.slice(0, maxPerRun)) {
    if (calls > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    calls++;

    const view = modelView(fixture.predictions);
    const dossier: FixtureDossier = {
      homeTeam: fixture.homeTeam.name,
      awayTeam: fixture.awayTeam.name,
      league: fixture.league.name,
      kickoffUtc: fixture.scheduledKickoffUtc,
      venueCountry: fixture.league.country,
      modelView: view,
    };

    try {
      const research = await researchFixture(dossier);
      if (!research) {
        result.discarded++;
        continue;
      }
      const payload = await structureInsight(dossier, research.research);
      const bounded = boundedAdjustments(payload);

      await prisma.matchInsight.upsert({
        where: { matchId: fixture.id },
        create: {
          matchId: fixture.id,
          model: research.model,
          asOf: now,
          research: research.research,
          payload: payload as unknown as Prisma.InputJsonValue,
          sources: research.sources as unknown as Prisma.InputJsonValue,
          searchQueries: research.queries as unknown as Prisma.InputJsonValue,
          homeGoalAdjustment: new Prisma.Decimal(bounded.homeGoalAdjustment.toFixed(3)),
          awayGoalAdjustment: new Prisma.Decimal(bounded.awayGoalAdjustment.toFixed(3)),
          resultLean: new Prisma.Decimal(bounded.resultLean.toFixed(3)),
          confidence: new Prisma.Decimal(bounded.confidence.toFixed(3)),
        },
        update: {
          model: research.model,
          asOf: now,
          research: research.research,
          payload: payload as unknown as Prisma.InputJsonValue,
          sources: research.sources as unknown as Prisma.InputJsonValue,
          searchQueries: research.queries as unknown as Prisma.InputJsonValue,
          homeGoalAdjustment: new Prisma.Decimal(bounded.homeGoalAdjustment.toFixed(3)),
          awayGoalAdjustment: new Prisma.Decimal(bounded.awayGoalAdjustment.toFixed(3)),
          resultLean: new Prisma.Decimal(bounded.resultLean.toFixed(3)),
          confidence: new Prisma.Decimal(bounded.confidence.toFixed(3)),
        },
      });

      result.researched++;
      repriceFrom.push(fixture.scheduledKickoffUtc);
      log.info('fixture read', {
        fixture: `${fixture.homeTeam.name}-${fixture.awayTeam.name}`,
        sources: research.sources.length,
        confidence: bounded.confidence,
        goals: [bounded.homeGoalAdjustment, bounded.awayGoalAdjustment],
        lean: bounded.resultLean,
      });
    } catch (error) {
      result.failed++;
      log.error('fixture reading failed', {
        fixture: `${fixture.homeTeam.name}-${fixture.awayTeam.name}`,
        error: String(error),
      });
      // A quota refusal will not clear within the run.
      if (/429|RESOURCE_EXHAUSTED/.test(String(error))) break;
    }
  }

  // The readings only matter once the model has run over them.
  if (repriceFrom.length > 0) {
    const from = new Date(Math.min(...repriceFrom.map((d) => d.getTime())) - 1);
    const to = new Date(Math.max(...repriceFrom.map((d) => d.getTime())) + 1);
    const priced = await runPredictions({ from, to, asOf: new Date() });
    result.repriced = priced.matchesPriced;
  }

  log.info('insight pass complete', { ...result });
  return result;
}

/** The model's current 1X2 and expected goals, for the structuring prompt. */
function modelView(
  predictions: Array<{ probability: Prisma.Decimal; selection: { code: string }; breakdown: Prisma.JsonValue }>,
): FixtureDossier['modelView'] {
  const p = (code: string) => {
    const row = predictions.find((r) => r.selection.code === code);
    return row ? Number(row.probability) : null;
  };
  const home = p('MS_1');
  const draw = p('MS_X');
  const away = p('MS_2');
  if (home === null || draw === null || away === null) return undefined;

  const breakdown = predictions[0]?.breakdown as { models?: { poisson?: { lambdaHome?: number; lambdaAway?: number } } } | null;
  const lambdaHome = breakdown?.models?.poisson?.lambdaHome ?? null;
  const lambdaAway = breakdown?.models?.poisson?.lambdaAway ?? null;
  const expectedGoals = lambdaHome !== null && lambdaAway !== null ? lambdaHome + lambdaAway : 2.6;

  return { homeWin: home, draw, awayWin: away, expectedGoals };
}
