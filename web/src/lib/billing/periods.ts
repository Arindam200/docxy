/**
 * The usage period row, and the allowance it opens with.
 *
 * The window itself is arithmetic and lives in `@billing/periods`, where the
 * pipeline can reach it too. This file is the part that touches the database.
 *
 * The allowance is written into the row when the period opens and read from
 * there afterwards. Recomputing it from the catalog at admission time would
 * apply a price change retroactively, halfway through a period somebody has
 * already paid for.
 */

import { and, eq } from "drizzle-orm";
import { entitlementsFor, type PlanKey } from "@billing";
import type { PeriodBounds } from "@billing/periods";
import { usagePeriods } from "@billing/schema";
import type { BillingDatabase } from "./db";

export interface PeriodRequest {
  accountId: string;
  planKey: PlanKey;
  seats: number;
  bounds: PeriodBounds;
  /** Present for a paid period; null for a Free one, which has no subscription. */
  subscriptionId: string | null;
}

export type UsagePeriodRow = typeof usagePeriods.$inferSelect;

/**
 * The row for this period, opening it if this is the first time anyone asked.
 *
 * Read first, because almost every call finds the row already there: every
 * view of the billing page, and every poll of the status endpoint the checkout
 * return page makes every few seconds while it waits for a webhook. Writing on
 * each of those - even an insert that conflicts and does nothing - is a write
 * transaction spent learning what a select would have said.
 *
 * Only a missing row is inserted, and then `on conflict do nothing` against the
 * unique period key rather than trusting the read: two runs starting at the
 * same moment on a new period would both find nothing and both grant an
 * allowance. Losing that race means reading the winner's row, which is the
 * right answer anyway.
 */
export async function ensureUsagePeriod(
  db: BillingDatabase,
  request: PeriodRequest,
): Promise<UsagePeriodRow> {
  const existing = await findUsagePeriod(db, request);
  if (existing) return existing;

  const entitlements = entitlementsFor(request.planKey, request.seats);

  await db
    .insert(usagePeriods)
    .values({
      accountId: request.accountId,
      subscriptionId: request.subscriptionId,
      planKey: request.planKey,
      periodStart: request.bounds.start,
      periodEnd: request.bounds.end,
      runsAllowed: entitlements.runsPerMonth,
      seatsAllowed: entitlements.seats,
      repositoriesAllowed: entitlements.repositories,
      automaticRuns: entitlements.automaticRuns,
    })
    .onConflictDoNothing({
      target: [usagePeriods.accountId, usagePeriods.planKey, usagePeriods.periodStart],
    });

  const row = await findUsagePeriod(db, request);
  if (!row) {
    // The insert either wrote a row or collided with one. Neither leaves
    // nothing behind, so this is a database that is not what it claims to be.
    throw new Error("the usage period for this account could not be opened");
  }
  return row;
}

async function findUsagePeriod(
  db: BillingDatabase,
  request: PeriodRequest,
): Promise<UsagePeriodRow | null> {
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
  return rows[0] ?? null;
}

/** What is left of an allowance. Reserved work counts against it before it finishes. */
export function remainingRuns(period: UsagePeriodRow): number {
  return Math.max(0, period.runsAllowed - period.runsReserved - period.runsConsumed);
}
