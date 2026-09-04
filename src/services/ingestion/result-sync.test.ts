import { describe, expect, it } from 'vitest';
import { isDueForCheck, pollIntervalMinutes, type ResultSyncIntervals } from './result-sync';

const intervals: ResultSyncIntervals = {
  preKickoffMinutes: 180,
  nearKickoffMinutes: 30,
  liveMinutes: 15,
  postMatchMinutes: 20,
  maxAttempts: 40,
  maxBatchesPerRun: 3,
};

const KICKOFF = new Date('2026-09-11T18:00:00Z');
const minutesFromKickoff = (m: number) => new Date(KICKOFF.getTime() + m * 60_000);

describe('pollIntervalMinutes', () => {
  it('checks rarely long before kickoff', () => {
    expect(pollIntervalMinutes(-600, intervals)).toBe(180);
  });

  it('checks more often as kickoff approaches', () => {
    expect(pollIntervalMinutes(-60, intervals)).toBe(30);
  });

  it('checks frequently while the match is in play', () => {
    expect(pollIntervalMinutes(1, intervals)).toBe(15);
    expect(pollIntervalMinutes(60, intervals)).toBe(15);
    // Half time is inside the live band, not past it.
    expect(pollIntervalMinutes(50, intervals)).toBe(15);
  });

  it('keeps checking past full time until the provider confirms', () => {
    // A match is not finished because 90 minutes elapsed (§31).
    expect(pollIntervalMinutes(115, intervals)).toBe(20);
    expect(pollIntervalMinutes(600, intervals)).toBe(20);
  });

  it('escalates monotonically into the match', () => {
    expect(pollIntervalMinutes(-600, intervals)).toBeGreaterThan(pollIntervalMinutes(-60, intervals));
    expect(pollIntervalMinutes(-60, intervals)).toBeGreaterThan(pollIntervalMinutes(30, intervals));
  });
});

describe('isDueForCheck', () => {
  it('always checks a match that has never been checked', () => {
    expect(
      isDueForCheck(
        { scheduledKickoffUtc: KICKOFF, resultLastSyncedAt: null, resultSyncAttempts: 0 },
        intervals,
        minutesFromKickoff(-1000),
      ),
    ).toBe(true);
  });

  it('waits out the interval before re-checking', () => {
    const now = minutesFromKickoff(30); // live: 15-minute interval
    expect(
      isDueForCheck(
        { scheduledKickoffUtc: KICKOFF, resultLastSyncedAt: minutesFromKickoff(25), resultSyncAttempts: 3 },
        intervals,
        now,
      ),
    ).toBe(false);

    expect(
      isDueForCheck(
        { scheduledKickoffUtc: KICKOFF, resultLastSyncedAt: minutesFromKickoff(10), resultSyncAttempts: 3 },
        intervals,
        now,
      ),
    ).toBe(true);
  });

  it('spends far fewer requests on a distant fixture than a live one', () => {
    const distant = { scheduledKickoffUtc: KICKOFF, resultLastSyncedAt: minutesFromKickoff(-700), resultSyncAttempts: 1 };
    // 60 minutes after the last check, still 10 hours from kickoff: not due.
    expect(isDueForCheck(distant, intervals, minutesFromKickoff(-640))).toBe(false);
    // Three hours later it is.
    expect(isDueForCheck(distant, intervals, minutesFromKickoff(-519))).toBe(true);
  });

  it('gives up after the configured attempt ceiling', () => {
    expect(
      isDueForCheck(
        { scheduledKickoffUtc: KICKOFF, resultLastSyncedAt: null, resultSyncAttempts: 40 },
        intervals,
        minutesFromKickoff(200),
      ),
    ).toBe(false);
  });
});
