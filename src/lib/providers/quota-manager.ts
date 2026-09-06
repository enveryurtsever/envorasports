import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { QuotaExceededError } from './types';
import { windowBounds, type QuotaPolicy, type QuotaWindow } from './quota';

const log = createLogger('provider:quota');

/**
 * The provider budget, held as durable state rather than recomputed per call.
 *
 * What made the old guard fail was not arithmetic, it was trust. API-Football
 * answers an exhausted account with **HTTP 200**, an empty `response`, an
 * `errors.requests` string saying the daily limit is reached — and a
 * `x-ratelimit-requests-remaining` header still reporting 99. The guard read
 * the header, believed 99 calls were available, and let every job through;
 * each call came back empty and was logged as a success, so the counter never
 * moved either. That is how a 100/day budget produced 391 requests in a day,
 * priced nothing, and printed the same error every ten minutes all night.
 *
 * So: the provider's own word that it is spent outranks any header, that word
 * is written down, and it stands until the provider's window actually rolls
 * over. Until then no request is sent at all — with one exception, below.
 */

/**
 * A single probe, not a burst.
 *
 * The provider's daily window resets on its own schedule, which is not our UTC
 * midnight, and the only way to learn that it has reset is to ask. The previous
 * code allowed thirty calls through on a stale reading, every ten minutes,
 * which is indistinguishable from having no guard. One probe per interval is
 * enough to detect a reset and costs nothing when the answer is still "spent" —
 * an exhausted account is not charged for being told so.
 */
const DEFAULT_PROBE_INTERVAL_MINUTES = 30;

export interface QuotaSnapshot {
  provider: string;
  window: QuotaWindow;
  budget: number;
  used: number;
  remaining: number;
  windowStart: Date;
  windowEnd: Date;
  /** The provider itself refused work for budget reasons. */
  exhausted: boolean;
  exhaustedAt: Date | null;
  /** When the hold lifts. Null when not exhausted. */
  resetAt: Date | null;
  /** Credits spent per endpoint in this window, for blaming the right job. */
  endpointUsage: Record<string, number>;
}

function emptyUsage(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

/**
 * When a provider that has just declared itself spent will be worth asking
 * again.
 *
 * API-Football's day does not align with ours, so the honest answer is "we do
 * not know" — the next UTC midnight is the upper bound, and the probe interval
 * is what actually discovers the reset.
 */
function defaultResetAt(window: QuotaWindow, now: Date): Date {
  return windowBounds(window, now).end;
}

/** Reads the durable state, rolling the window over when it has expired. */
export async function getQuotaSnapshot(
  policy: QuotaPolicy,
  now = new Date(),
): Promise<QuotaSnapshot> {
  const { start, end } = windowBounds(policy.window, now);

  const [row, aggregate] = await Promise.all([
    prisma.providerQuotaState.findUnique({ where: { provider: policy.provider } }),
    // Credits, not rows: one Odds API call with three markets costs three.
    // Failed attempts count too — most plans charge for them.
    prisma.providerRequestLog.aggregate({
      where: { provider: policy.provider, createdAt: { gte: start, lt: end } },
      _sum: { cost: true },
    }),
  ]);

  const counted = aggregate._sum.cost ?? 0;
  const windowRolled = row !== null && row.windowStart.getTime() !== start.getTime();

  // A hold expires only when its own reset time passes, or when our accounting
  // window rolls. Staleness alone never lifts it.
  const holdExpired =
    row?.resetAt !== null && row?.resetAt !== undefined && row.resetAt.getTime() <= now.getTime();
  const exhausted = row?.exhausted === true && !windowRolled && !holdExpired;

  const remaining = exhausted ? 0 : Math.max(0, policy.budget - counted);

  return {
    provider: policy.provider,
    window: policy.window,
    budget: policy.budget,
    used: Math.min(policy.budget, counted),
    remaining,
    windowStart: start,
    windowEnd: end,
    exhausted,
    exhaustedAt: exhausted ? (row?.exhaustedAt ?? null) : null,
    resetAt: exhausted ? (row?.resetAt ?? null) : null,
    endpointUsage: windowRolled ? {} : emptyUsage(row?.endpointUsage),
  };
}

/**
 * Records that the provider refused work because the budget is spent.
 *
 * Called from the HTTP layer the moment a response says so, whatever shape that
 * answer arrives in — a 429, or a 200 carrying an error envelope.
 */
export async function markQuotaExhausted(
  policy: QuotaPolicy,
  reason: string,
  now = new Date(),
): Promise<void> {
  const { start, end } = windowBounds(policy.window, now);
  const resetAt = defaultResetAt(policy.window, now);

  await prisma.providerQuotaState.upsert({
    where: { provider: policy.provider },
    update: {
      budget: policy.budget,
      used: policy.budget,
      remaining: 0,
      windowStart: start,
      windowEnd: end,
      exhausted: true,
      exhaustedAt: now,
      resetAt,
    },
    create: {
      provider: policy.provider,
      budget: policy.budget,
      used: policy.budget,
      remaining: 0,
      windowStart: start,
      windowEnd: end,
      exhausted: true,
      exhaustedAt: now,
      resetAt,
    },
  });

  log.warn('provider budget exhausted, holding until reset', {
    provider: policy.provider,
    reason,
    resetAt: resetAt.toISOString(),
  });
}

/** Clears the hold after a call proves the provider is serving again. */
export async function clearQuotaExhaustion(
  policy: QuotaPolicy,
  now = new Date(),
): Promise<void> {
  const row = await prisma.providerQuotaState.findUnique({
    where: { provider: policy.provider },
  });
  if (!row?.exhausted) return;

  const { start, end } = windowBounds(policy.window, now);
  await prisma.providerQuotaState.update({
    where: { provider: policy.provider },
    data: {
      exhausted: false,
      exhaustedAt: null,
      resetAt: null,
      windowStart: start,
      windowEnd: end,
    },
  });
  log.info('provider budget hold cleared', { provider: policy.provider });
}

/** Attributes spend to the endpoint that caused it. */
export async function recordEndpointUsage(
  policy: QuotaPolicy,
  endpoint: string,
  cost: number,
  now = new Date(),
): Promise<void> {
  const { start, end } = windowBounds(policy.window, now);
  const row = await prisma.providerQuotaState.findUnique({
    where: { provider: policy.provider },
  });

  const rolled = row === null || row.windowStart.getTime() !== start.getTime();
  const usage = rolled ? {} : emptyUsage(row?.endpointUsage);
  usage[endpoint] = (usage[endpoint] ?? 0) + cost;

  await prisma.providerQuotaState.upsert({
    where: { provider: policy.provider },
    update: {
      endpointUsage: usage,
      windowStart: start,
      windowEnd: end,
      budget: policy.budget,
      // A window that has rolled cannot still be exhausted.
      ...(rolled ? { exhausted: false, exhaustedAt: null, resetAt: null } : {}),
    },
    create: {
      provider: policy.provider,
      budget: policy.budget,
      windowStart: start,
      windowEnd: end,
      endpointUsage: usage,
    },
  });
}

export interface QuotaGateOptions {
  cost?: number;
  /** Low-priority work stops before eating the reserve kept for settlement. */
  respectReserve?: boolean;
  /**
   * Allows exactly one call through while the provider is on hold, to find out
   * whether its window has reset. Only the odds/fixture pollers set this.
   */
  allowProbe?: boolean;
  probeIntervalMinutes?: number;
}

/** True when enough time has passed to spend one call finding out. */
export function probeIsDue(
  snapshot: QuotaSnapshot,
  now: Date,
  intervalMinutes = DEFAULT_PROBE_INTERVAL_MINUTES,
): boolean {
  if (!snapshot.exhausted || !snapshot.exhaustedAt) return false;
  return now.getTime() - snapshot.exhaustedAt.getTime() >= intervalMinutes * 60_000;
}

/**
 * The single gate every outbound call passes through.
 *
 * Throws rather than returning a flag so a caller cannot forget to check it;
 * every job already treats QuotaExceededError as "skip, do not retry".
 */
export async function assertQuotaAvailable(
  policy: QuotaPolicy,
  options: QuotaGateOptions = {},
  now = new Date(),
): Promise<QuotaSnapshot> {
  const cost = options.cost ?? 1;
  const snapshot = await getQuotaSnapshot(policy, now);

  if (snapshot.exhausted) {
    const probeAllowed =
      options.allowProbe === true &&
      probeIsDue(snapshot, now, options.probeIntervalMinutes ?? DEFAULT_PROBE_INTERVAL_MINUTES);

    if (!probeAllowed) {
      throw new QuotaExceededError(policy.provider, snapshot.used, policy.budget);
    }
    // One call through, to learn whether the provider's window has rolled.
    // Re-stamping the hold is what keeps it to one per interval.
    await prisma.providerQuotaState.update({
      where: { provider: policy.provider },
      data: { exhaustedAt: now },
    });
    return snapshot;
  }

  const reserve = options.respectReserve
    ? Math.ceil(policy.budget * (policy.reserveRatio ?? 0.2))
    : 0;

  if (snapshot.remaining - reserve < cost) {
    throw new QuotaExceededError(policy.provider, snapshot.used, policy.budget);
  }
  return snapshot;
}
