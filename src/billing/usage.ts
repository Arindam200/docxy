/**
 * The usage period row, as the pipeline opens it.
 *
 * The dashboard opens periods too, in web/src/lib/billing/periods.ts, and this
 * is a second copy of that file's insert-then-read - deliberately, and only of
 * the plumbing. Everything the two copies could disagree about is shared:
 *
 *   - which window applies is `usageWindow` in `./periods.ts`;
 *   - what the period allows is `entitlementsFor` in `./catalog.ts`;
 *   - one row per window is the `usage_periods_account_start` unique index,
 *     which neither copy can talk its way past.
 *
 * Why not one implementation: the dashboard bundles shared files with
 * Turbopack, and Turbopack does not map a `./catalog.js` specifier to
 * `catalog.ts` the way TypeScript and Node do - the dashboard build fails with
 * "Module not found" on the first relative import. The root files the dashboard
 * already shares (`catalog.ts`, `periods.ts`, `billing-schema.ts`) get away
 * with it by having no relative runtime imports at all, and opening a period
 * needs three. Checked by building a throwaway Next app against these files.
 *
 * The selftest holds the copies together: `openingPeriod` is compared with the
 * catalog for every plan, and `periodRequestFor` with `usageWindow`.
 */

import { and, eq } from 'drizzle-orm';
import { usagePeriods } from '../db/billing-schema.js';
import type { Executor } from '../db/executor.js';
import { entitlementsFor, type PlanKey } from './catalog.js';
import { usageWindow, type PaidWindow, type PeriodBounds } from './periods.js';

export type UsagePeriodRow = typeof usagePeriods.$inferSelect;

/** The same request the dashboard's `ensureUsagePeriod` takes. */
export interface PeriodRequest {
  accountId: string;
  planKey: PlanKey;
  seats: number;
  bounds: PeriodBounds;
  /** Present for a paid period; null for a Free one, which has no subscription. */
  subscriptionId: string | null;
}

/** The parts of a billing account that decide which period it is in. */
export interface AccountWindow {
  id: string;
  entitledPlan: PlanKey;
  purchasedSeats: number;
  createdAt: Date;
}

/**
 * The period an account is in now, as a request to open it.
 *
 * What the dashboard's `resolveEntitlement` asks for, assembled the same way:
 * the entitled plan, the purchased seats, and the window `usageWindow` picks.
 * A subscription passed for a Free account is ignored rather than trusted, so
 * a cancelled plan's leftover row cannot move the Free ledger.
 */
export function periodRequestFor(
  account: AccountWindow,
  subscription: PaidWindow | null,
  now: Date = new Date(),
): PeriodRequest {
  const window = usageWindow(
    account.createdAt,
    account.entitledPlan === 'free' ? null : subscription,
    now,
  );
  return {
    accountId: account.id,
    planKey: account.entitledPlan,
    seats: account.purchasedSeats,
    bounds: window.bounds,
    subscriptionId: window.subscriptionId,
  };
}

/**
 * The columns a new period opens with, without opening it.
 *
 * The allowance is copied into the row here and read from the row afterwards:
 * recomputing it at admission time would apply a price change retroactively,
 * halfway through a period somebody has already paid for.
 */
export function openingPeriod(request: PeriodRequest): typeof usagePeriods.$inferInsert {
  const entitlements = entitlementsFor(request.planKey, request.seats);
  return {
    accountId: request.accountId,
    subscriptionId: request.subscriptionId,
    planKey: request.planKey,
    periodStart: request.bounds.start,
    periodEnd: request.bounds.end,
    runsAllowed: entitlements.runsPerMonth,
    seatsAllowed: entitlements.seats,
    repositoriesAllowed: entitlements.repositories,
    automaticRuns: entitlements.automaticRuns,
  };
}

/**
 * The row for this period, opening it if this is the first time anyone asked.
 *
 * The insert is `on conflict do nothing` against the unique period key rather
 * than a check followed by an insert: two runs starting at the same moment on a
 * new period would both find nothing and both grant an allowance. Losing the
 * race - to another run, or to the dashboard - means reading the winner's row,
 * which is the right answer anyway.
 */
export async function ensureUsagePeriod(
  db: Executor,
  request: PeriodRequest,
): Promise<UsagePeriodRow> {
  await db
    .insert(usagePeriods)
    .values(openingPeriod(request))
    .onConflictDoNothing({
      target: [usagePeriods.accountId, usagePeriods.planKey, usagePeriods.periodStart],
    });

  const rows = await db
    .select()
    .from(usagePeriods)
    .where(
      and(
        eq(usagePeriods.accountId, request.accountId),
        eq(usagePeriods.planKey, request.planKey),
        eq(usagePeriods.periodStart, request.bounds.start),
      ),
    )
    .limit(1);

  const row = rows[0];
  if (!row) {
    // The insert either wrote a row or collided with one. Neither leaves
    // nothing behind, so this is a database that is not what it claims to be.
    throw new Error('the usage period for this account could not be opened');
  }
  return row;
}
