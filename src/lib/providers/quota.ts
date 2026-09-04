import { prisma } from '@/lib/db/prisma';
import { QuotaExceededError } from './types';

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
 * Counts real outbound calls from `provider_request_logs`, so the budget
 * survives restarts and is shared across every worker and web process.
 *
 * With 100 requests/day on the football side, an accidental loop would burn a
 * whole day of data in seconds. This is the thing standing in the way.
 */
export async function getQuotaState(policy: QuotaPolicy, now = new Date()): Promise<QuotaState> {
  const { start, end } = windowBounds(policy.window, now);
  // Sum credits, not rows: one Odds API call with 3 markets costs 3 credits.
  const aggregate = await prisma.providerRequestLog.aggregate({
    where: { provider: policy.provider, createdAt: { gte: start, lt: end } },
    _sum: { cost: true },
  });
  const used = aggregate._sum.cost ?? 0;
  return {
    provider: policy.provider,
    window: policy.window,
    budget: policy.budget,
    used,
    remaining: Math.max(0, policy.budget - used),
    windowStart: start,
    windowEnd: end,
  };
}

export interface QuotaCheckOptions {
  /** Number of credits this call will consume. Defaults to 1. */
  cost?: number;
  /** Set for low-priority work so it stops before the reserve is touched. */
  respectReserve?: boolean;
}

export async function assertQuotaAvailable(
  policy: QuotaPolicy,
  options: QuotaCheckOptions = {},
): Promise<QuotaState> {
  const cost = options.cost ?? 1;
  const state = await getQuotaState(policy);

  const reserve = options.respectReserve
    ? Math.ceil(policy.budget * (policy.reserveRatio ?? 0.2))
    : 0;
  const usable = state.remaining - reserve;

  if (usable < cost) {
    throw new QuotaExceededError(policy.provider, state.used, policy.budget);
  }
  return state;
}
