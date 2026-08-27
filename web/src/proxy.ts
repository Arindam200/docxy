import { getSessionCookie } from "better-auth/cookies";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Optimistic gate on /dashboard.
 *
 * This only checks that a session cookie is present — it does not validate it,
 * and deliberately so: the proxy runs on every navigation and a database round
 * trip here would tax each one. The authoritative check is `getSessionUser` in
 * the dashboard layout, which is what actually decides whether anything
 * renders. All this does is keep anonymous visitors out of the shell and point
 * them at sign-in.
 *
 * Set DOCXY_REQUIRE_AUTH=0 to open the dashboard without signing in, which is
 * how the demo runs.
 */
export async function proxy(request: NextRequest) {
  if (process.env.DOCXY_REQUIRE_AUTH === "0") {
    return NextResponse.next();
  }

  if (!getSessionCookie(request)) {
    const login = new URL("/login", request.url);
    login.searchParams.set("next", request.nextUrl.pathname);
    return NextResponse.redirect(login);
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/dashboard/:path*"],
};
