export type QuotaWindow = 'day' | 'month';

export interface QuotaPolicy {
  provider: string;
  window: QuotaWindow;
  budget: number;
  /**
   * Fraction of the budget reserved for interactive/settlement work. Bulk
   * backfills stop at this line so a result sync can always get through.
   */
  reserveRatio?: number;
}

export interface QuotaState {
  provider: string;
  window: QuotaWindow;
  budget: number;
  used: number;
  remaining: number;
  windowStart: Date;
  windowEnd: Date;
}

export function windowBounds(window: QuotaWindow, now = new Date()): { start: Date; end: Date } {
  if (window === 'day') {
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0),
    );
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    return { start, end };
  }
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0));
  return { start, end };
}

/**
 * Budget state is owned by `quota-manager`.
 *
 * This module keeps the policy types and the window arithmetic; the state
 * itself moved because it had to become durable. What used to live here read
 * the request log, trusted the provider's `remaining` header over it, and — on
 * a reading of zero older than ten minutes — allowed thirty calls through to
 * "break the deadlock". Against a provider that answers an exhausted account
 * with HTTP 200 and a header still reporting 99 remaining, that was not a
 * guard at all: it was a loop, and it burned 391 requests against a budget of
 * 100 in a single day.
 */
export {
  assertQuotaAvailable,
  clearQuotaExhaustion,
  getQuotaSnapshot,
  markQuotaExhausted,
  probeIsDue,
  recordEndpointUsage,
  type QuotaGateOptions,
  type QuotaSnapshot,
} from './quota-manager';

import { getQuotaSnapshot } from './quota-manager';

/** Backwards-compatible view for the admin monitor and health endpoint. */
export async function getQuotaState(policy: QuotaPolicy, now = new Date()): Promise<QuotaState> {
  const snapshot = await getQuotaSnapshot(policy, now);
  return {
    provider: snapshot.provider,
    window: snapshot.window,
    budget: snapshot.budget,
    used: snapshot.used,
    remaining: snapshot.remaining,
    windowStart: snapshot.windowStart,
    windowEnd: snapshot.windowEnd,
  };
}
