/**
 * What this organization's billing currently is.
 *
 * Read by the page somebody lands on after checkout, which polls it until the
 * webhook that confirms the purchase has arrived. That is the whole reason it
 * exists: the redirect says what the browser was told, and this says what this
 * deployment actually believes.
 */

import { type NextRequest, NextResponse } from "next/server";
import { formatUsd, monthlyPriceMinor } from "@billing";
import { getMemberOrganizationId, getSessionUser } from "@/lib/auth";
import { resolveEntitlement } from "@/lib/billing/accounts";
import { remainingRuns } from "@/lib/billing/periods";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getSessionUser(request.headers).catch(() => null);
  if (!user) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const organizationId = await getMemberOrganizationId(request.headers);
  if (!organizationId) {
    return NextResponse.json({ error: "this account has no organization yet" }, { status: 409 });
  }

  const entitlement = await resolveEntitlement(organizationId, user.id);

  return NextResponse.json({
    plan: entitlement.plan,
    price: formatUsd(monthlyPriceMinor(entitlement.plan, entitlement.account.purchasedSeats)),
    seats: entitlement.entitlements.seats,
    repositories: entitlement.entitlements.repositories,
    automaticRuns: entitlement.entitlements.automaticRuns,
    accessState: entitlement.account.accessState,
    accessReason: entitlement.account.accessReason,
    canStartRuns: entitlement.canStartRuns,
    runsAllowed: entitlement.period.runsAllowed,
    runsLeft: remainingRuns(entitlement.period),
    periodEnd: entitlement.period.periodEnd.toISOString(),
    subscription: entitlement.subscription
      ? {
          status: entitlement.subscription.providerStatus,
          // A scheduled end, not a past one: work continues until this date.
          cancelAt: entitlement.subscription.cancelAt?.toISOString() ?? null,
          renewsAt: entitlement.subscription.currentPeriodEnd?.toISOString() ?? null,
        }
      : null,
  });
}
