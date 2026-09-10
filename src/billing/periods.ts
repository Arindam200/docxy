/**
 * When a billing period starts and ends.
 *
 * Pure arithmetic, deliberately kept away from the database: both sides of the
 * product ask this question. The dashboard asks it to open a usage period and
 * to show a reset date; the pipeline asks it to decide which period a run about
 * to start belongs to. One answer, one file, and it can be tested without a
 * connection string.
 *
 * A paid period is not computed here at all - it is whatever the provider says
 * the subscription's current period is, in UTC, and a run that crosses a
 * renewal stays charged to the period it started in.
 */

export interface PeriodBounds {
  start: Date;
  end: Date;
}

/** The last day of a UTC month, so adding a month to the 31st cannot overflow. */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * `anchor` shifted by whole months in UTC, clamped to the target month's length.
 *
 * An account created on the 31st renews on the 30th of a short month and on the
 * 28th of February - and, crucially, still on the 31st of the next long one,
 * because every window is measured from the anchor rather than from the window
 * before it. Chaining month additions is how a 31st drifts to the 28th forever.
 */
export function addMonthsUtc(anchor: Date, months: number): Date {
  const target = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + months, 1));
  const day = Math.min(
    anchor.getUTCDate(),
    lastDayOfMonth(target.getUTCFullYear(), target.getUTCMonth()),
  );
  return new Date(
    Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      day,
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
}

/**
 * The Free window containing `now`, anchored to when the account was created.
 *
 * Anchored rather than calendar-monthly so resets spread across the month
 * instead of every Free account waking up together at midnight on the first.
 *
 * Counted from the anchor rather than stepped a month at a time, and searched
 * from an estimate rather than looped from the beginning: an account dormant
 * for two years should not cost two dozen iterations to price.
 */
export function freePeriodBounds(anchor: Date, now: Date = new Date()): PeriodBounds {
  if (now < anchor) return { start: anchor, end: addMonthsUtc(anchor, 1) };

  let index = Math.max(
    0,
    (now.getUTCFullYear() - anchor.getUTCFullYear()) * 12 +
      (now.getUTCMonth() - anchor.getUTCMonth()),
  );
  // The estimate is off by one whenever this month's anchor day has not arrived.
  while (index > 0 && addMonthsUtc(anchor, index) > now) index -= 1;
  while (addMonthsUtc(anchor, index + 1) <= now) index += 1;

  return { start: addMonthsUtc(anchor, index), end: addMonthsUtc(anchor, index + 1) };
}
