import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { appConfigured, authorizeUrl, installUrl, oauthConfigured, type InstallerVerdict } from "./github-app";
import type { OrganizationRole } from "./members";

const COOKIE = "docxy-github-install";
const MAX_AGE = 10 * 60;

interface Flow {
  state: string;
  userId: string;
  organizationId: string;
  installationId?: string;
  expiresAt: number;
}

function sign(payload: string) {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error("BETTER_AUTH_SECRET is required for GitHub installation");
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function readFlow(request: NextRequest): Flow | null {
  const value = request.cookies.get(COOKIE)?.value;
  if (!value) return null;
  try {
    const [payload, signature, extra] = value.split(".");
    if (!payload || !signature || extra) return null;
    const expected = Buffer.from(sign(payload));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    const flow: Flow = JSON.parse(Buffer.from(payload, "base64url").toString());
    return flow.expiresAt > Date.now() ? flow : null;
  } catch {
    return null;
  }
}

function redirect(request: NextRequest, destination: string) {
  const response = NextResponse.redirect(new URL(destination, request.nextUrl), 302);
  response.cookies.set(COOKIE, "", { path: "/api/github", maxAge: 0 });
  response.headers.set("Cache-Control", "no-store");
  return response;
}

function begin(request: NextRequest, userId: string, organizationId: string, installationId?: string) {
  const flow: Flow = {
    state: randomBytes(32).toString("base64url"),
    userId,
    organizationId,
    expiresAt: Date.now() + MAX_AGE * 1000,
  };
  // Added only when there is one, rather than spread in conditionally. The flow
  // is signed and read back as JSON, and an `installationId: undefined` key is
  // the difference between "no installation named yet" and one the callback
  // would compare against.
  if (installationId) flow.installationId = installationId;
  const callback = new URL("/api/github/callback", request.nextUrl.origin).toString();
  const response = redirect(request, installationId ? authorizeUrl(flow.state, callback) : installUrl(flow.state));
  const payload = Buffer.from(JSON.stringify(flow)).toString("base64url");
  response.cookies.set(COOKIE, `${payload}.${sign(payload)}`, {
    path: "/api/github", httpOnly: true, sameSite: "lax",
    secure: request.nextUrl.protocol === "https:", maxAge: MAX_AGE,
  });
  return response;
}

/** A positive integer, which is all an installation id ever is. */
const INSTALLATION_ID = /^[1-9]\d*$/;

/**
 * An installation id from a URL, or undefined if it is not one.
 *
 * Only ever a hint about which installation to verify: the callback checks it
 * against GitHub with the person's own OAuth token before anything is bound.
 */
export function installationIdParam(value: string | null | undefined): string | undefined {
  return value && INSTALLATION_ID.test(value) ? value : undefined;
}

/**
 * Where a signed-out return from GitHub goes: to sign-in, and back here after.
 *
 * Installing from GitHub's own Marketplace or settings page sends the browser
 * straight to the setup URL, whoever is signed in to Docxy - often nobody. That
 * used to drop the installation id on the way to the login page, leaving an App
 * installed on GitHub that nothing here knew about. Coming back to the setup
 * URL with only the id starts OAuth afresh, which is the same untrusted-id path
 * every GitHub-initiated install takes, so nothing about the id is trusted for
 * having survived the detour.
 *
 * An owner-approval request or a cancelled install has nothing to resume.
 */
function signInFirst(params: URLSearchParams): string {
  const id = params.get("installation_id");
  if (!id || !INSTALLATION_ID.test(id) || params.get("setup_action") === "request" || params.has("error")) {
    return "/login?next=/dashboard";
  }
  const resume = `/api/github/installed?installation_id=${id}`;
  return `/login?next=${encodeURIComponent(resume)}`;
}

/** Owners and admins connect repositories; see lib/proxy-access.ts for the rest. */
function managesOrganization(role: OrganizationRole | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * An installation this flow has verified against GitHub, ready to be claimed.
 *
 * `accountLogin` is required here, unlike the dashboard's own binding type: by
 * the time anything reaches `bind` the OAuth exchange has named the account
 * that performed the install, and that is the whole reason the exchange
 * happens.
 */
export interface VerifiedInstallation {
  installationId: string;
  organizationId: string;
  accountLogin: string;
}

interface Dependencies {
  getUser(headers: Headers): Promise<{ id: string } | null>;
  getOrganization(headers: Headers): Promise<string | null>;
  /**
   * The caller's role in the organization, or null. Binding an installation
   * decides which repositories an organization can connect, which is an
   * owner's or admin's call - the same line the proxy draws for connecting one.
   */
  getRole(userId: string, organizationId: string): Promise<OrganizationRole | null>;
  /** Exchange the OAuth code and decide whether its holder administers `installationId`. */
  authorize(code: string, installationId: string): Promise<InstallerVerdict>;
  /**
   * Claim the installation, or throw. Nothing reads a return value - the
   * handler branches on the failure, not on the result - so this promises
   * nothing rather than promising `unknown` and inviting somebody to inspect
   * whatever the dependency happened to return.
   */
  bind(installation: VerifiedInstallation): Promise<void>;
}

/** Both GitHub return URLs use the same verified installation flow. */
export function githubInstallationHandlers(deps: Dependencies) {
  return {
    async install(request: NextRequest) {
      const user = await deps.getUser(request.headers).catch(() => null);
      if (!user) return redirect(request, "/login?next=/onboarding");
      if (!appConfigured()) return redirect(request, "/dashboard?error=app_unconfigured");
      if (!oauthConfigured()) return redirect(request, "/dashboard?error=install_unverifiable");
      const organizationId = await deps.getOrganization(request.headers);
      const requested = request.nextUrl.searchParams.get("organizationId");
      if (!organizationId || (requested && requested !== organizationId)) return redirect(request, "/onboarding");
      if (!managesOrganization(await deps.getRole(user.id, organizationId))) {
        return redirect(request, "/dashboard?error=install_role");
      }
      // Present when somebody installed the App before they had an
      // organization to bind it to, and has just made one: straight to
      // verifying that installation rather than sending them to install again.
      const resume = installationIdParam(request.nextUrl.searchParams.get("installation_id"));
      return begin(request, user.id, organizationId, resume);
    },

    async callback(request: NextRequest) {
      const params = request.nextUrl.searchParams;
      const user = await deps.getUser(request.headers).catch(() => null);
      if (!user) return redirect(request, signInFirst(params));
      const organizationId = await deps.getOrganization(request.headers);
      if (!organizationId) {
        // Somebody new installs from GitHub before creating an organization.
        // Onboarding carries the id through to the install step afterwards,
        // which used to drop it and send them to install the App again.
        const pending = params.get("setup_action") === "request" || params.has("error")
          ? undefined
          : installationIdParam(params.get("installation_id"));
        return redirect(request, pending ? `/onboarding?installation_id=${pending}` : "/onboarding");
      }
      if (params.get("setup_action") === "request") return redirect(request, "/dashboard?github=requested");
      if (params.has("error")) return redirect(request, "/dashboard?error=install_cancelled");
      // Before any OAuth round trip, so a member is told why at once rather
      // than after authorizing with GitHub for nothing.
      if (!managesOrganization(await deps.getRole(user.id, organizationId))) {
        return redirect(request, "/dashboard?error=install_role");
      }

      const flow = readFlow(request);
      const state = params.get("state");
      // Never move an installation into a different organization after a tab
      // switch, or accept another browser's OAuth response.
      if (flow && (flow.userId !== user.id || flow.organizationId !== organizationId || flow.state !== state)) {
        return redirect(request, "/dashboard?error=install_expired");
      }
      const incomingId = params.get("installation_id");
      if (incomingId && flow?.installationId && incomingId !== flow.installationId) {
        return redirect(request, "/dashboard?error=install_forbidden");
      }
      const installationId = flow?.installationId ?? incomingId;
      if (!installationId || !INSTALLATION_ID.test(installationId)) return redirect(request, "/dashboard?error=no_installation");
      if (!oauthConfigured()) return redirect(request, "/dashboard?error=install_unverifiable");

      const code = params.get("code");
      if (!code) {
        // GitHub setup/update redirects may have no code (or no state when
        // initiated on GitHub). Start OAuth; the query id is still untrusted.
        return begin(request, user.id, organizationId, installationId);
      }
      if (!flow) return redirect(request, "/dashboard?error=install_expired");

      const verdict = await deps.authorize(code, installationId);
      if (verdict.kind === "membership-hidden") {
        return redirect(request, "/dashboard?error=install_membership_hidden");
      }
      if (verdict.kind !== "administers") {
        return redirect(request, "/dashboard?error=install_forbidden");
      }
      try {
        // The account the installation is on, which owns the repositories. The
        // installer's own login was stored here before, so an App installed on
        // a GitHub organization claimed that person's repositories instead of
        // the organization's - and none of the organization's ever appeared.
        await deps.bind({ installationId, organizationId, accountLogin: verdict.accountLogin });
      } catch (cause) {
        const taken = cause instanceof Error && cause.message.includes("already bound");
        return redirect(request, `/dashboard?error=${taken ? "install_owned" : "install_not_bound"}`);
      }
      return redirect(request, "/dashboard/repositories?github=installed");
    },
  };
}
