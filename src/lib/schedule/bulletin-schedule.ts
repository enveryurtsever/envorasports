import { z } from 'zod';
import {
  addDays,
  localDateKey,
  utcRangeForLocalDate,
  weekdayOfDateKey,
  zonedTimeToUtc,
  type IsoWeekday,
  type LocalDateKey,
} from '@/lib/time/zoned';

/**
 * Bulletin publication schedule.
 *
 * The system does not run every day. It runs on the days the bulletin is
 * published, and each run prepares coupons for a forward window of match days.
 *
 * Worked example (the configured default):
 *   Monday   -> Tuesday, Wednesday, Thursday
 *   Thursday -> Friday, Saturday, Sunday
 *
 * Both follow one rule: a publication day covers the next `coverageDays` days,
 * starting `coverageOffsetDays` days later.
 */

export const COVERAGE_GROUPING = ['PER_DAY', 'WINDOW'] as const;
export type CoverageGrouping = (typeof COVERAGE_GROUPING)[number];

export const bulletinScheduleSchema = z
  .object({
    enabled: z.boolean(),
    /** The zone whose calendar decides what "Thursday" means. */
    timezone: z.string().min(1),
    /** ISO weekdays the bulletin is published on: Monday = 1 … Sunday = 7. */
    publicationWeekdays: z.array(z.number().int().min(1).max(7)).min(1).max(7),
    /** 0 = include the publication day itself, 1 = start tomorrow. */
    coverageOffsetDays: z.number().int().min(0).max(14),
    /** How many match days one run prepares. */
    coverageDays: z.number().int().min(1).max(14),
    /** Local time of day the run fires, "HH:MM". */
    publishTimeLocal: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
    /**
     * PER_DAY  — a separate set of coupons for each match day in the window.
     * WINDOW   — one set whose selections may span the whole window.
     */
    grouping: z.enum(COVERAGE_GROUPING),
  })
  .refine((s) => new Set(s.publicationWeekdays).size === s.publicationWeekdays.length, {
    message: 'publicationWeekdays must not repeat a day',
    path: ['publicationWeekdays'],
  })
  .refine((s) => isValidTimeZone(s.timezone), {
    message: 'Unknown IANA timezone',
    path: ['timezone'],
  });

export type BulletinSchedule = z.infer<typeof bulletinScheduleSchema>;

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The schedule from the brief: publish Monday and Thursday, cover 3 days. */
export const DEFAULT_BULLETIN_SCHEDULE: BulletinSchedule = {
  enabled: true,
  timezone: 'Europe/Istanbul',
  publicationWeekdays: [1, 4],
  coverageOffsetDays: 1,
  coverageDays: 3,
  publishTimeLocal: '09:00',
  grouping: 'PER_DAY',
};

export interface CoverageWindow {
  publicationDate: LocalDateKey;
  startDate: LocalDateKey;
  endDate: LocalDateKey;
  /** Every local match day in the window, in order. */
  days: LocalDateKey[];
  /** Half-open UTC bounds `[startUtc, endUtc)` for querying kickoffs. */
  startUtc: Date;
  endUtc: Date;
}

export function isPublicationDay(date: LocalDateKey, schedule: BulletinSchedule): boolean {
  return schedule.publicationWeekdays.includes(weekdayOfDateKey(date));
}

/** The match days one publication prepares coupons for. */
export function coverageWindow(
  publicationDate: LocalDateKey,
  schedule: BulletinSchedule,
): CoverageWindow {
  const days = Array.from({ length: schedule.coverageDays }, (_, i) =>
    addDays(publicationDate, schedule.coverageOffsetDays + i),
  );

  const startDate = days[0] as LocalDateKey;
  const endDate = days[days.length - 1] as LocalDateKey;

  return {
    publicationDate,
    startDate,
    endDate,
    days,
    startUtc: utcRangeForLocalDate(startDate, schedule.timezone).start,
    endUtc: utcRangeForLocalDate(endDate, schedule.timezone).end,
  };
}

/** The instant a given publication day's run should fire. */
export function publicationRunAt(
  publicationDate: LocalDateKey,
  schedule: BulletinSchedule,
): Date {
  const [hour, minute] = schedule.publishTimeLocal.split(':').map(Number);
  const { year, month, day } = {
    year: Number(publicationDate.slice(0, 4)),
    month: Number(publicationDate.slice(5, 7)),
    day: Number(publicationDate.slice(8, 10)),
  };
  return zonedTimeToUtc(year, month, day, hour ?? 0, minute ?? 0, schedule.timezone);
}

export function nextPublicationDate(
  from: LocalDateKey,
  schedule: BulletinSchedule,
  options: { inclusive?: boolean } = {},
): LocalDateKey {
  const start = options.inclusive ? 0 : 1;
  for (let i = start; i <= start + 7; i++) {
    const candidate = addDays(from, i);
    if (isPublicationDay(candidate, schedule)) return candidate;
  }
  // Unreachable: publicationWeekdays always holds at least one weekday.
  throw new Error('Schedule has no publication weekday');
}

export function previousPublicationDate(
  from: LocalDateKey,
  schedule: BulletinSchedule,
  options: { inclusive?: boolean } = {},
): LocalDateKey {
  const start = options.inclusive ? 0 : 1;
  for (let i = start; i <= start + 7; i++) {
    const candidate = addDays(from, -i);
    if (isPublicationDay(candidate, schedule)) return candidate;
  }
  throw new Error('Schedule has no publication weekday');
}

/**
 * Which publication prepared the coupons for a given match day?
 *
 * Returns null when no publication covers it — see `uncoveredWeekdays`.
 */
export function publicationCovering(
  matchDate: LocalDateKey,
  schedule: BulletinSchedule,
): LocalDateKey | null {
  // Walk back far enough to catch any window that could still reach this day.
  const reach = schedule.coverageOffsetDays + schedule.coverageDays;
  for (let i = 0; i <= reach + 7; i++) {
    const candidate = addDays(matchDate, -i);
    if (!isPublicationDay(candidate, schedule)) continue;
    if (coverageWindow(candidate, schedule).days.includes(matchDate)) return candidate;
  }
  return null;
}

/**
 * Weekdays no publication ever covers.
 *
 * Worth checking before trusting a schedule: publishing Monday and Thursday
 * with a 3-day forward window leaves **Monday's own matches uncovered**, because
 * Monday's window starts on Tuesday and Thursday's ends on Sunday.
 */
export function uncoveredWeekdays(schedule: BulletinSchedule): IsoWeekday[] {
  const covered = new Set<IsoWeekday>();
  // Any Monday works as an anchor; coverage is a weekly pattern.
  const anchor: LocalDateKey = '2024-01-01'; // a Monday

  for (let offset = 0; offset < 7; offset++) {
    const publication = addDays(anchor, offset);
    if (!isPublicationDay(publication, schedule)) continue;
    for (const day of coverageWindow(publication, schedule).days) {
      covered.add(weekdayOfDateKey(day));
    }
  }

  return ([1, 2, 3, 4, 5, 6, 7] as IsoWeekday[]).filter((d) => !covered.has(d));
}

/** Convenience for jobs: today's local date in the schedule's zone. */
export function todayInSchedule(schedule: BulletinSchedule, now: Date = new Date()): LocalDateKey {
  return localDateKey(now, schedule.timezone);
}

export interface ScheduleDecision {
  shouldRun: boolean;
  publicationDate: LocalDateKey;
  reason: 'publication_day' | 'not_a_publication_day' | 'disabled' | 'forced';
  window: CoverageWindow | null;
}

/**
 * The check a scheduled job makes on every tick. A non-publication day is a
 * clean skip, not a failure — the job records SKIPPED and spends no provider
 * quota.
 */
export function decideRun(
  schedule: BulletinSchedule,
  now: Date = new Date(),
  options: { force?: boolean } = {},
): ScheduleDecision {
  const today = todayInSchedule(schedule, now);

  if (options.force) {
    return { shouldRun: true, publicationDate: today, reason: 'forced', window: coverageWindow(today, schedule) };
  }
  if (!schedule.enabled) {
    return { shouldRun: false, publicationDate: today, reason: 'disabled', window: null };
  }
  if (!isPublicationDay(today, schedule)) {
    return { shouldRun: false, publicationDate: today, reason: 'not_a_publication_day', window: null };
  }
  return {
    shouldRun: true,
    publicationDate: today,
    reason: 'publication_day',
    window: coverageWindow(today, schedule),
  };
}

export interface BulletinWeek {
  /** Monday of the week, in the schedule's local calendar. */
  startDate: LocalDateKey;
  /** Sunday of the same week. */
  endDate: LocalDateKey;
  days: LocalDateKey[];
  startUtc: Date;
  endUtc: Date;
  /** Publication days that fall inside the week. */
  publications: LocalDateKey[];
}

/**
 * The weekly bulletin period: Monday through Sunday in the schedule's zone.
 *
 * Reporting is weekly because that is the unit the bulletin actually works in —
 * a Monday and a Thursday publication together cover one week of football.
 */
export function bulletinWeek(date: LocalDateKey, schedule: BulletinSchedule): BulletinWeek {
  const weekday = weekdayOfDateKey(date);
  const startDate = addDays(date, -(weekday - 1));
  const days = Array.from({ length: 7 }, (_, i) => addDays(startDate, i));
  const endDate = days[6] as LocalDateKey;

  return {
    startDate,
    endDate,
    days,
    startUtc: utcRangeForLocalDate(startDate, schedule.timezone).start,
    endUtc: utcRangeForLocalDate(endDate, schedule.timezone).end,
    publications: days.filter((day) => isPublicationDay(day, schedule)),
  };
}

export function previousBulletinWeek(week: BulletinWeek, schedule: BulletinSchedule): BulletinWeek {
  return bulletinWeek(addDays(week.startDate, -7), schedule);
}

export const WEEKDAY_KEYS: Record<IsoWeekday, string> = {
  1: 'monday',
  2: 'tuesday',
  3: 'wednesday',
  4: 'thursday',
  5: 'friday',
  6: 'saturday',
  7: 'sunday',
};
