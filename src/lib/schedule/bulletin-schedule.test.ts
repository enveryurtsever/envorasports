import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BULLETIN_SCHEDULE,
  bulletinWeek,
  previousBulletinWeek,
  bulletinScheduleSchema,
  coverageWindow,
  decideRun,
  isPublicationDay,
  nextPublicationDate,
  previousPublicationDate,
  publicationCovering,
  publicationRunAt,
  uncoveredWeekdays,
} from './bulletin-schedule';
import { weekdayOfDateKey } from '@/lib/time/zoned';

// 2026-09-07 is a Monday, 2026-09-10 the Thursday of the same week.
const MONDAY = '2026-09-07';
const THURSDAY = '2026-09-10';
const schedule = DEFAULT_BULLETIN_SCHEDULE;

describe('the brief’s worked example', () => {
  it('publishes on Monday and Thursday only', () => {
    expect(isPublicationDay(MONDAY, schedule)).toBe(true);
    expect(isPublicationDay(THURSDAY, schedule)).toBe(true);
    for (const day of ['2026-09-08', '2026-09-09', '2026-09-11', '2026-09-12', '2026-09-13']) {
      expect(isPublicationDay(day, schedule)).toBe(false);
    }
  });

  it('Thursday prepares Friday, Saturday and Sunday', () => {
    const window = coverageWindow(THURSDAY, schedule);
    expect(window.days).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
    expect(window.days.map(weekdayOfDateKey)).toEqual([5, 6, 7]);
  });

  it('Monday prepares Tuesday, Wednesday and Thursday', () => {
    const window = coverageWindow(MONDAY, schedule);
    expect(window.days).toEqual(['2026-09-08', '2026-09-09', '2026-09-10']);
    expect(window.days.map(weekdayOfDateKey)).toEqual([2, 3, 4]);
  });

  it('exposes UTC bounds that bracket the local days', () => {
    const window = coverageWindow(THURSDAY, schedule);
    // Istanbul is UTC+3 year round, so local midnight is 21:00 UTC the day before.
    expect(window.startUtc.toISOString()).toBe('2026-09-10T21:00:00.000Z');
    expect(window.endUtc.toISOString()).toBe('2026-09-13T21:00:00.000Z');
    expect(window.endUtc.getTime()).toBeGreaterThan(window.startUtc.getTime());
  });
});

describe('coverage gaps', () => {
  it('flags that this schedule never covers Monday’s own matches', () => {
    // Monday's window starts Tuesday and Thursday's ends Sunday, so nothing
    // reaches Monday. Worth knowing before trusting the schedule.
    expect(uncoveredWeekdays(schedule)).toEqual([1]);
  });

  it('closes the gap when the window starts on the publication day', () => {
    expect(uncoveredWeekdays({ ...schedule, coverageOffsetDays: 0, coverageDays: 4 })).toEqual([]);
  });

  it('reports no gap for a daily schedule', () => {
    expect(uncoveredWeekdays({ ...schedule, publicationWeekdays: [1, 2, 3, 4, 5, 6, 7] })).toEqual([]);
  });
});

describe('navigating the schedule', () => {
  it('finds the next and previous publication days', () => {
    expect(nextPublicationDate(MONDAY, schedule)).toBe(THURSDAY);
    expect(nextPublicationDate(THURSDAY, schedule)).toBe('2026-09-14');
    expect(previousPublicationDate(THURSDAY, schedule)).toBe(MONDAY);
  });

  it('can include the given day', () => {
    expect(nextPublicationDate(MONDAY, schedule, { inclusive: true })).toBe(MONDAY);
    expect(previousPublicationDate(MONDAY, schedule, { inclusive: true })).toBe(MONDAY);
  });

  it('wraps across the week boundary', () => {
    // Sunday 2026-09-13 -> next publication is Monday the 14th.
    expect(nextPublicationDate('2026-09-13', schedule)).toBe('2026-09-14');
  });

  it('maps a match day back to the publication that prepared it', () => {
    expect(publicationCovering('2026-09-12', schedule)).toBe(THURSDAY);
    expect(publicationCovering('2026-09-09', schedule)).toBe(MONDAY);
    // Monday is the uncovered day.
    expect(publicationCovering('2026-09-14', schedule)).toBeNull();
  });
});

describe('run timing', () => {
  it('fires at the configured local time', () => {
    const at = publicationRunAt(THURSDAY, schedule);
    // 09:00 Istanbul (UTC+3) is 06:00 UTC.
    expect(at.toISOString()).toBe('2026-09-10T06:00:00.000Z');
  });

  it('respects a zone with DST', () => {
    const london = { ...schedule, timezone: 'Europe/London', publishTimeLocal: '09:00' };
    // BST in September: 09:00 local is 08:00 UTC.
    expect(publicationRunAt('2026-09-10', london).toISOString()).toBe('2026-09-10T08:00:00.000Z');
    // GMT in December: 09:00 local is 09:00 UTC.
    expect(publicationRunAt('2026-12-10', london).toISOString()).toBe('2026-12-10T09:00:00.000Z');
  });
});

describe('decideRun', () => {
  // 12:00 Istanbul on the Thursday.
  const thursdayNoon = new Date('2026-09-10T09:00:00Z');
  const wednesdayNoon = new Date('2026-09-09T09:00:00Z');

  it('runs on a publication day', () => {
    const decision = decideRun(schedule, thursdayNoon);
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toBe('publication_day');
    expect(decision.window?.days).toEqual(['2026-09-11', '2026-09-12', '2026-09-13']);
  });

  it('skips cleanly on any other day, spending no quota', () => {
    const decision = decideRun(schedule, wednesdayNoon);
    expect(decision.shouldRun).toBe(false);
    expect(decision.reason).toBe('not_a_publication_day');
    expect(decision.window).toBeNull();
  });

  it('skips when disabled', () => {
    expect(decideRun({ ...schedule, enabled: false }, thursdayNoon).reason).toBe('disabled');
  });

  it('can be forced for a manual or backfill run', () => {
    const decision = decideRun(schedule, wednesdayNoon, { force: true });
    expect(decision.shouldRun).toBe(true);
    expect(decision.reason).toBe('forced');
    expect(decision.window).not.toBeNull();
  });

  it('uses the schedule’s zone, not the server’s, to decide the weekday', () => {
    // 22:30 UTC Wednesday is already 01:30 Thursday in Istanbul.
    const decision = decideRun(schedule, new Date('2026-09-09T22:30:00Z'));
    expect(decision.publicationDate).toBe(THURSDAY);
    expect(decision.shouldRun).toBe(true);
  });
});

describe('schedule validation', () => {
  it('accepts the default', () => {
    expect(bulletinScheduleSchema.safeParse(schedule).success).toBe(true);
  });

  it('rejects a duplicated weekday', () => {
    expect(bulletinScheduleSchema.safeParse({ ...schedule, publicationWeekdays: [1, 1, 4] }).success).toBe(false);
  });

  it('rejects an out-of-range weekday', () => {
    expect(bulletinScheduleSchema.safeParse({ ...schedule, publicationWeekdays: [0] }).success).toBe(false);
    expect(bulletinScheduleSchema.safeParse({ ...schedule, publicationWeekdays: [8] }).success).toBe(false);
  });

  it('rejects an unknown timezone', () => {
    expect(bulletinScheduleSchema.safeParse({ ...schedule, timezone: 'Mars/Olympus' }).success).toBe(false);
  });

  it('rejects a malformed publish time', () => {
    for (const time of ['9:00', '24:00', '09:60', 'noon']) {
      expect(bulletinScheduleSchema.safeParse({ ...schedule, publishTimeLocal: time }).success).toBe(false);
    }
  });

  it('requires at least one match day of coverage', () => {
    expect(bulletinScheduleSchema.safeParse({ ...schedule, coverageDays: 0 }).success).toBe(false);
  });
});

describe('bulletinWeek', () => {
  it('runs Monday to Sunday regardless of which day you ask about', () => {
    for (const day of ['2026-09-07', '2026-09-10', '2026-09-13']) {
      const week = bulletinWeek(day, schedule);
      expect(week.startDate).toBe('2026-09-07');
      expect(week.endDate).toBe('2026-09-13');
      expect(week.days).toHaveLength(7);
    }
  });

  it('lists the publications inside the week', () => {
    // Monday and Thursday, matching the configured schedule.
    expect(bulletinWeek('2026-09-09', schedule).publications).toEqual(['2026-09-07', '2026-09-10']);
  });

  it('brackets the week in UTC', () => {
    const week = bulletinWeek('2026-09-09', schedule);
    // Istanbul is UTC+3: local Monday midnight is 21:00 the Sunday before.
    expect(week.startUtc.toISOString()).toBe('2026-09-06T21:00:00.000Z');
    expect(week.endUtc.toISOString()).toBe('2026-09-13T21:00:00.000Z');
  });

  it('steps back a whole week', () => {
    const previous = previousBulletinWeek(bulletinWeek('2026-09-09', schedule), schedule);
    expect(previous.startDate).toBe('2026-08-31');
    expect(previous.endDate).toBe('2026-09-06');
  });
});

describe('forcing a run reproduces the schedule', () => {
  // Friday 2026-09-04, mid-evening in Istanbul.
  const friday = new Date('2026-09-04T18:00:00Z');

  it('runs Thursday’s bulletin when forced on a Friday', () => {
    const decision = decideRun(schedule, friday, { force: true });

    // Not a new Friday publication covering Sat-Mon.
    expect(decision.publicationDate).toBe('2026-09-03');
    expect(decision.window?.days).toEqual(['2026-09-04', '2026-09-05', '2026-09-06']);
  });

  it('keeps today when forced on an actual publication day', () => {
    const thursday = new Date('2026-09-10T09:00:00Z');
    expect(decideRun(schedule, thursday, { force: true }).publicationDate).toBe('2026-09-10');
  });

  it('backfills an explicit publication date', () => {
    const decision = decideRun(schedule, friday, { publicationDate: '2026-08-31' });
    expect(decision.publicationDate).toBe('2026-08-31');
    expect(decision.window?.days).toEqual(['2026-09-01', '2026-09-02', '2026-09-03']);
  });
});
