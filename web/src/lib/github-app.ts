/**
 * The GitHub App install flow, from the dashboard's side.
 *
 * Installing the App is the act that connects a repository, so it is also the
 * last step of onboarding. GitHub brings the installer back to us afterwards -
 * see the Setup URL and Redirect URI on the App's settings page - and these
 * helpers are what build the outbound link and read the return trip.
 */

/** The App's public slug, e.g. `docxy-bot`. Not a secret. */
export function appSlug(): string {
  return process.env.GITHUB_APP_SLUG?.trim() || "docxy-bot";
}

export function appConfigured(): boolean {
  return Boolean(process.env.GITHUB_APP_SLUG?.trim());
}

/**
 * Where to send somebody to install the App.
 *
 * `state` comes back verbatim on the return trip. It carries the organization
 * the installation should be bound to, because GitHub's redirect otherwise says
 * only that *an* installation happened - and a person can belong to several
 * organizations, so "the active one when they get back" is a guess that is
 * wrong exactly when somebody switches tabs mid-flow.
 */
export function installUrl(state: string): string {
  const url = new URL(`https://github.com/apps/${appSlug()}/installations/new`);
  url.searchParams.set("state", state);
  return url.toString();
}

/** The App's OAuth credentials - its own, not the sign-in provider's. */
export function oauthConfigured(): boolean {
  return Boolean(
    process.env.GITHUB_APP_CLIENT_ID?.trim() && process.env.GITHUB_APP_CLIENT_SECRET?.trim(),
  );
}

/** Where to send somebody to authorize the App and come back with a `code`. */
export function authorizeUrl(state: string, redirectUri: string): string {
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", process.env.GITHUB_APP_CLIENT_ID?.trim() ?? "");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface Installer {
  login: string;
  /** Every installation this account may administer, per GitHub. */
  installationIds: string[];
}

/**
 * Who performed an install, and what they are actually allowed to bind.
 *
 * This is an authorization check, not a lookup, and the distinction is the
 * whole point. An earlier version treated the installation id on the query
 * string as trustworthy because the request carried a valid session - but a
 * session proves who the caller is, never that they control the installation
 * they named. Installation ids are small integers, so anyone with an account
 * could have claimed somebody else's and had that repository's pushes, diffs
 * and drafted documentation attributed to their own organization.
 *
 * `GET /user/installations` is GitHub's own answer to "which installations may
 * this person administer". Requiring the incoming id to appear in it is what
 * makes the binding safe.
 *
 * Returns null on any failure, and null must be treated as a refusal - never as
 * "identity unknown, proceed anyway".
 */
export async function authorizeInstaller(code: string): Promise<Installer | null> {
  if (!oauthConfigured()) return null;

  try {
    const token = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_APP_CLIENT_ID,
        client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
        code,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!token.ok) return null;

    // SAFETY: GitHub returns JSON carrying `access_token` on success and an
    // `error` field on failure. It is read as optional and the guard below
    // rejects anything without it, so an unexpected shape fails closed.
    const payload = (await token.json()) as { access_token?: string };
    if (!payload.access_token) return null;

    const accessToken = payload.access_token;
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
    };

    const who = await fetch("https://api.github.com/user", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!who.ok) return null;

    // SAFETY: as above - `login` is optional here and a response without it is
    // rejected rather than half-trusted.
    const user = (await who.json()) as { login?: string };
    if (!user.login) return null;

    // What this account may administer, straight from GitHub. Paginated, and a
    // person can legitimately have more than thirty installations.
    const installationIds: string[] = [];
    for (let page = 1; page <= 10; page += 1) {
      const res = await fetch(
        `https://api.github.com/user/installations?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return null;

      // SAFETY: the documented shape is `{ installations: [{ id }] }`. Ids are
      // filtered to those actually present, so a missing or malformed entry
      // narrows what the caller may bind rather than widening it.
      const body = (await res.json()) as { installations?: Array<{ id?: number }> };
      const batch = body.installations ?? [];
      for (const item of batch) {
        // Parsed, not probed: an entry that does not carry a positive integer
        // id is dropped, which narrows what the caller may bind.
        const id = Number(item.id);
        if (Number.isSafeInteger(id) && id > 0) installationIds.push(String(id));
      }
      if (batch.length < 100) break;
    }

    return { login: user.login, installationIds };
  } catch {
    return null;
  }
}
