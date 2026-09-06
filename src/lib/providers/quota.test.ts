import { describe, expect, it } from 'vitest';
import { interpretApiFootballBody } from './api-football/envelope';
import { probeIsDue, type QuotaSnapshot } from './quota-manager';
import { windowBounds } from './quota';

/**
 * These two behaviours are what let a 100/day budget spend 391 requests.
 * A regression here is not cosmetic, so they are pinned.
 */

describe('interpretApiFootballBody', () => {
  it('accepts a healthy envelope', () => {
    expect(interpretApiFootballBody({ errors: [], results: 3, response: [1, 2, 3] })).toEqual({
      ok: true,
    });
  });

  it('treats an empty errors object as success', () => {
    expect(interpretApiFootballBody({ errors: {}, response: [] }).ok).toBe(true);
  });

  it('rejects a 200 that carries an error envelope', () => {
    const verdict = interpretApiFootballBody({
      errors: { bug: 'Report this to support' },
      response: [],
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.budgetExhausted).toBe(false);
  });

  it('recognises the daily-limit message as budget exhaustion', () => {
    // The exact body a spent account returns, alongside HTTP 200 and a
    // x-ratelimit-requests-remaining header still reporting 99.
    const verdict = interpretApiFootballBody({
      errors: {
        requests:
          'You have reached the request limit for the day, Go to https://dashboard.api-football.com to upgrade your plan.',
      },
      results: 0,
      response: [],
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.budgetExhausted).toBe(true);
  });

  it('handles the array form of errors', () => {
    expect(interpretApiFootballBody({ errors: ['token invalid'] }).ok).toBe(false);
  });

  it('says nothing about a body it cannot read', () => {
    expect(interpretApiFootballBody(null).ok).toBe(true);
    expect(interpretApiFootballBody('nonsense').ok).toBe(true);
  });
});

function snapshot(overrides: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
  const now = new Date('2026-09-06T04:00:00Z');
  return {
    provider: 'api-football',
    window: 'day',
    budget: 100,
    used: 100,
    remaining: 0,
    windowStart: windowBounds('day', now).start,
    windowEnd: windowBounds('day', now).end,
    exhausted: true,
    exhaustedAt: now,
    resetAt: windowBounds('day', now).end,
    endpointUsage: {},
    ...overrides,
  };
}

describe('probeIsDue', () => {
  it('does not probe a provider that is not on hold', () => {
    expect(probeIsDue(snapshot({ exhausted: false }), new Date('2026-09-06T23:00:00Z'))).toBe(false);
  });

  it('holds for the whole interval rather than letting a burst through', () => {
    // The old guard released thirty calls every ten minutes here.
    const justAfter = new Date('2026-09-06T04:09:00Z');
    expect(probeIsDue(snapshot(), justAfter, 30)).toBe(false);
  });

  it('allows exactly one probe once the interval has passed', () => {
    const later = new Date('2026-09-06T04:31:00Z');
    expect(probeIsDue(snapshot(), later, 30)).toBe(true);
  });
});
