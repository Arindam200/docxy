/**
 * Reads behind the Members and invitation pages.
 *
 * Kept apart from `members.ts` so the rules there stay testable without a
 * database. Everything here is a query; every decision is next door.
 */

import { and, asc, eq, gt } from "drizzle-orm";
import { getDb } from "@/db";
import { invitation, member, organization, user } from "@/db/schema";
import {
  asRole,
  byRankThenName,
  invitationProblem,
  type InvitationDetail,
  type OrganizationRole,
  type PendingInvitation,
  type TeamMember,
} from "@/lib/members";

/** Everyone in one organization, owners first and then by name. */
export async function getMembers(organizationId: string): Promise<TeamMember[]> {
  const rows = await getDb()
    .select({
      id: member.id,
      userId: member.userId,
      role: member.role,
      createdAt: member.createdAt,
      name: user.name,
      email: user.email,
      image: user.image,
    })
    .from(member)
    .innerJoin(user, eq(member.userId, user.id))
    .where(eq(member.organizationId, organizationId));

  return byRankThenName(
    rows.map((row) => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      email: row.email,
      image: row.image,
      role: asRole(row.role),
      joinedAt: row.createdAt.toISOString(),
    })),
  );
}

/**
 * Invitations still worth showing: pending, and not yet expired.
 *
 * Expired ones are filtered in the query rather than rendered greyed out. An
 * expired invitation cannot be accepted and cannot be resent - it can only be
 * cancelled and sent again as a new one - so listing it offers a row whose only
 * honest action the reader has to work out for themselves.
 */
export async function getPendingInvitations(
  organizationId: string,
): Promise<PendingInvitation[]> {
  const rows = await getDb()
    .select({
      id: invitation.id,
      email: invitation.email,
      role: invitation.role,
      expiresAt: invitation.expiresAt,
      inviterName: user.name,
      inviterEmail: user.email,
    })
    .from(invitation)
    .innerJoin(user, eq(invitation.inviterId, user.id))
    .where(
      and(
        eq(invitation.organizationId, organizationId),
        eq(invitation.status, "pending"),
        gt(invitation.expiresAt, new Date()),
      ),
    )
    .orderBy(asc(invitation.email));

  return rows.map((row) => ({
    id: row.id,
    email: row.email,
    role: asRole(row.role),
    expiresAt: row.expiresAt.toISOString(),
    invitedByName: row.inviterName || row.inviterEmail,
  }));
}

/** The signed-in person's role here, or null when they are not a member. */
export async function getViewerRole(
  organizationId: string,
  userId: string,
): Promise<OrganizationRole | null> {
  const [row] = await getDb()
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return row ? asRole(row.role) : null;
}

/**
 * One invitation, for the page that accepts it.
 *
 * Read straight from the database rather than through Better Auth's
 * `getInvitation`, because that page has to render for somebody who is **not
 * signed in** - the ordinary case, since the point of an invitation is to reach
 * people without an account. An endpoint that requires a session cannot answer
 * "what am I being invited to" before the reader has one.
 *
 * A row that exists but cannot be accepted is *returned*, carrying `problem`,
 * rather than collapsed into null. "Already accepted" and "not an invitation"
 * are different things to be told, and only one has an obvious next step.
 */
export async function getInvitation(id: string): Promise<InvitationDetail | null> {
  const [row] = await getDb()
    .select({
      id: invitation.id,
      organizationId: invitation.organizationId,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      email: invitation.email,
      role: invitation.role,
      status: invitation.status,
      expiresAt: invitation.expiresAt,
      inviterName: user.name,
      inviterEmail: user.email,
    })
    .from(invitation)
    .innerJoin(organization, eq(invitation.organizationId, organization.id))
    .innerJoin(user, eq(invitation.inviterId, user.id))
    .where(eq(invitation.id, id))
    .limit(1);

  if (!row) return null;

  return {
    id: row.id,
    organizationId: row.organizationId,
    organizationName: row.organizationName,
    organizationSlug: row.organizationSlug,
    inviterName: row.inviterName || row.inviterEmail,
    role: asRole(row.role),
    email: row.email,
    expiresAt: row.expiresAt.toISOString(),
    problem: invitationProblem(row.status, row.expiresAt),
  };
}
