/**
 * Start hosted checkout for the signed-in organization.
 *
 * The request may say which plan and how many seats. It may not say the price,
 * the product, the customer, or where to return to - all four are derived on
 * the server, because a request that can name its own redirect is an open
 * redirect with a payment attached.
 *
 * Same-origin only. A cross-site form post carrying somebody's session cookie
 * is exactly the shape of a purchase they did not make.
 */

import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { parsePlanKey } from "@billing";
import { getMemberOrganizationId, getSessionUser } from "@/lib/auth";
import { startCheckout } from "@/lib/billing/checkout";
import { billingOrigin } from "@/lib/billing/config";

export async function POST(request: NextRequest): Promise<Response> {
  if (!sameOrigin(request)) {
    return NextResponse.json({ error: "cross-origin request refused" }, { status: 403 });
  }

  const user = await getSessionUser(request.headers).catch(() => null);
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const organizationId = await getMemberOrganizationId(request.headers);
  if (!organizationId) {
    return NextResponse.json({ error: "this account has no organization yet" }, { status: 409 });
  }

  // SAFETY: every field is read through a parser below - `parsePlanKey` for the
  // plan, `seatCount` for the capacity, a length cap for the key - so a body
  // that is not this shape yields undefined fields and a 400, never a purchase.
  const form = (await request.json().catch(() => null)) as CheckoutBody | null;

  const planKey = parsePlanKey(form?.plan);
  if (!planKey) return NextResponse.json({ error: "unknown plan" }, { status: 400 });

  const result = await startCheckout({
    organizationId,
    userId: user.id,
    planKey,
    seats: seatCount(form?.seats),
    // The caller's own idempotency key when it sends one, so a retried request
    // is the same attempt. Otherwise a fresh one: a key derived from the plan
    // would collide with every earlier attempt at that plan - expired, failed
    // or completed - and lock the organization out of buying it again. A
    // double click is collapsed by the one-open-attempt index, not by this.
    requestKey: form?.requestKey?.slice(0, 100) || randomUUID(),
  });

  if (!result.ok) {
    const status =
      result.refusal === "not-owner" ? 403 : result.refusal === "provider-error" ? 502 : 409;
    return NextResponse.json({ error: result.message, refusal: result.refusal }, { status });
  }

  return NextResponse.json({ url: result.url, attemptId: result.attemptId, reused: result.reused });
}

/** What a checkout request may carry. Nothing here is trusted as it arrives. */
interface CheckoutBody {
  plan?: string;
  seats?: number | string;
  requestKey?: string;
}

/**
 * A desired seat capacity as a number, or undefined.
 *
 * Undefined means "the plan's own base package", which is what an absent,
 * empty, or unparseable value should mean. The catalog clamps whatever comes
 * back to a capacity the plan can actually sell.
 */
function seatCount(value: number | string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Whether this request came from this site.
 *
 * `Origin` is set by browsers on every cross-site POST and cannot be forged by
 * page script, which is what makes it the check rather than `Referer`.
 */
function sameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return origin === billingOrigin() || origin === request.nextUrl.origin;
}
