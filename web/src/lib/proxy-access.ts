/**
 * Which proxied writes need an owner or admin.
 *
 * The proxy checked that a caller belonged to the organization and stopped
 * there, so a plain member could delete a project, overwrite the organization's
 * standing instructions, or connect a repository - everything the Members page
 * describes as "changes nothing". guides/TEAM-PRICING-PLAN.md gives the role
 * model this follows: admins manage repository connections and settings, and
 * members read, run and review. Composio connections already work this way;
 * see `composio-handlers.ts`.
 *
 * So the day-to-day work stays open to everyone in the organization - starting
 * a run, and publishing a finished run's pull request - and every other write
 * is for owners and admins. That list is closed on purpose: a write this file
 * does not name is treated as organization-shaping until somebody decides
 * otherwise, because a new upstream endpoint that slipped through open is the
 * mistake this file exists to stop.
 *
 * No server imports, so the rule can be tested without a session or database.
 * Paths are the upstream form the proxy has already validated: `/api/...`,
 * plain segments only.
 */

import type { OrganizationRole } from "./members";

/** What a refused write says. */
export const MANAGERS_ONLY =
  "Only owners and admins can change this organization's projects, repositories and " +
  "instructions. Members can still start runs and publish their pull requests.";

/** Writes any member may make: running the pipeline and publishing what it made. */
const MEMBER_WRITES = [
  // Starting a run for a connected project.
  /^\/api\/projects\/[^/]+\/runs$/,
  // The single-repository run, which upstream refuses outright on any
  // deployment with a database - so there is no organization to protect.
  /^\/api\/runs$/,
  // Publishing a finished run as a pull request.
  /^\/api\/runs\/[^/]+\/publish$/,
];

/** Whether this request is a write only an owner or admin may make. */
export function managersOnly(method: string, pathname: string): boolean {
  if (method === "GET" || method === "HEAD") return false;
  return !(method === "POST" && MEMBER_WRITES.some((pattern) => pattern.test(pathname)));
}

/** Whether somebody holding `role` may make this request. Null is no membership. */
export function writeAllowed(
  method: string,
  pathname: string,
  role: OrganizationRole | null,
): boolean {
  if (!managersOnly(method, pathname)) return true;
  return role === "owner" || role === "admin";
}
