/**
 * Roles, and the rules about who may change a team.
 *
 * Deliberately free of database imports. These are the decisions the Members
 * page and the invitation page make about what to *offer*, they are worth
 * testing on their own, and a predicate that opens a connection to answer
 * "may an admin remove an owner" is a predicate nobody can test. The reads live
 * beside this in `members-store.ts`.
 *
 * None of this is the security boundary, and it must not be mistaken for one:
 * Better Auth's organization plugin enforces the same rules server-side on
 * every call, and a button hidden here is still refused if somebody calls the
 * endpoint directly. What these buy is a page that does not offer an action it
 * already knows will fail.
 */

/** The three roles the organization plugin ships with. */
export type OrganizationRole = "owner" | "admin" | "member";

/**
 * Roles, most privileged first, so "outranks" is a comparison rather than a
 * table of special cases.
 */
const RANK = { owner: 0, admin: 1, member: 2 } satisfies Record<OrganizationRole, number>;

/**
 * Anything stored in the role column, narrowed.
 *
 * The column is free text with a default, and a row written by a future version
 * of the plugin - or by hand - could hold something else. An unrecognised role
 * reads as the least privileged one rather than throwing the page away, and
 * emphatically rather than being treated as an owner.
 */
export function asRole(value: string | null | undefined): OrganizationRole {
  return value === "owner" || value === "admin" ? value : "member";
}

/**
 * Owners and admins run the team; a plain member can see it and nothing more.
 *
 * There is no "leave" here yet. It is not an oversight to fix casually: the
 * last owner leaving strands an organization with connected repositories and
 * nobody who can administer them, so it needs the ownership-transfer path this
 * build does not have.
 */
export function canManageMembers(role: OrganizationRole): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Whether `actor` may remove `target`.
 *
 * Strictly by rank, with two carve-outs that are the whole reason this is a
 * function. Removing *yourself* is leaving, a different action with a different
 * confirmation, so it is never offered here - offering it on an owner's own row
 * is how an organization ends up with nobody who can administer it. And an
 * owner is never removable through this page at all: replacing one is ownership
 * transfer, which this build does not do.
 */
export function canRemoveMember(
  actor: OrganizationRole,
  target: OrganizationRole,
  isSelf: boolean,
): boolean {
  if (isSelf) return false;
  if (target === "owner") return false;
  if (!canManageMembers(actor)) return false;
  // An admin may remove members but not peers; an owner outranks both.
  return RANK[actor] < RANK[target];
}

/** Members, owners first, then by name. Ordering the table is not a query's job. */
export function byRankThenName<T extends { role: OrganizationRole; name: string; email: string }>(
  people: readonly T[],
): T[] {
  return [...people].sort(
    (a, b) =>
      RANK[a.role] - RANK[b.role] ||
      (a.name || a.email).localeCompare(b.name || b.email),
  );
}

/** A person in the organization, as the Members table renders them. */
export interface TeamMember {
  /** The `member` row id. */
  id: string;
  userId: string;
  name: string;
  email: string;
  image: string | null;
  role: OrganizationRole;
  joinedAt: string;
}

/** An invitation that has been sent and not yet answered. */
export interface PendingInvitation {
  id: string;
  email: string;
  role: OrganizationRole;
  expiresAt: string;
  invitedByName: string;
}

/** Why an invitation cannot be acted on, when it cannot. */
export type InvitationProblem = "expired" | "accepted" | "rejected" | "canceled" | "unknown";

export interface InvitationDetail {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  inviterName: string;
  role: OrganizationRole;
  /** The invited address. Compared against the session; see `viewable`. */
  email: string;
  expiresAt: string;
  /** Null when the invitation is still open and can be accepted. */
  problem: InvitationProblem | null;
}

/**
 * Expiry is checked before status, deliberately.
 *
 * A pending invitation that ran out of time is expired, not pending, and the
 * status column has no way to say so - nothing sweeps it. Reading the clock
 * here is what stops the page offering an Accept button the server refuses a
 * moment later.
 */
export function invitationProblem(status: string, expiresAt: Date): InvitationProblem | null {
  if (status === "accepted" || status === "rejected" || status === "canceled") return status;
  if (status !== "pending") return "unknown";
  return expiresAt.getTime() <= Date.now() ? "expired" : null;
}

/**
 * Whether this reader may see who an invitation was addressed to.
 *
 * True only for the person who can actually accept it. The id is a random token
 * that arrived by email, so treating possession of it as permission to see the
 * organization's *name* matches the trust the emailed link already implies. The
 * invited **address** is not in that category: it belongs to a third party, and
 * showing it to whoever opens a forwarded link would turn that forward into an
 * address disclosure.
 */
export function viewable(detail: Pick<InvitationDetail, "email">, viewerEmail: string | null): boolean {
  return viewerEmail !== null && viewerEmail.toLowerCase() === detail.email.toLowerCase();
}
