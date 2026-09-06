import { describe, expect, it } from 'vitest';
import { interpretApiFootballBody } from './api-football/envelope';
import { probeIsDue } from './quota-manager';

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

describe('probeIsDue', () => {
  const spentAt = new Date('2026-09-06T04:00:00Z');

  it('holds for the whole interval rather than letting a burst through', () => {
    // The original guard released thirty calls every ten minutes here.
    expect(probeIsDue(spentAt, new Date('2026-09-06T04:09:00Z'), 30)).toBe(false);
  });

  it('allows exactly one probe once the interval has passed', () => {
    expect(probeIsDue(spentAt, new Date('2026-09-06T04:31:00Z'), 30)).toBe(true);
  });

  it('probes immediately when nothing is known about the last call', () => {
    // A closed gate with no record behind it must not stay closed forever.
    expect(probeIsDue(null, new Date('2026-09-06T04:00:00Z'), 30)).toBe(true);
  });

  it('reopens after a long silence, which is what broke a whole day', () => {
    // 04:52 spent, no call attempted since; by 23:00 the provider's own window
    // has almost certainly rolled and nothing had asked.
    expect(probeIsDue(new Date('2026-09-06T04:52:00Z'), new Date('2026-09-06T23:00:00Z'), 30)).toBe(
      true,
    );
  });
});
