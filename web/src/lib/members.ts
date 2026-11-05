/**
 * Roles, and the rules about who may change a team.
 *
 * Deliberately free of database imports. These are the decisions the Members
 * page and the invitation page make about what to *offer*, they are worth
 * testing on their own, and a predicate that opens a connection to answer
 * "may an admin remove an owner" is a predicate nobody can test. The reads live
 * beside this in `members-store.ts`.
 *
 * Most of this is not the security boundary, and must not be mistaken for one.
 * What the page offers is a courtesy: a button hidden here is still refused if
 * somebody calls the endpoint directly. The exception is `rankRefusal`, which
 * *is* enforced, and it exists because Better Auth's organization plugin does
 * not enforce rank between admins. As of 1.7.1 its remove-member and
 * update-member-role endpoints protect the owner and check that the caller
 * holds the `member` permission, and nothing else - so any admin could remove
 * or demote any other admin. The `hooks.before` in `auth.ts` runs this function
 * on both endpoints and refuses what it refuses, which makes it one rule for the
 * page and the server rather than two that drift apart.
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
 * The most privileged role a stored role string holds.
 *
 * Better Auth keeps several roles in one comma-separated column and grants a
 * permission when any of them carries it, so `admin,member` is an admin.
 * `asRole` reads that whole string as a plain member, which is the safe
 * direction for deciding what to offer somebody and the dangerous one for
 * deciding who is protected from them: an admin stored that way would look
 * like a member anybody may remove. The rank check reads both sides this way.
 */
export function strongestRole(value: string | null | undefined): OrganizationRole {
  const roles = (value ?? "").split(",").map((role) => asRole(role.trim()));
  return roles.reduce<OrganizationRole>(
    (best, role) => (RANK[role] < RANK[best] ? role : best),
    "member",
  );
}

/** What somebody is trying to do to a member row. */
export type MembershipChange =
  | { kind: "remove" }
  | { kind: "role"; roles: readonly string[] };

/**
 * Why `actor` may not make `change` to `target`, or null when rank allows it.
 *
 * The rule is that an admin manages members and nobody above them. An owner
 * may act on anybody, and Better Auth itself still stops the last owner being
 * removed or demoted. An admin may remove a member or change a member's role,
 * but may not touch another admin or an owner: otherwise two admins can race
 * to eject each other, and whoever clicks first owns the organization's
 * repositories. Only an owner may make somebody an owner, whoever that is.
 *
 * Acting on yourself is left to Better Auth, apart from promoting yourself to
 * owner. An admin stepping down to member gives nothing away.
 *
 * Null means "rank does not object", not "allowed": Better Auth's own checks
 * run afterwards, and a plain member is refused there by permission whatever
 * this says.
 */
export function rankRefusal(
  actor: OrganizationRole,
  target: OrganizationRole,
  isSelf: boolean,
  change: MembershipChange,
): string | null {
  if (actor === "owner") return null;
  if (change.kind === "role" && change.roles.includes("owner")) {
    return "Only an owner can make somebody an owner.";
  }
  if (isSelf) return null;
  if (actor !== "admin") return "Only owners and admins can change who is in this organization.";
  if (target === "member") return null;
  return change.kind === "remove"
    ? "Only an owner can remove an admin or an owner."
    : "Only an owner can change the role of an admin or an owner.";
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
  // An admin may remove members but not peers; an owner outranks both. Asked
  // of the same rule the server enforces, so the button and the refusal agree.
  return rankRefusal(actor, target, false, { kind: "remove" }) === null;
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
