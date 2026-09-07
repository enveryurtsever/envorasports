import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { ProviderError } from './types';
import type { QuotaPolicy } from './quota';
import {
  assertQuotaAvailable,
  clearQuotaExhaustion,
  markQuotaExhausted,
  recordEndpointUsage,
} from './quota-manager';

const log = createLogger('provider:http');

/**
 * What a provider's response body actually says, once its own envelope is read.
 *
 * A 200 is not proof of success. API-Football answers an exhausted account with
 * HTTP 200, an empty payload and `errors.requests` explaining why — while still
 * reporting a healthy `x-ratelimit-requests-remaining`. Adapters declare how to
 * read their envelope here so that answer is understood in one place instead of
 * being mistaken for an empty result in several.
 */
export interface BodyVerdict {
  ok: boolean;
  message?: string;
  /** The provider is refusing work because the budget is spent. */
  budgetExhausted?: boolean;
  /**
   * The provider is refusing work for this minute only.
   *
   * Retryable, and never evidence about the day's allowance — the caller must
   * be able to tell "wait ten seconds" apart from "come back tomorrow".
   */
  rateLimited?: boolean;
}

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  /** Provider's per-minute cap, paced client-side rather than discovered by 429. */
  requestsPerMinute?: number;
  /**
   * Which allowance this client's pacing draws on. Defaults to `provider`.
   *
   * The cap belongs to the API key, not to the object holding it. Fixtures and
   * odds are two clients over one API-Football key, and each pacing itself at
   * ten a minute put twenty a minute on a key that allows ten.
   */
  paceKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  quota?: QuotaPolicy;
  /** Reads the provider's own error envelope out of an otherwise-OK response. */
  interpretBody?: (body: unknown) => BodyVerdict;
}

export interface RequestOptions {
  /** Path appended to baseUrl, e.g. "/fixtures". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Credits this call consumes against the quota. */
  cost?: number;
  /** Low-priority calls stop before eating into the reserve. */
  respectReserve?: boolean;
  /**
   * Lets this call through while the provider is on hold, to discover whether
   * its window has reset. At most one such call per probe interval.
   */
  allowProbe?: boolean;
  /**
   * What the call was for, recorded alongside its cost.
   *
   * Cost counted on its own says nothing: two credits for a whole competition
   * and two for a single fixture are the same number and a twenty-fold
   * difference in value. This is what lets the two be told apart afterwards.
   */
  sportKey?: string;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * What a response actually brought back, for judging cost against yield.
 *
 * Shape-sniffed rather than typed per provider: this only ever produces
 * counters for a log, and a body it does not recognise simply reports nothing.
 */
function describeYield(body: unknown): {
  eventsReturned?: number;
  bookmakerCount?: number;
  marketCount?: number;
} {
  const events = Array.isArray(body) ? body : null;
  if (!events) return {};

  let bookmakerCount = 0;
  const markets = new Set<string>();
  for (const event of events) {
    const books = (event as { bookmakers?: unknown }).bookmakers;
    if (!Array.isArray(books)) continue;
    bookmakerCount += books.length;
    for (const book of books) {
      const list = (book as { markets?: unknown }).markets;
      if (!Array.isArray(list)) continue;
      for (const market of list) {
        const key = (market as { key?: unknown }).key;
        if (typeof key === 'string') markets.add(key);
      }
    }
  }

  return { eventsReturned: events.length, bookmakerCount, marketCount: markets.size };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Request timestamps and the reservation queue, per allowance rather than per
 * client — see `HttpClientOptions.paceKey`.
 */
const paceWindows = new Map<string, number[]>();
const paceQueues = new Map<string, Promise<void>>();

async function reserveSlot(key: string, limit: number): Promise<void> {
  let window = paceWindows.get(key);
  if (!window) {
    window = [];
    paceWindows.set(key, window);
  }

  for (;;) {
    const cutoff = Date.now() - 60_000;
    while (window.length > 0 && (window[0] as number) <= cutoff) window.shift();
    if (window.length < limit) break;

    const oldest = window[0] as number;
    await new Promise((resolve) => setTimeout(resolve, Math.max(250, oldest - cutoff)));
  }

  window.push(Date.now());
}

/** Test seam: forget what has been spent so a suite starts from a clean minute. */
export function resetPacing(): void {
  paceWindows.clear();
  paceQueues.clear();
}

/**
 * Full jitter exponential backoff. Without jitter, every worker that hit a 429
 * retries at the same instant and hits it again.
 */
function backoffDelay(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && Number.isFinite(retryAfterSeconds)) {
    return Math.min(retryAfterSeconds * 1000, 60_000);
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return Math.random() * base;
}

/**
 * One HTTP path for every provider: timeout, bounded retries, quota
 * enforcement and a persisted request log. A provider outage produces a
 * ProviderError, never an unhandled rejection that kills the job (§43).
 */
export class HttpClient {
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  /** Latest credit balance the provider reported, if it reports one at all. */
  private lastQuotaRemaining: number | null = null;
  /** The allowance this client paces against, shared by every client on it. */
  private get paceKey(): string {
    return this.options.paceKey ?? this.options.provider;
  }

  constructor(private readonly options: HttpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  /**
   * Waits until the next request fits inside the per-minute allowance.
   *
   * The daily budget is not the only limit: API-Football's free plan also caps
   * requests per minute, and exceeding it returns 429 with headers that read
   * exactly like daily exhaustion. Twenty fixtures fetched back to back tripped
   * it every time, and the whole day's work then looked like a spent budget.
   * Pacing removes the confusion at its source — the calls simply wait their
   * turn instead of being refused and misdiagnosed.
   */
  private async awaitPace(): Promise<void> {
    const limit = this.options.requestsPerMinute;
    if (!limit) return;

    const key = this.paceKey;
    // Reserving a slot has to be one indivisible step across every client on
    // this key: two callers that both read the window before either writes to
    // it will both decide there is room, which is the race the shared window
    // exists to close.
    const previous = paceQueues.get(key) ?? Promise.resolve();
    const reservation = previous.then(() => reserveSlot(key, limit));
    paceQueues.set(
      key,
      reservation.catch(() => undefined),
    );
    await reservation;
  }

  async get<T>(request: RequestOptions): Promise<T> {
    await this.awaitPace();

    if (this.options.quota) {
      await assertQuotaAvailable(this.options.quota, {
        cost: request.cost ?? 1,
        respectReserve: request.respectReserve,
        allowProbe: request.allowProbe,
      });
    }

    const url = this.buildUrl(request);
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      // Caller cancellation must also abort the in-flight request.
      const onAbort = () => controller.abort();
      request.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const response = await fetch(url, {
          method: 'GET',
          headers: { accept: 'application/json', ...(this.options.headers ?? {}) },
          signal: controller.signal,
          cache: 'no-store',
        });

        const durationMs = Date.now() - startedAt;
        /**
         * Providers that meter credits report the truth in a header; prefer it
         * over our own arithmetic when present.
         *
         * The header has to be the *budget* one. API-Football sends both:
         * `x-ratelimit-requests-remaining` is the daily allowance, while
         * `x-ratelimit-remaining` is the per-minute burst limit — ten on the
         * free plan. Reading the latter as the budget meant ten quick calls
         * recorded "0 remaining for the day" and the guard then refused
         * everything, with the provider's own dashboard showing 41 still
         * available. Per-minute exhaustion is a reason to wait a moment, never
         * a reason to stop for the day.
         */
        // Read as a string first: Number(null) is 0, so an absent header was
        // being recorded as "nothing left" rather than "not reported", which is
        // how a working provider came to look exhausted.
        const remainingHeader =
          response.headers.get('x-requests-remaining') ??
          response.headers.get('x-ratelimit-requests-remaining') ??
          response.headers.get('x-ratelimit-remaining');
        const reportedRemaining =
          remainingHeader === null || remainingHeader.trim() === ''
            ? Number.NaN
            : Number(remainingHeader);
        // A 429 reports the exhausted *window*, which for API-Football is the
        // per-minute one. Recording it as the daily balance is what convinced
        // the guard the day was spent while the provider still had 31 calls.
        const quotaRemaining =
          response.status !== 429 && Number.isFinite(reportedRemaining) ? reportedRemaining : null;
        if (quotaRemaining !== null) this.lastQuotaRemaining = quotaRemaining;

        if (!response.ok) {
          const retryable = RETRYABLE_STATUS.has(response.status);
          await this.logRequest({
            endpoint: request.path,
            statusCode: response.status,
            durationMs,
            success: false,
            attempt,
            cost: request.cost ?? 1,
            quotaRemaining,
            errorMessage: `HTTP ${response.status}`,
          });

          if (retryable && attempt < this.maxRetries) {
            const retryAfter = Number(response.headers.get('retry-after'));
            await sleep(backoffDelay(attempt, retryAfter));
            continue;
          }

          throw new ProviderError(`${this.options.provider} responded ${response.status}`, {
            provider: this.options.provider,
            endpoint: request.path,
            statusCode: response.status,
            retryable,
          });
        }

        const body = (await response.json()) as T;

        /**
         * A 200 is where the provider's own error envelope lives.
         *
         * Reading it here rather than in each adapter is the whole point: the
         * odds adapter did not read it, so fifty "successful" empty responses
         * a run were recorded as successes while the account was spent. The
         * response headers cannot be trusted in that state either — the same
         * reply carried `x-ratelimit-requests-remaining: 99` — so a body that
         * reports exhaustion discards the header rather than storing it.
         */
        const verdict = this.options.interpretBody?.(body) ?? { ok: true };

        if (!verdict.ok) {
          await this.logRequest({
            endpoint: request.path,
            statusCode: response.status,
            durationMs,
            success: false,
            attempt,
            cost: request.cost ?? 1,
            quotaRemaining: verdict.budgetExhausted ? null : quotaRemaining,
            errorMessage: verdict.message ?? 'provider reported an error',
          });

          /**
           * A spent minute is not a failure, it is a queue.
           *
           * Pacing should keep us clear of it, but a restart empties the
           * window while the provider's own minute keeps running, so the first
           * calls after one can still land on it. Waiting out the minute costs
           * a few seconds; throwing costs a whole date's results.
           */
          if (verdict.rateLimited && attempt < this.maxRetries) {
            if (this.options.quota) await clearQuotaExhaustion(this.options.quota);
            const retryAfter = Number(response.headers.get('retry-after'));
            await sleep(
              Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, 60_000)
                : 15_000,
            );
            await this.awaitPace();
            continue;
          }

          if (this.options.quota) {
            if (verdict.budgetExhausted) {
              this.lastQuotaRemaining = 0;
              await markQuotaExhausted(this.options.quota, verdict.message ?? 'budget exhausted');
            } else {
              /**
               * Any answer that is not a budget refusal proves the budget is
               * fine.
               *
               * A plan restriction — "Free plans do not have access to this
               * date" — is the provider serving us and declining the argument.
               * Treating it as no evidence left a hold in place that had been
               * set at 00:00:19, seconds before the provider's own window
               * rolled, and it would have stood for the whole day.
               */
              await clearQuotaExhaustion(this.options.quota);
            }
          }

          throw new ProviderError(
            `${this.options.provider} error: ${verdict.message ?? 'unknown'}`,
            {
              provider: this.options.provider,
              endpoint: request.path,
              statusCode: response.status,
              // Retrying an exhausted budget is how the loop started. A spent
              // minute is the one refusal that is worth another attempt.
              retryable: verdict.rateLimited === true,
            },
          );
        }

        await this.logRequest({
          endpoint: request.path,
          statusCode: response.status,
          durationMs,
          success: true,
          attempt,
          cost: request.cost ?? 1,
          quotaRemaining,
          sportKey: request.sportKey,
          ...describeYield(body),
        });

        if (this.options.quota) {
          // A real answer proves the provider is serving, so any hold lifts and
          // the spend is attributed to the endpoint that caused it.
          await clearQuotaExhaustion(this.options.quota);
          await recordEndpointUsage(this.options.quota, request.path, request.cost ?? 1);
        }

        return body;
      } catch (error) {
        lastError = error;

        if (error instanceof ProviderError) throw error;

        const aborted = error instanceof Error && error.name === 'AbortError';
        await this.logRequest({
          endpoint: request.path,
          durationMs: Date.now() - startedAt,
          success: false,
          attempt,
          // A failed attempt still burns provider quota on most plans.
          cost: request.cost ?? 1,
          errorMessage: aborted ? 'timeout' : String(error),
        });

        if (attempt < this.maxRetries) {
          await sleep(backoffDelay(attempt));
          continue;
        }
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener('abort', onAbort);
      }
    }

    throw new ProviderError(`${this.options.provider} request failed after ${this.maxRetries} attempts`, {
      provider: this.options.provider,
      endpoint: request.path,
      retryable: true,
      cause: lastError,
    });
  }

  /** Provider-reported remaining credits, for the admin monitor. */
  get reportedQuotaRemaining(): number | null {
    return this.lastQuotaRemaining;
  }

  private buildUrl(request: RequestOptions): string {
    const url = new URL(
      request.path.replace(/^\//, ''),
      this.options.baseUrl.endsWith('/') ? this.options.baseUrl : `${this.options.baseUrl}/`,
    );
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /**
   * Every attempt is recorded — this table is both the quota counter and the
   * admin monitor's source of truth. Logging must never break the caller.
   */
  private async logRequest(entry: {
    endpoint: string;
    statusCode?: number;
    durationMs: number;
    success: boolean;
    attempt: number;
    cost: number;
    quotaRemaining?: number | null;
    errorMessage?: string;
    sportKey?: string;
    eventsReturned?: number;
    bookmakerCount?: number;
    marketCount?: number;
  }): Promise<void> {
    try {
      await prisma.providerRequestLog.create({
        data: {
          provider: this.options.provider,
          endpoint: entry.endpoint,
          statusCode: entry.statusCode ?? null,
          durationMs: entry.durationMs,
          success: entry.success,
          attempt: entry.attempt,
          cost: entry.cost,
          quotaRemaining: entry.quotaRemaining ?? null,
          errorMessage: entry.errorMessage ?? null,
          sportKey: entry.sportKey ?? null,
          eventsReturned: entry.eventsReturned ?? null,
          bookmakerCount: entry.bookmakerCount ?? null,
          marketCount: entry.marketCount ?? null,
        },
      });
    } catch (error) {
      log.warn('failed to persist provider request log', {
        provider: this.options.provider,
        error: String(error),
      });
    }
  }
}
