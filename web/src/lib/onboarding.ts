/**
 * Where a signed-in account belongs, given what it is a member of and what its
 * session claims.
 *
 * The two facts disagree more often than they look like they should. A
 * session's `activeOrganizationId` is stamped on when the session is created,
 * so it says nothing about memberships gained or lost since: an account that
 * joined an organization after signing in still carries null, and one whose
 * organization was deleted or left still carries an id that resolves to
 * nothing.
 *
 * Reading either fact alone is what made onboarding a dead end. Deciding on the
 * session id alone offered a second organization to somebody who already had
 * one; deciding on membership alone in one place and the session id in another
 * bounced the browser between the dashboard and onboarding forever. So the rule
 * lives here, once, and both pages ask it rather than each reaching its own
 * conclusion.
 */
export type OrganizationRoute =
  /** The session names an organization the account is really in. Carry on. */
  | { kind: "ready"; activeOrganizationId: string }
  /** No memberships at all: onboarding, and its form. */
  | { kind: "create" }
  /** Memberships the session does not name. Nothing to create - repair it. */
  | { kind: "activate"; organizationId: string };

export function resolveOrganization(
  organizations: ReadonlyArray<{ id: string }>,
  activeOrganizationId: string | null,
): OrganizationRoute {
  if (organizations.length === 0) return { kind: "create" };

  // Membership is what makes an id usable, not merely its presence. A stale id
  // pointing at an organization the account has left is treated exactly like a
  // missing one, because for every read below it means the same thing.
  const member = organizations.some((entry) => entry.id === activeOrganizationId);
  if (activeOrganizationId && member) return { kind: "ready", activeOrganizationId };

  // The listing is ordered, so "the first one" is stable across requests rather
  // than whichever row the database happened to return first.
  return { kind: "activate", organizationId: organizations[0].id };
}
