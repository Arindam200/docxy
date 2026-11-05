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

/** The GitHub account an installation is on, as `GET /user/installations` lists it. */
export interface InstallationAccount {
  id: number;
  login: string;
  /** `User` or `Organization`. Enterprise installations are neither. */
  type: string;
}

/** The person's membership of an organization, per `GET /user/memberships/orgs/{org}`. */
export interface OrganizationMembership {
  role: string;
  state: string;
}

/**
 * Whether somebody administers the account an installation is on.
 *
 * Being able to *see* an installation is not that. `GET /user/installations`
 * lists every installation the person can reach a repository through, which
 * includes a read-only collaborator on one repository of somebody else's
 * organization. Binding on that alone let such a collaborator claim the whole
 * organization's installation for their own Docxy organization, after which
 * the real owners could only be told it was taken.
 *
 * A personal account is administered by exactly one person, and GitHub ids are
 * compared rather than logins because a login can be renamed and reused. An
 * organization is administered by its owners: an active membership with the
 * `admin` role. Anything else, including an enterprise installation, is not
 * something this flow can confirm, so it is refused.
 */
export function administersAccount(
  account: InstallationAccount,
  userId: number,
  membership: OrganizationMembership | null,
): boolean {
  if (account.type === "User") return account.id === userId;
  if (account.type === "Organization") {
    return membership?.state === "active" && membership.role === "admin";
  }
  return false;
}

/**
 * What the OAuth exchange established about one installation.
 *
 * `administers` carries the account the installation is on, which owns the
 * repositories - not the person who installed it. The pipeline scopes an
 * organization's repositories by owner login, so that is what a binding
 * records. `unverified` covers a failed exchange and an installation the person
 * cannot see at all; `not-admin` is one they can see and do not administer.
 * `membership-hidden` is GitHub declining to say: it answers 403 rather than
 * 404 when the App's token may not read organization membership, or when the
 * organization's SAML single sign-on has not been authorized for it.
 */
export type InstallerVerdict =
  | { kind: "administers"; accountLogin: string }
  | { kind: "unverified" }
  | { kind: "not-admin" }
  | { kind: "membership-hidden" };

/**
 * Whether the person who completed this OAuth exchange may bind
 * `installationId`.
 *
 * This is an authorization check, not a lookup, and the distinction is the
 * whole point. An earlier version treated the installation id on the query
 * string as trustworthy because the request carried a valid session - but a
 * session proves who the caller is, never that they control the installation
 * they named. Installation ids are small integers, so anyone with an account
 * could have claimed somebody else's. The version after that required the id
 * to appear in `GET /user/installations`, which proves access and not
 * control - see `administersAccount`.
 *
 * Every failure is a refusal - never "identity unknown, proceed anyway".
 */
export async function authorizeInstaller(
  code: string,
  installationId: string,
): Promise<InstallerVerdict> {
  const unverified: InstallerVerdict = { kind: "unverified" };
  if (!oauthConfigured()) return unverified;

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
    if (!token.ok) return unverified;

    // SAFETY: GitHub returns JSON carrying `access_token` on success and an
    // `error` field on failure. It is read as optional and the guard below
    // rejects anything without it, so an unexpected shape fails closed.
    const payload = (await token.json()) as { access_token?: string };
    if (!payload.access_token) return unverified;

    const accessToken = payload.access_token;
    const headers = {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
    };

    const who = await fetch("https://api.github.com/user", {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!who.ok) return unverified;

    // SAFETY: as above - both fields are optional here and a response without
    // them is rejected rather than half-trusted.
    const user = (await who.json()) as { id?: number; login?: string };
    const userId = Number(user.id);
    if (!user.login || !Number.isSafeInteger(userId) || userId <= 0) return unverified;

    // The installation, among those this person can reach, straight from
    // GitHub. Paginated, and a person can legitimately have more than thirty.
    let account: InstallationAccount | null = null;
    for (let page = 1; page <= 10 && !account; page += 1) {
      const res = await fetch(
        `https://api.github.com/user/installations?per_page=100&page=${page}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (!res.ok) return unverified;

      // SAFETY: the documented shape is `{ installations: [{ id, account }] }`.
      // Every field is optional here and parsed below, so a missing or
      // malformed entry is skipped - which can only narrow what is bound.
      const body = (await res.json()) as {
        installations?: Array<{
          id?: number;
          account?: { id?: number; login?: string; type?: string } | null;
        }>;
      };
      const batch = body.installations ?? [];
      const match = batch.find((item) => String(Number(item.id)) === installationId);
      if (match) {
        const accountId = Number(match.account?.id);
        const login = match.account?.login?.trim();
        if (!login || !Number.isSafeInteger(accountId)) return unverified;
        account = { id: accountId, login, type: match.account?.type ?? "" };
      }
      if (batch.length < 100) break;
    }
    if (!account) return unverified;

    // A personal account needs no further question; an organization does.
    let membership: OrganizationMembership | null = null;
    if (account.type === "Organization") {
      const res = await fetch(
        `https://api.github.com/user/memberships/orgs/${encodeURIComponent(account.login)}`,
        { headers, signal: AbortSignal.timeout(10_000) },
      );
      if (res.status === 403) return { kind: "membership-hidden" };
      if (res.ok) {
        // SAFETY: both fields are read as optional strings and compared
        // against exact values, so any other shape reads as "not an admin".
        const body = (await res.json()) as { role?: string; state?: string };
        membership = { role: body.role ?? "", state: body.state ?? "" };
      } else if (res.status !== 404) {
        // 404 is GitHub's answer for "not a member", which is a plain no.
        // Anything else is a failure to find out, and is not a yes.
        return unverified;
      }
    }

    return administersAccount(account, userId, membership)
      ? { kind: "administers", accountLogin: account.login }
      : { kind: "not-admin" };
  } catch {
    return unverified;
  }
}
