import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { serverEnv } from '@/lib/env';
import { JOB_NAMES, runNamedJob, type JobName } from '@/services/jobs/registry';

/**
 * Cron entry point (§42).
 *
 * Deliberately hosting-agnostic: Vercel Cron, GitHub Actions, an external cron
 * or a queue worker can all call this. The schedule itself lives in the
 * database, so the caller only needs to tick often enough — the job decides
 * whether today is a publication day.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

function authorised(request: Request): boolean {
  const secret = serverEnv().JOB_TRIGGER_SECRET;
  // An unset secret must not silently allow the world to trigger ingestion.
  if (!secret) return false;

  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (provided.length !== secret.length) return false;

  return timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
}

export async function POST(request: Request, context: { params: Promise<{ job: string }> }) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const { job } = await context.params;
  if (!JOB_NAMES.includes(job as JobName)) {
    return NextResponse.json({ error: 'unknown_job', known: JOB_NAMES }, { status: 404 });
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('force') === 'true';
  const publicationDate = url.searchParams.get('publicationDate') ?? undefined;
  const divisions = url.searchParams.get('divisions')?.split(',').filter(Boolean);
  const seasons = url.searchParams
    .get('seasons')
    ?.split(',')
    .map(Number)
    .filter(Number.isInteger);

  const outcome = await runNamedJob(job as JobName, { force, publicationDate, divisions, seasons });

  // A skip is a normal outcome (not a publication day, quota exhausted, another
  // worker holds the lock), so it is 200 with a reason rather than an error.
  const status = outcome.status === 'FAILED' ? 500 : 200;
  return NextResponse.json(outcome, { status });
}

/** GET reports what the job would do, without doing it. */
export async function GET(request: Request, context: { params: Promise<{ job: string }> }) {
  if (!authorised(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { job } = await context.params;
  return NextResponse.json({ job, known: JOB_NAMES, hint: 'POST to run' });
}
