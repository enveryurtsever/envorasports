/**
 * How far back the model is allowed to look.
 *
 * Four years of history makes the samples large, but a squad from 2022 is not
 * the squad playing on Saturday — promoted and relegated sides, new managers,
 * sold strikers. Beyond a season the extra rows mostly add inertia: a team that
 * has genuinely changed keeps being rated on who it used to be.
 *
 * The archive is still kept in full. Backtesting needs it, and widening this
 * window is a setting, not a re-import.
 */

/** European seasons turn over at the start of July. */
const SEASON_START_MONTH = 6; // zero-based: July

/** First day of the season that contains `now`. */
export function seasonStart(now: Date): Date {
  const year = now.getUTCFullYear();
  const startYear = now.getUTCMonth() >= SEASON_START_MONTH ? year : year - 1;
  return new Date(Date.UTC(startYear, SEASON_START_MONTH, 1));
}

/**
 * Earliest match the model reads. `seasonsBack: 1` means last season and the
 * current one — enough for a full set of fixtures against every opponent,
 * without carrying a squad that no longer exists.
 */
export function modelHistoryStart(now: Date, seasonsBack = 1): Date {
  const current = seasonStart(now);
  return new Date(
    Date.UTC(current.getUTCFullYear() - Math.max(0, seasonsBack), SEASON_START_MONTH, 1),
  );
}
