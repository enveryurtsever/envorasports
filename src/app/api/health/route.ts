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
        },
        odds: {
          name: status.providers.odds.name,
          used: status.providers.odds.quota.used,
          budget: status.providers.odds.quota.budget,
          remaining: status.providers.odds.quota.remaining,
          window: status.providers.odds.quota.window,
        },
      },
      awaitingResult: status.awaitingResult,
      pendingCoupons: status.pendingCoupons,
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
