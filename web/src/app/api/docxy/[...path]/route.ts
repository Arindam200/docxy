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

async function forward(request: NextRequest, method: string): Promise<Response> {
  if (authRequired()) {
    const user = await getSessionUser(request.headers).catch(() => null);
    if (!user) {
      return Response.json({ error: "Sign in to use the docxy API." }, { status: 401 });
    }
  }

  const path = request.nextUrl.pathname.replace(/^\/api\/docxy/, "") + request.nextUrl.search;
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await request.arrayBuffer();

  try {
    const upstream = await fetch(`${BASE}${path}`, {
      method,
      headers: { "content-type": "application/json" },
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
