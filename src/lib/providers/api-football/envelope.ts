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
  return {
    ok: false,
    message,
    budgetExhausted: BUDGET_PATTERNS.some((pattern) => pattern.test(message)),
  };
}
