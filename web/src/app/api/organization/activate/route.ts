import { NextResponse, type NextRequest } from "next/server";

import { getAuth, getSessionUser, getUserOrganizations } from "@/lib/auth";
import { safeNext } from "@/lib/redirect";

/**
 * Point the session at an organization the account actually belongs to.
 *
 * This exists because the session's `activeOrganizationId` and the membership
 * table can disagree, and every other page can only *notice* that - not fix it.
 * The id is stamped onto a session when the session is created, so a session
 * that was signed in before onboarding carries null forever, and one whose
 * organization was left or deleted carries an id that resolves to nothing. Both
 * produce the same symptom: the dashboard sends the account to onboarding,
 * onboarding has no way to write a session, and somebody either bounces between
 * the two or is invited to create a second organization they already have.
 *
 * It is a route handler rather than something the dashboard layout repairs
 * inline because writing the session means setting a cookie, which a Server
 * Component may not do. So the pages decide *that* a repair is needed and send
 * the browser here to have it done.
 *
 * Redirects rather than returning JSON: the only caller is a browser mid-
 * navigation, and the point is to arrive somewhere.
 */
export async function GET(request: NextRequest) {
  const requestHeaders = request.headers;
  const next = safeNext(request.nextUrl.searchParams.get("next") ?? undefined);
  const to = (path: string) => NextResponse.redirect(new URL(path, request.nextUrl), 302);

  const user = await getSessionUser(requestHeaders).catch(() => null);
  if (!user) return to(`/login?next=${encodeURIComponent(next)}`);

  const organizations = await getUserOrganizations(user.id);
  // Nothing to activate. Onboarding is where an account with no membership
  // belongs, and it renders the create form rather than sending them back here.
  if (organizations.length === 0) return to("/onboarding");

  // An explicit choice is honoured only if it is one of theirs - the parameter
  // arrives from a URL and naming somebody else's organization must not move a
  // session into it. Otherwise the first membership, which is the only sensible
  // default and is stable because the listing is ordered.
  const requested = request.nextUrl.searchParams.get("organizationId")?.trim();
  const target = organizations.find((entry) => entry.id === requested) ?? organizations[0];

  try {
    // `nextCookies()` in the auth config is what lets this write the session
    // cookie from a route handler.
    await getAuth().api.setActiveOrganization({
      headers: requestHeaders,
      body: { organizationId: target.id },
    });
  } catch {
    // The account has an organization and the session cannot be told about it.
    // Onboarding says so rather than looping the browser back through here.
    return to("/onboarding?error=activate_failed");
  }

  return to(next);
}
