import { prisma } from '@/lib/db/prisma';
import { createLogger } from '@/lib/logging/logger';
import { ProviderError } from './types';
import { assertQuotaAvailable, type QuotaPolicy } from './quota';

const log = createLogger('provider:http');

export interface HttpClientOptions {
  provider: string;
  baseUrl: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxRetries?: number;
  quota?: QuotaPolicy;
}

export interface RequestOptions {
  /** Path appended to baseUrl, e.g. "/fixtures". */
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  /** Credits this call consumes against the quota. */
  cost?: number;
  /** Low-priority calls stop before eating into the reserve. */
  respectReserve?: boolean;
  signal?: AbortSignal;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  constructor(private readonly options: HttpClientOptions) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 3;
  }

  async get<T>(request: RequestOptions): Promise<T> {
    if (this.options.quota) {
      await assertQuotaAvailable(this.options.quota, {
        cost: request.cost ?? 1,
        respectReserve: request.respectReserve,
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
        const reportedRemaining = Number(
          response.headers.get('x-requests-remaining') ??
            response.headers.get('x-ratelimit-requests-remaining') ??
            response.headers.get('x-ratelimit-remaining'),
        );
        const quotaRemaining = Number.isFinite(reportedRemaining) ? reportedRemaining : null;
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

        await this.logRequest({
          endpoint: request.path,
          statusCode: response.status,
          durationMs,
          success: true,
          attempt,
          cost: request.cost ?? 1,
          quotaRemaining,
        });

        return (await response.json()) as T;
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
