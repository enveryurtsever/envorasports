import { HttpClient } from '../http';
import { ProviderError } from '../types';
import type { QuotaPolicy } from '../quota';
import { interpretApiFootballBody } from './envelope';

export const API_FOOTBALL = 'api-football';

/** Envelope every v3 endpoint wraps its payload in. */
export interface ApiFootballEnvelope<T> {
  get: string;
  parameters: unknown;
  errors: unknown;
  results: number;
  paging: { current: number; total: number };
  response: T;
}

/**
 * Second line of defence.
 *
 * The HTTP client now reads the same envelope and throws before this is
 * reached, which is what makes the check apply to *every* adapter rather than
 * the ones that remembered to call it. This stays for direct callers and as a
 * guard against a client constructed without the interpreter.
 */
function assertNoApiErrors(envelope: ApiFootballEnvelope<unknown>, endpoint: string): void {
  const verdict = interpretApiFootballBody(envelope);
  if (!verdict.ok) {
    throw new ProviderError(`API-Football error: ${verdict.message}`, {
      provider: API_FOOTBALL,
      endpoint,
      retryable: false,
    });
  }
}

export function createApiFootballClient(config: {
  apiKey: string;
  baseUrl: string;
  quota: QuotaPolicy;
}): {
  fetch<T>(path: string, query?: Record<string, string | number | boolean | undefined>, options?: { respectReserve?: boolean }): Promise<T>;
} {
  const http = new HttpClient({
    provider: API_FOOTBALL,
    baseUrl: config.baseUrl,
    headers: { 'x-apisports-key': config.apiKey },
    // Free plan: ten a minute. Paced, not discovered by 429.
    requestsPerMinute: 10,
    timeoutMs: 20_000,
    maxRetries: 3,
    quota: config.quota,
    interpretBody: interpretApiFootballBody,
  });

  return {
    async fetch<T>(
      path: string,
      query?: Record<string, string | number | boolean | undefined>,
      options?: { respectReserve?: boolean },
    ): Promise<T> {
      const envelope = await http.get<ApiFootballEnvelope<T>>({
        path,
        query,
        respectReserve: options?.respectReserve,
      });
      assertNoApiErrors(envelope, path);
      return envelope.response;
    },
  };
}
