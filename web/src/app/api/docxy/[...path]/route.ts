import type { NextRequest } from "next/server";
import { authRequired, getSessionUser, operatorVerdict } from "@/lib/auth";
import { apiHeaders } from "@/lib/docxy";
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

async function forward(request: NextRequest, method: string): Promise<Response> {
  if (authRequired()) {
    // Sign-in is required but cannot be performed: the deployment is missing
    // DATABASE_URL or BETTER_AUTH_SECRET. Refusing is the only safe reading —
    // forwarding would hand the privileged API token to an unauthenticated
    // caller, which is worse than the outage this reports.
    if (!authReady()) {
      return Response.json(
        {
          error:
            "This deployment cannot authenticate anyone yet: DATABASE_URL and " +
            "BETTER_AUTH_SECRET must both be set. Set DOCXY_REQUIRE_AUTH=0 only if " +
            "you intend this dashboard to be open.",
        },
        { status: 503 },
      );
    }

    const user = await getSessionUser(request.headers).catch(() => null);
    switch (operatorVerdict(user)) {
      case "unauthenticated":
        return Response.json({ error: "Sign in to use the docxy API." }, { status: 401 });
      case "not-configured":
        return Response.json(
          {
            error:
              "No operators are configured. Set DOCXY_ALLOWED_EMAILS to the addresses " +
              "allowed to use this dashboard.",
          },
          { status: 403 },
        );
      case "not-an-operator":
        return Response.json(
          { error: "This account is not an operator on this deployment." },
          { status: 403 },
        );
      case "ok":
        break;
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
    const upstream = await fetch(`${BASE}${path}`, {
      method,
      headers: apiHeaders({ "content-type": "application/json" }),
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
