import { HttpClient } from '../http';
import { ProviderError } from '../types';
import type { QuotaPolicy } from '../quota';

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
 * API-Football signals failures inside a 200 response — `errors` becomes a
 * non-empty object while the status code stays OK. Treating that as success is
 * how you end up storing an empty bulletin and calling it "no matches today".
 */
function assertNoApiErrors(envelope: ApiFootballEnvelope<unknown>, endpoint: string): void {
  const { errors } = envelope;
  const hasErrors = Array.isArray(errors)
    ? errors.length > 0
    : typeof errors === 'object' && errors !== null && Object.keys(errors).length > 0;

  if (hasErrors) {
    throw new ProviderError(`API-Football error: ${JSON.stringify(errors)}`, {
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
