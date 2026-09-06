import { NextResponse } from 'next/server';
import { getPipelineStatus } from '@/services/jobs/registry';

export const dynamic = 'force-dynamic';

/** Operational snapshot: schedule, coverage window, quota, recent job runs. */
export async function GET() {
  try {
    const status = await getPipelineStatus();
    return NextResponse.json({
      ok: true,
      today: status.today,
      isPublicationDay: status.isPublicationDay,
      activePublication: status.activePublication,
      nextPublication: status.nextPublication,
      coverage: { start: status.window.startDate, end: status.window.endDate, days: status.window.days },
      providers: {
        football: {
          name: status.providers.football.name,
          used: status.providers.football.quota.used,
          budget: status.providers.football.quota.budget,
          remaining: status.providers.football.quota.remaining,
          window: status.providers.football.quota.window,
          // The provider itself refused work for budget reasons, and when the
          // hold lifts. Absent this, an exhausted budget is indistinguishable
          // from a quiet one.
          exhausted: status.providers.football.quota.exhausted,
          resetAt: status.providers.football.quota.resetAt,
          endpointUsage: status.providers.football.quota.endpointUsage,
        },
        odds: {
          name: status.providers.odds.name,
          used: status.providers.odds.quota.used,
          budget: status.providers.odds.quota.budget,
          remaining: status.providers.odds.quota.remaining,
          window: status.providers.odds.quota.window,
          exhausted: status.providers.odds.quota.exhausted,
          resetAt: status.providers.odds.quota.resetAt,
          endpointUsage: status.providers.odds.quota.endpointUsage,
        },
      },
      awaitingResult: status.awaitingResult,
      pendingCoupons: status.pendingCoupons,
      // Fixture-by-fixture account of the last prediction run, so a coverage
      // gap explains itself instead of needing to be investigated by hand.
      predictionCoverage: status.coverage,
      recentRuns: status.recentRuns.map((run) => ({
        job: run.jobName,
        status: run.status,
        at: run.createdAt,
        processed: run.itemsProcessed,
        error: run.error,
      })),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error) }, { status: 500 });
  }
}
