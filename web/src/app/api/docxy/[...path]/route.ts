import type { NextRequest } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { authReady } from "@/lib/env";

/**
 * Backend-for-frontend pass-through to the docxy API server (Hono, port 4317).
 * The dashboard never talks to it directly: no CORS surface, and the API host
 * stays configurable per environment.
 *
 * Every request is authenticated. The proxy's cookie gate covers /dashboard
 * pages but not this route, and the endpoints behind it approve runs and open
 * pull requests — so the check happens here, against the database, rather than
 * being inherited from the page that called it.
 */

const BASE = process.env.DOCXY_API_URL || "http://localhost:4317";

/** Mirrors the dashboard's own escape hatch, so the demo keeps working. */
function authRequired(): boolean {
  return process.env.DOCXY_REQUIRE_AUTH !== "0" && authReady();
}

/**
 * The addresses allowed to operate this deployment.
 *
 * Registration is open — email and password, no verification step — so a
 * signed-in user is only proof that somebody completed a signup form, not that
 * they are entitled to approve a pull request. Being signed in and being an
 * operator are two different questions and this answers the second one.
 */
function allowedOperators(): string[] {
  return (process.env.DOCXY_ALLOWED_EMAILS ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

async function forward(request: NextRequest, method: string): Promise<Response> {
  if (authRequired()) {
    const user = await getSessionUser(request.headers).catch(() => null);
    if (!user) {
      return Response.json({ error: "Sign in to use the docxy API." }, { status: 401 });
    }

    // Closed by default. An empty allowlist on a deployment that has auth
    // switched on means nobody has said who the operators are yet — and the
    // safe reading of "unspecified" is nobody, not everybody. The demo path
    // is DOCXY_REQUIRE_AUTH=0, which is explicit about what it gives up.
    const operators = allowedOperators();
    const email = user.email?.trim().toLowerCase();
    if (operators.length === 0) {
      return Response.json(
        {
          error:
            "No operators are configured. Set DOCXY_ALLOWED_EMAILS to the addresses " +
            "allowed to use this dashboard.",
        },
        { status: 403 },
      );
    }
    if (!email || !operators.includes(email)) {
      return Response.json(
        { error: "This account is not an operator on this deployment." },
        { status: 403 },
      );
    }
  }

  // `/api/docxy/<x>` maps to the pipeline's `/api/<x>`, not to `/<x>`.
  //
  // Stripping the whole prefix dropped the upstream `/api` along with it, so
  // every call through this proxy was forwarded one segment short of the route
  // it wanted — `/api/docxy/instructions` reached the server as
  // `/instructions`, which does not exist. Saving standing instructions from
  // the dashboard has therefore never worked; it 404'd behind an error toast.
  const path =
    request.nextUrl.pathname.replace(/^\/api\/docxy/, "/api") + request.nextUrl.search;
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await request.arrayBuffer();

  try {
    // The upstream API authenticates the proxy itself, not the end user: it has
    // no session of its own and no way to read one. This is the credential that
    // stops anyone who can route to the API from skipping the sign-in above.
    const apiToken = process.env.DOCXY_API_TOKEN?.trim();
    const upstream = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(apiToken ? { authorization: `Bearer ${apiToken}` } : {}),
      },
      body: body?.byteLength ? body : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return Response.json({ error: "Docxy API is unreachable." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return forward(request, "GET");
}

export async function POST(request: NextRequest) {
  return forward(request, "POST");
}

export async function PUT(request: NextRequest) {
  return forward(request, "PUT");
}
