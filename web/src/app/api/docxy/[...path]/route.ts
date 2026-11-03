import type { NextRequest } from "next/server";
import { authRequired, getMemberOrganizationId, getSessionUser } from "@/lib/auth";
import { apiHeaders } from "@/lib/docxy";
import { authReady } from "@/lib/env";
import { getViewerRole } from "@/lib/members-store";
import { ORGANIZATION_HEADER, STALE_ORGANIZATION, staleWrite } from "@/lib/organization-guard";
import { MANAGERS_ONLY, managersOnly, writeAllowed } from "@/lib/proxy-access";

/**
 * Backend-for-frontend pass-through to the docxy API server (Hono, port 4317).
 * The dashboard never talks to it directly: no CORS surface, and the API host
 * stays configurable per environment.
 *
 * Every request is authenticated. The proxy's cookie gate covers /dashboard
 * pages but not this route, and the endpoints behind it approve runs and open
 * pull requests - so the check happens here, against the database, rather than
 * being inherited from the page that called it.
 */

const BASE = process.env.DOCXY_API_URL || "http://localhost:4317";

/**
 * The live feed, which is the one upstream path this proxy does not treat as a
 * request/response pair.
 */
const STREAM = "/api/events";

/**
 * How long one stream is allowed to stay open, in seconds.
 *
 * Two limits meet here and both are real. A serverless invocation is killed at
 * `maxDuration`, and 60 seconds is the figure available on every plan this
 * dashboard might be deployed on - higher ceilings exist and are worth using
 * where they are actually configured, which is why both this and `maxDuration`
 * below are meant to be raised together rather than guessed at. The other limit
 * is authorization: the scope of a stream is decided when it opens, so a stream
 * that never ends is a membership check that never happens again. Closing on a
 * known cadence is what makes revoking somebody take effect.
 *
 * `EventSource` reconnects on its own when the server closes the body, so a
 * bounded lifetime costs a reconnect rather than a gap: the client refreshes on
 * reconnection when the gap was long or the feed was busy, which is when it
 * could have missed something - see `refreshOnOpen` in lib/live-updates.ts.
 */
const STREAM_SECONDS = Number(process.env.DOCXY_STREAM_SECONDS ?? 55);

/**
 * The invocation ceiling this route asks its platform for.
 *
 * Kept above STREAM_SECONDS so the stream closes itself in an orderly way,
 * flushing its own end, instead of being cut off mid-event by the platform.
 */
export const maxDuration = 60;

/**
 * How long an ordinary read may take upstream before this answers for it.
 *
 * Reads are listings and records, and one that has not come back in ten
 * seconds is a pipeline that is down rather than one that is busy.
 */
const READ_TIMEOUT_MS = 10_000;

/**
 * How long a write may take upstream.
 *
 * Writes are not reads that happen to change something. Connecting a project
 * clones its repository, and publishing a run opens a pull request through
 * GitHub's API - both of which routinely outlast ten seconds, and a timeout
 * here does not stop the pipeline finishing the work. It only tells the browser
 * the work failed, so it retries, and the second attempt finds the project
 * already connected or the pull request already open.
 *
 * Five seconds under `maxDuration`, so that a write that really is stuck gets
 * this route's own 502 rather than the platform's cut-off.
 */
const WRITE_TIMEOUT_MS = (maxDuration - 5) * 1000;

/**
 * Upstream paths whose data belongs to one organization.
 *
 * The pipeline has no session. It authenticates this proxy with a shared token
 * and takes `organizationId` as a parameter because it has no other way to know
 * one - which makes this proxy the only place a tenant can be established.
 * Forwarding the browser's own value therefore turned the tenant into a request
 * parameter: a signed-in operator could name somebody else's organization and
 * read, create, or delete inside it.
 *
 * The id is now taken from the session, confirmed against the member table,
 * and written over whatever arrived in the query. The browser may still send
 * one there; it simply does not count. A write must also say which organization
 * its page was rendered for - see `lib/organization-guard.ts` - and that may
 * refuse the write, but it never chooses the tenant either.
 *
 * Note what that does *not* cover. Only the query string is rewritten - request
 * bodies are forwarded byte for byte - so an upstream endpoint that reads the
 * tenant from its body reads whatever the browser wrote. `POST /api/installations`
 * did exactly that and could be pointed at any organization. Upstream now takes
 * the tenant from the query everywhere, and that is a rule the API has to keep,
 * not something this proxy can enforce on its behalf.
 */
const ORGANIZATION_SCOPED = [
  "/api/projects",
  "/api/installations",
  // `/api/events` belongs on this list by rights - it carries the same run data
  // as /api/runs, pushed rather than polled - and is deliberately not on it:
  // `openStream` below handles that path in full and applies a stricter check
  // than this one, so an entry here would never be reached. Anything that
  // removes that branch has to put this line back.
  // Everything below reads or writes work product: the runs themselves, the
  // role events behind them, the aggregates over them, the repository list, and
  // the house style the drafting roles follow. Each was deployment-wide until
  // registration opened, which was survivable only while the operator allowlist
  // meant every account belonged to the same person.
  "/api/runs",
  "/api/logs",
  "/api/observability",
  "/api/repositories",
  "/api/instructions",
];

function organizationScoped(pathname: string): boolean {
  return ORGANIZATION_SCOPED.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/**
 * Upstream writes the browser may not make at all.
 *
 * Binding a GitHub App installation says "this installation belongs to this
 * organization", and the check that makes it safe is not a session: it is the
 * OAuth code GitHub issues to whoever performed the install, which
 * /api/github/callback exchanges and verifies before binding anything. That
 * route calls the pipeline directly and never passes through here.
 *
 * So nothing legitimate reaches this endpoint through the proxy, and the only
 * thing that would is a browser trying to claim an installation without the
 * proof. Refused here as well as upstream, because one check is a check and two
 * are a boundary.
 */
const BROWSER_MAY_NOT_WRITE = ["/api/installations"];

/**
 * Hold a live feed open for one organization.
 *
 * Everything else here is a JSON request/response pair, and the differences are
 * all consequences of that. The ten-second timeout is gone, because it would
 * cut every stream at ten seconds; the body is handed back untouched rather
 * than re-read, because there is no end to read to; the client's disconnect has
 * to reach upstream, or the pipeline keeps writing into a socket nobody is
 * holding; and the lifetime is bounded on purpose, because a connection that
 * never ends is a permission that is never re-checked.
 *
 * The membership check is the same one every proxied request makes now - the
 * session's `activeOrganizationId` is written once and outlives a removal, so
 * the member table is asked each time. What differs is how often "each time"
 * comes round: a request asks once and is over, and a stream asks once and then
 * stays open, which is why its lifetime is bounded.
 */
async function openStream(request: NextRequest): Promise<Response> {
  const search = new URLSearchParams(request.nextUrl.search);

  if (authRequired()) {
    const organizationId = await getMemberOrganizationId(request.headers).catch(() => null);
    if (!organizationId) {
      // Covers both "never had one" and "no longer a member of the one the
      // session names". A revoked account reaches this on its next reconnect,
      // which is what bounding the lifetime above is for.
      return Response.json(
        { error: "No active organization membership. The live feed is closed." },
        { status: 403 },
      );
    }
    search.set("organizationId", organizationId);
  }

  // Whichever comes first: the browser navigating away, or this route's own
  // lifetime bound. Either one has to reach upstream so the pipeline drops its
  // subscriber rather than writing into a dead socket.
  const closing = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(Math.max(1, STREAM_SECONDS) * 1000),
  ]);

  let upstream: Response;
  try {
    upstream = await fetch(`${BASE}${STREAM}?${search.toString()}`, {
      headers: apiHeaders({ accept: "text/event-stream" }),
      cache: "no-store",
      signal: closing,
    });
  } catch {
    return Response.json({ error: "Docxy API is unreachable." }, { status: 502 });
  }

  // A refusal upstream is JSON, not events, and passing it through as a stream
  // would leave the browser reconnecting against a body that never arrives.
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return new Response(detail || JSON.stringify({ error: "The live feed is unavailable." }), {
      status: upstream.ok ? 502 : upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "text/event-stream",
      // `no-transform` as well as `no-cache`: a proxy that compresses or
      // rewrites the body on the way through is free to buffer it, and a
      // buffered stream arrives all at once at the end.
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

async function forward(request: NextRequest, method: string): Promise<Response> {
  // Who is asking, once sign-in has said so. Null when this deployment runs
  // without sign-in, where there are no organizations and so no roles.
  let userId: string | null = null;
  if (authRequired()) {
    // Sign-in is required but cannot be performed: the deployment is missing
    // DATABASE_URL or BETTER_AUTH_SECRET. Refusing is the only safe reading -
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

    /*
     * Signing in is the whole check at this step.
     *
     * It used to also require membership of a deployment-wide operator
     * allowlist, which was the only thing keeping one account out of another's
     * data - and which made the product unusable by anyone who signed up. The
     * boundary moved down instead: every route that carries work product is
     * organization-scoped below, so being signed in gets a caller as far as
     * their own organization and no further - and a write that reshapes that
     * organization further asks for an owner or admin.
     */
    const user = await getSessionUser(request.headers).catch(() => null);
    if (!user) {
      return Response.json({ error: "Sign in to use the docxy API." }, { status: 401 });
    }
    userId = user.id;
  }

  // `/api/docxy/<x>` maps to the pipeline's `/api/<x>`, not to `/<x>`.
  //
  // Stripping the whole prefix dropped the upstream `/api` along with it, so
  // every call through this proxy was forwarded one segment short of the route
  // it wanted - `/api/docxy/instructions` reached the server as
  // `/instructions`, which does not exist. Saving standing instructions from
  // the dashboard has therefore never worked; it 404'd behind an error toast.
  const pathname = request.nextUrl.pathname.replace(/^\/api\/docxy/, "/api");

  // Every check below compares this string, and upstream routes on its decoded
  // form. `%72uns` is not `/api/runs` to `organizationScoped` but is to Hono, so
  // a percent-escape, a dot segment or an empty segment would let a caller name
  // an organization-scoped route without the proxy noticing. Upstream ids are
  // UUIDs; nothing legitimate needs any of those characters.
  if (!/^\/api(\/[A-Za-z0-9_-]+)*$/.test(pathname)) {
    return Response.json({ error: "Not a docxy API path." }, { status: 400 });
  }

  if (method !== "GET" && method !== "HEAD" && BROWSER_MAY_NOT_WRITE.includes(pathname)) {
    return Response.json(
      {
        error:
          "Installations are bound by the GitHub install flow, which verifies the " +
          "installation with GitHub first. Install the app from the dashboard.",
      },
      { status: 403 },
    );
  }

  if (pathname === STREAM) {
    if (method !== "GET") {
      return Response.json({ error: "The event stream is read-only." }, { status: 405 });
    }
    return openStream(request);
  }

  let path = pathname + request.nextUrl.search;
  const body = method === "GET" || method === "HEAD" ? undefined : await request.arrayBuffer();

  // The tenant is decided here or not at all - see ORGANIZATION_SCOPED above.
  if (organizationScoped(pathname)) {
    // Confirmed against the member table rather than read off the session: a
    // removed member's session goes on naming the organization for as long as
    // it lives, and this is the only thing standing between that session and
    // the organization's runs.
    const organizationId = await getMemberOrganizationId(request.headers).catch(() => null);
    if (!organizationId) {
      return Response.json(
        { error: "No active organization membership. Create or join one to use the dashboard." },
        { status: 403 },
      );
    }

    // A stale tab, not an intruder: the session moved to another organization
    // after this page was drawn. Refused rather than written, because the
    // session's organization is not the one the person was looking at.
    if (staleWrite(method, request.headers.get(ORGANIZATION_HEADER), organizationId)) {
      return Response.json({ error: STALE_ORGANIZATION }, { status: 409 });
    }

    // Membership gets a caller into the organization; it does not let them
    // reshape it. Asked only of writes that need it, so reads and runs cost
    // no extra query - see lib/proxy-access.ts for which writes those are.
    if (managersOnly(method, pathname)) {
      const role = userId ? await getViewerRole(organizationId, userId).catch(() => null) : null;
      if (!writeAllowed(method, pathname, role)) {
        return Response.json({ error: MANAGERS_ONLY }, { status: 403 });
      }
    }

    // The query string is the one place the tenant travels, for reads and
    // writes alike, and it is overwritten rather than defaulted. Upstream reads
    // it from here and ignores any copy in the body, so a browser that sends
    // one is simply sending a field nobody consults.
    const search = new URLSearchParams(request.nextUrl.search);
    search.set("organizationId", organizationId);
    path = `${pathname}?${search.toString()}`;
  }

  try {
    // The upstream API authenticates the proxy itself, not the end user: it has
    // no session of its own and no way to read one. This is the credential that
    // stops anyone who can route to the API from skipping the sign-in above.
    const upstream = await fetch(`${BASE}${path}`, {
      method,
      headers: apiHeaders({ "content-type": "application/json" }),
      body: body?.byteLength ? body : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(
        method === "GET" || method === "HEAD" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS,
      ),
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

export async function DELETE(request: NextRequest) {
  return forward(request, "DELETE");
}
