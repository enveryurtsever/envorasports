import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { QuotaExceededError, ProviderError } from '@/lib/providers/types';
import { DEFAULT_LOCK_TTL_MS, acquireLock, releaseLock, type HeldLock } from './lock';

const log = createLogger('jobs:runner');

export interface JobContext {
  jobName: string;
  runId: string;
  lock: HeldLock;
  logger: ReturnType<typeof createLogger>;
  /** Long jobs call this to keep the lock alive. */
  heartbeat: () => Promise<void>;
}

export interface JobResult {
  itemsProcessed?: number;
  itemsFailed?: number;
  metadata?: Record<string, unknown>;
}

export type JobOutcome =
  | { status: 'SUCCESS'; runId: string; itemsProcessed: number; itemsFailed: number; metadata: Record<string, unknown> }
  | { status: 'SKIPPED'; reason: string; runId: string | null }
  | { status: 'FAILED'; runId: string; error: string; retryable: boolean };

export interface RunJobOptions {
  jobName: string;
  /**
   * Idempotency key. A run that already succeeded under the same key is
   * skipped, so re-invoking a cron endpoint cannot duplicate work (§38).
   */
  runKey?: string;
  lockKey?: string;
  lockTtlMs?: number;
  /** Treat an in-flight run older than this as abandoned. */
  staleAfterMs?: number;
  handler: (context: JobContext) => Promise<JobResult>;
}

/**
 * One execution path for every scheduled job: idempotency, single-writer
 * locking, JobRun bookkeeping and error capture (§38).
 *
 * A job never throws at its caller. A provider outage is a FAILED outcome with
 * the reason recorded — the next tick retries, and the other jobs keep running.
 */
export async function runJob(options: RunJobOptions): Promise<JobOutcome> {
  const { jobName, runKey } = options;
  const lockKey = options.lockKey ?? jobName;
  const staleAfterMs = options.staleAfterMs ?? 30 * 60 * 1000;

  if (runKey) {
    const existing = await prisma.jobRun.findUnique({ where: { runKey } });
    if (existing?.status === 'SUCCESS') {
      return { status: 'SKIPPED', reason: 'already_completed', runId: existing.id };
    }
    if (
      existing?.status === 'RUNNING' &&
      existing.startedAt &&
      Date.now() - existing.startedAt.getTime() < staleAfterMs
    ) {
      return { status: 'SKIPPED', reason: 'already_running', runId: existing.id };
    }
  }

  const lock = await acquireLock(lockKey, options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS);
  if (!lock) {
    return { status: 'SKIPPED', reason: 'lock_unavailable', runId: null };
  }

  const startedAt = new Date();
  // Upsert rather than create: a previously failed run reuses its row and key.
  const run = runKey
    ? await prisma.jobRun.upsert({
        where: { runKey },
        create: { jobName, runKey, status: 'RUNNING', startedAt },
        update: { status: 'RUNNING', startedAt, finishedAt: null, error: null },
      })
    : await prisma.jobRun.create({ data: { jobName, status: 'RUNNING', startedAt } });

  const logger = log.child(jobName);

  try {
    const result = await options.handler({
      jobName,
      runId: run.id,
      lock,
      logger,
      heartbeat: async () => {
        await prisma.jobLock
          .updateMany({
            where: { key: lock.key, ownerId: lock.ownerId },
            data: { expiresAt: new Date(Date.now() + (options.lockTtlMs ?? DEFAULT_LOCK_TTL_MS)) },
          })
          .catch(() => undefined);
      },
    });

    const itemsProcessed = result.itemsProcessed ?? 0;
    const itemsFailed = result.itemsFailed ?? 0;
    const metadata = result.metadata ?? {};

    await prisma.jobRun.update({
      where: { id: run.id },
      data: {
        status: 'SUCCESS',
        finishedAt: new Date(),
        itemsProcessed,
        itemsFailed,
        metadata: metadata as never,
      },
    });

    logger.info('job completed', { itemsProcessed, itemsFailed, ...metadata });
    return { status: 'SUCCESS', runId: run.id, itemsProcessed, itemsFailed, metadata };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    // Running out of quota is an expected, non-alarming stop. It is recorded as
    // SKIPPED so it does not pollute the failure monitor (§39).
    if (error instanceof QuotaExceededError) {
      await prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'SKIPPED', finishedAt: new Date(), error: message },
      });
      logger.warn('job stopped on quota', { error: message });
      return { status: 'SKIPPED', reason: 'quota_exhausted', runId: run.id };
    }

    await prisma.jobRun.update({
      where: { id: run.id },
      data: { status: 'FAILED', finishedAt: new Date(), error: message.slice(0, 2000) },
    });

    logger.error('job failed', { error: message });
    return {
      status: 'FAILED',
      runId: run.id,
      error: message,
      retryable: error instanceof ProviderError ? error.options.retryable : true,
    };
  } finally {
    await releaseLock(lock).catch(() => undefined);
  }
}

/** Stable idempotency key: one successful run per job per logical slot. */
export function runKeyFor(jobName: string, slot: string): string {
  return `${jobName}:${slot}`;
}
