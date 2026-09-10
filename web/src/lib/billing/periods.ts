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
 * The insert is `on conflict do nothing` against the unique period key rather
 * than a check followed by an insert: two runs starting at the same moment on a
 * new period would both find nothing and both grant an allowance. Losing the
 * race here means reading the winner's row, which is the right answer anyway.
 */
export async function ensureUsagePeriod(
  db: BillingDatabase,
  request: PeriodRequest,
): Promise<UsagePeriodRow> {
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
    throw new Error("the usage period for this account could not be opened");
  }
  return row;
}

/** What is left of an allowance. Reserved work counts against it before it finishes. */
export function remainingRuns(period: UsagePeriodRow): number {
  return Math.max(0, period.runsAllowed - period.runsReserved - period.runsConsumed);
}
