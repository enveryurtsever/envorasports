import { describe, expect, it, beforeEach } from 'vitest';
import { interpretApiFootballBody } from './api-football/envelope';
import { resetPacing } from './http';

/**
 * The per-minute allowance belongs to the API key.
 *
 * Two clients over one key each paced themselves at ten a minute, which put
 * twenty a minute on a key that allows ten; the provider then answered 200 with
 * a rate-limit envelope and a whole date's results were dropped on the floor.
 */
describe('api-football envelope', () => {
  beforeEach(() => resetPacing());

  it('reads a spent minute as retryable, not as a spent day', () => {
    const verdict = interpretApiFootballBody({
      errors: { rateLimit: 'Too many requests. Your rate limit is 10 requests per minute.' },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.rateLimited).toBe(true);
    // The decisive part: a spent minute must never put the day on hold.
    expect(verdict.budgetExhausted).toBeFalsy();
  });

  it('still reads a spent day as a spent day', () => {
    const verdict = interpretApiFootballBody({
      errors: { requests: 'You have reached the request limit for the day' },
    });

    expect(verdict.budgetExhausted).toBe(true);
    expect(verdict.rateLimited).toBeFalsy();
  });

  it('leaves a clean envelope alone', () => {
    expect(interpretApiFootballBody({ errors: [], response: [] }).ok).toBe(true);
  });
});
