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

/** The parts of a subscription that can fix a paid window. */
export interface PaidWindow {
  /** The subscription the window belongs to. */
  id: string;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
}

export interface UsageWindow {
  bounds: PeriodBounds;
  /** The subscription the window came from; null for a Free window. */
  subscriptionId: string | null;
}

/**
 * The window an account's runs count against right now.
 *
 * Both sides open usage periods - the dashboard when somebody looks at billing,
 * admission when a run asks for a slot - and the unique key they meet on is the
 * period's start. If they chose windows differently, one month would become two
 * rows with two allowances: the one the customer is shown and the one their
 * runs are counted against. So the choice is made here, once.
 *
 * A paid plan uses the provider's own boundaries. Falling back to the Free
 * window when a paid subscription has not reported them yet keeps the account
 * metered rather than unmetered - an unknown period is not a licence.
 *
 * Pass null for an account on Free, whatever subscription rows it has: the Free
 * ledger is anchored to the account, and an old subscription left behind by a
 * cancellation must not drag it back into its last paid window. A paid window
 * whose end has passed without a renewal is still the window returned - the
 * account spends what is left of the period it paid for rather than opening one
 * nobody has paid for yet.
 */
export function usageWindow(
  accountCreatedAt: Date,
  subscription: PaidWindow | null,
  now: Date = new Date(),
): UsageWindow {
  if (subscription?.currentPeriodStart && subscription.currentPeriodEnd) {
    return {
      bounds: { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd },
      subscriptionId: subscription.id,
    };
  }
  return { bounds: freePeriodBounds(accountCreatedAt, now), subscriptionId: null };
}
