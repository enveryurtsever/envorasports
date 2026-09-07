import type { BodyVerdict } from '../http';

/**
 * Reading API-Football's envelope honestly.
 *
 * Every v3 endpoint answers 200 and puts failures in `errors`, which is `[]`
 * when all is well and an object of `{ field: explanation }` when it is not.
 * An exhausted daily budget arrives exactly this way:
 *
 *   HTTP 200
 *   { "errors": { "requests": "You have reached the request limit for the day…" },
 *     "results": 0, "response": [] }
 *   x-ratelimit-requests-remaining: 99
 *
 * Both the status code and the remaining-requests header say everything is
 * fine. Only the body tells the truth, so the body is what decides.
 */

/**
 * Phrases the free plan uses when the *per-minute* burst is gone.
 *
 * A different thing entirely from a spent day: the allowance is intact and the
 * only correct response is to wait a moment and ask again. Reading it as a
 * plain failure cost a whole date's results every time two jobs happened to
 * tick in the same minute.
 */
const RATE_LIMIT_PATTERNS = [/rate limit is \d+ requests per minute/i, /too many requests/i];

/** Phrases API-Football uses when the daily allowance is gone. */
const BUDGET_PATTERNS = [
  /request limit for the day/i,
  /reached the request limit/i,
  /upgrade your plan/i,
];

export function interpretApiFootballBody(body: unknown): BodyVerdict {
  if (!body || typeof body !== 'object') return { ok: true };

  const errors = (body as { errors?: unknown }).errors;
  const entries = Array.isArray(errors)
    ? errors.map(String)
    : typeof errors === 'object' && errors !== null
      ? Object.entries(errors as Record<string, unknown>).map(([key, value]) => `${key}: ${value}`)
      : [];

  if (entries.length === 0) return { ok: true };

  const message = entries.join('; ');
  const budgetExhausted = BUDGET_PATTERNS.some((pattern) => pattern.test(message));

  return {
    ok: false,
    message,
    budgetExhausted,
    // A spent day wins the tie: it is the more restrictive reading, and the
    // two phrasings overlap ("reached the request limit").
    rateLimited: !budgetExhausted && RATE_LIMIT_PATTERNS.some((p) => p.test(message)),
  };
}
