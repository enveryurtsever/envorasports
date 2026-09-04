/**
 * Timezone helpers.
 *
 * Kickoffs are stored in UTC, but a bulletin is published on a *local* weekday
 * and covers *local* calendar days. A 01:00 Monday kickoff in Istanbul is
 * 22:00 Sunday UTC — bucketing that by UTC date would file a Monday match under
 * Sunday and silently drop it from Monday's coverage.
 */

/** A calendar day with no time component, as "YYYY-MM-DD". */
export type LocalDateKey = string;

/** ISO weekday: Monday = 1 … Sunday = 7. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

const WEEKDAY_INDEX: Record<string, IsoWeekday> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: IsoWeekday;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let cached = formatterCache.get(timeZone);
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour12: false,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, cached);
  }
  return cached;
}

/** Breaks an instant into wall-clock parts in the given zone. */
export function partsInZone(at: Date, timeZone: string): ZonedParts {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, p.value]),
  ) as Record<string, string>;

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Intl renders midnight as hour 24 in some locales.
    hour: Number(parts.hour) === 24 ? 0 : Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_INDEX[parts.weekday ?? 'Mon'] ?? 1,
  };
}

/** Offset of `timeZone` from UTC at that instant, in milliseconds. */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = partsInZone(at, timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - at.getTime();
}

/**
 * Wall-clock time in a zone -> the UTC instant.
 *
 * Two passes: the offset that applies at the *naive* instant can differ from
 * the one that applies at the real instant across a DST boundary, and a single
 * pass lands an hour out on exactly those days.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let utc = naive - zoneOffsetMs(new Date(naive), timeZone);
  utc = naive - zoneOffsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

export function localDateKey(at: Date, timeZone: string): LocalDateKey {
  const p = partsInZone(at, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function isoWeekdayInZone(at: Date, timeZone: string): IsoWeekday {
  return partsInZone(at, timeZone).weekday;
}

// --- pure calendar arithmetic on date keys ---------------------------------
// Done on a UTC midnight anchor so it is unaffected by DST entirely.

export function parseDateKey(key: LocalDateKey): { year: number; month: number; day: number } {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) throw new RangeError(`Invalid date key "${key}"`);
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

export function addDays(key: LocalDateKey, days: number): LocalDateKey {
  const { year, month, day } = parseDateKey(key);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(
    shifted.getUTCDate(),
  ).padStart(2, '0')}`;
}

export function weekdayOfDateKey(key: LocalDateKey): IsoWeekday {
  const { year, month, day } = parseDateKey(key);
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay(); // 0 = Sunday
  return (jsDay === 0 ? 7 : jsDay) as IsoWeekday;
}

/** Half-open UTC interval `[start, end)` covering one local calendar day. */
export function utcRangeForLocalDate(
  key: LocalDateKey,
  timeZone: string,
): { start: Date; end: Date } {
  const { year, month, day } = parseDateKey(key);
  const start = zonedTimeToUtc(year, month, day, 0, 0, timeZone);
  const next = addDays(key, 1);
  const n = parseDateKey(next);
  const end = zonedTimeToUtc(n.year, n.month, n.day, 0, 0, timeZone);
  return { start, end };
}

/** Local midnight of a date key, stored in a Postgres `date` column. */
export function dateKeyToUtcMidnight(key: LocalDateKey): Date {
  const { year, month, day } = parseDateKey(key);
  return new Date(Date.UTC(year, month - 1, day));
}

export function utcMidnightToDateKey(date: Date): LocalDateKey {
  return date.toISOString().slice(0, 10);
}
