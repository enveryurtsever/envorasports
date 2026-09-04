import { randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';

const log = createLogger('jobs:lock');

/**
 * Database-backed mutual exclusion (§38).
 *
 * Two workers settling the same coupon at the same time can double-count a
 * payout, so settlement and ingestion take a named lock first. The lock lives
 * in Postgres rather than memory because "two workers" usually means two
 * processes, or a cron overlapping with a manual trigger.
 *
 * Locks carry an expiry so a crashed worker cannot wedge a job forever.
 */

export interface HeldLock {
  key: string;
  ownerId: string;
  expiresAt: Date;
}

export const DEFAULT_LOCK_TTL_MS = 10 * 60 * 1000;

export async function acquireLock(
  key: string,
  ttlMs: number = DEFAULT_LOCK_TTL_MS,
  ownerId: string = randomUUID(),
): Promise<HeldLock | null> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlMs);

  try {
    await prisma.jobLock.create({ data: { key, ownerId, acquiredAt: now, expiresAt } });
    return { key, ownerId, expiresAt };
  } catch {
    // Someone holds it. Steal it only if it has actually expired — this is a
    // single conditional UPDATE, so two workers cannot both win the race.
    const stolen = await prisma.jobLock.updateMany({
      where: { key, expiresAt: { lt: now } },
      data: { ownerId, acquiredAt: now, expiresAt },
    });

    if (stolen.count === 1) {
      log.warn('reclaimed an expired lock', { key, ownerId });
      return { key, ownerId, expiresAt };
    }
    return null;
  }
}

/** Only the holder may release; a stale owner id is a no-op. */
export async function releaseLock(lock: HeldLock): Promise<void> {
  await prisma.jobLock.deleteMany({ where: { key: lock.key, ownerId: lock.ownerId } });
}

/** Extends a lock the caller still holds. Long imports call this periodically. */
export async function renewLock(lock: HeldLock, ttlMs: number = DEFAULT_LOCK_TTL_MS): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlMs);
  const renewed = await prisma.jobLock.updateMany({
    where: { key: lock.key, ownerId: lock.ownerId },
    data: { expiresAt },
  });
  if (renewed.count === 1) {
    lock.expiresAt = expiresAt;
    return true;
  }
  return false;
}

export async function withLock<T>(
  key: string,
  ttlMs: number,
  handler: (lock: HeldLock) => Promise<T>,
): Promise<{ acquired: true; result: T } | { acquired: false; result: null }> {
  const lock = await acquireLock(key, ttlMs);
  if (!lock) return { acquired: false, result: null };

  try {
    return { acquired: true, result: await handler(lock) };
  } finally {
    await releaseLock(lock).catch((error) => {
      // A leaked lock expires on its own; never mask the real error with this.
      log.error('failed to release lock', { key, error: String(error) });
    });
  }
}
