/**
 * Which repositories a push may start a run for.
 *
 * Three separate questions, asked in the order a person would ask them.
 *
 * *Did anybody ask for this repository to be documented?* That is a project,
 * and it is the decisive one. Installing the GitHub App is an access grant -
 * the screen offers *All repositories* precisely because narrowing it there is
 * awkward - and treating that grant as intent means clicking "All" signs every
 * repository an account owns up for pull requests nobody asked for. Access and
 * intent are separate, and the projects table is where intent is recorded: one
 * project documents one repository, connected deliberately.
 *
 * *Has an operator narrowed the deployment further?* `DOCXY_ALLOWED_REPOS`,
 * checked first so its refusals name the variable rather than sending somebody
 * to look for a project that exists.
 *
 * *Can the App see it at all?* The installation listing, which is a sanity
 * check rather than the boundary: the webhook secret belongs to the App, not to
 * a repository, so every installation of it produces deliveries that pass the
 * HMAC. Token minting is already scoped to one installation, so a foreign
 * repository could never be cloned - but it would be queued, counted, and
 * reported as a failed run, which is a confusing way to learn that somebody
 * else installed your App.
 */
export interface DeliveryScope {
  /**
   * `owner/repo` for every repository the App installation can see, or null
   * when GitHub would not say. Null and empty are both "unverifiable" - see
   * below - rather than "installed nowhere".
   */
  installed: string[] | null;
  /**
   * `owner/repo` for every project connected on this deployment, or null when
   * the deployment stores state in `.docxy/` and has no projects at all.
   *
   * Null and empty are emphatically *not* the same here. Empty means the
   * database answered and nobody has connected anything, which is a reason to
   * run nothing; null means this deployment has no such concept and the
   * installation is the only answer available.
   */
  connected: string[] | null;
  /** `DOCXY_ALLOWED_REPOS`, the optional operator narrowing. Empty is "all". */
  fromEnv: string[];
}

export function deliveryAllowed(
  scope: DeliveryScope,
  repository: string,
): { ok: true } | { ok: false; reason: string } {
  const name = repository.trim().toLowerCase();

  // The operator's own explicit list, checked first: when it refuses a
  // repository the reason should name the variable rather than send somebody
  // to connect a project that would still never run.
  if (scope.fromEnv.length > 0 && !scope.fromEnv.includes(name)) {
    return { ok: false, reason: `${repository} is not in DOCXY_ALLOWED_REPOS` };
  }

  // The one that stops an "All repositories" install from documenting
  // everything. Null skips it; an empty list refuses.
  if (scope.connected && !scope.connected.includes(name)) {
    return {
      ok: false,
      reason: `${repository} is not connected to a project, so nothing is watching it`,
    };
  }

  // `null` is "GitHub would not answer", and an empty list is treated the same
  // way rather than as "installed nowhere" - a delivery only exists because an
  // installation produced it, so an empty listing is a stale cache or an
  // outage, not a fact. Refusing on either would stop a working pipeline for
  // the duration of somebody else's incident; the installation-scoped token is
  // the guardrail that still holds either way.
  if (!scope.installed || scope.installed.length === 0) return { ok: true };

  return scope.installed.includes(name)
    ? { ok: true }
    : {
        ok: false,
        reason: `the GitHub App is not installed on ${repository}`,
      };
}
