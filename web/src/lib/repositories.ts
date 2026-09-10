import type { SyncedRepo } from "@contract";

/**
 * What a repository row on the Repositories page says about itself.
 *
 * Three states rather than two, because the two ways a repository can fail to
 * be watched need opposite things done about them. "Available" is the ordinary
 * case - the App can see it, nobody connected it as a project, and the fix is
 * one click in this dashboard. "Excluded" is the deployment's own
 * `DOCXY_ALLOWED_REPOS`, which no amount of clicking here will change.
 *
 * The distinction only exists because installing the GitHub App is an access
 * grant and not a request: choosing *All repositories* is how most people
 * install one, and it must not read as "document everything I own".
 */
export type RepositoryStatus = "monitored" | "available" | "excluded";

export function repositoryStatus(
  repo: Pick<SyncedRepo, "allowed" | "connected">,
): RepositoryStatus {
  if (repo.allowed) return "monitored";
  // Connected but not allowed leaves exactly one explanation: the operator
  // narrowing. Saying "not connected" there would send somebody to connect a
  // project that already exists.
  return repo.connected ? "excluded" : "available";
}
