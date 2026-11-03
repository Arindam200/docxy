/**
 * The counting behind `lib/seats.ts`: what an organization bought, and who is
 * already using it.
 *
 * Read-only on purpose. An invitation is checked here before Better Auth writes
 * it, and creating a billing account from inside an invitation request would
 * be a side effect nobody asked for - an organization without one is on Free,
 * which is what the columns default to anyway.
 *
 * Apart from `withdrawInvitation`, which undoes an invitation that lost a race
 * for the last seat - see `invitationFits` in `lib/seats.ts`.
 */

import { and, count, eq, gt, ne, sql } from "drizzle-orm";
import { entitlementsFor, hasSeatExpansion, plans, type PlanKey } from "@billing";
import { getDb } from "@/db";
import { invitation, member } from "@/db/schema";
import type { SeatUsage } from "@/lib/seats";
import { findBillingAccount } from "./accounts";
import { seatsEnforced } from "./config";

/**
 * This organization's seats and what fills them, or null when this deployment
 * does not limit seats at all - see `seatsEnforced`.
 */
export async function seatUsage(organizationId: string): Promise<SeatUsage | null> {
  if (!seatsEnforced()) return null;

  const [account, members, pending] = await Promise.all([
    findBillingAccount(organizationId),
    getDb()
      .select({ n: count() })
      .from(member)
      .where(eq(member.organizationId, organizationId)),
    getDb()
      .select({ n: count() })
      .from(invitation)
      .where(
        and(
          eq(invitation.organizationId, organizationId),
          eq(invitation.status, "pending"),
          // An expired invitation can no longer be accepted, so it no longer
          // holds a seat. Better Auth filters its own pending list the same way.
          gt(invitation.expiresAt, new Date()),
        ),
      ),
  ]);

  const plan: PlanKey = account?.entitledPlan ?? "free";
  return {
    planName: plans[plan].name,
    seats: entitlementsFor(plan, account?.purchasedSeats).seats,
    members: members[0]?.n ?? 0,
    pendingInvitations: pending[0]?.n ?? 0,
    expandable: hasSeatExpansion(plan),
  };
}

/**
 * How many of an organization's pending invitations were created before this
 * one. Ties on the timestamp are broken by id, so two requests asking about
 * the same pair of invitations always get the same order.
 */
export async function invitationsAhead(organizationId: string, invitationId: string): Promise<number> {
  const [row] = await getDb()
    .select({ n: count() })
    .from(invitation)
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
        ne(invitation.id, invitationId),
        // Compared in the database, at its own precision: a timestamp read
        // back into JavaScript loses its microseconds and could tie two rows
        // that Postgres orders.
        sql`(${invitation.createdAt}, ${invitation.id}) < (select i.created_at, i.id from ${invitation} i where i.id = ${invitationId})`,
      ),
    );
  return row?.n ?? 0;
}

/** Cancel an invitation that was written but has no seat to hold. */
export async function withdrawInvitation(invitationId: string): Promise<void> {
  await getDb().update(invitation).set({ status: "canceled" }).where(eq(invitation.id, invitationId));
}
