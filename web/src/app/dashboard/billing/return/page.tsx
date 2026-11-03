/**
 * Where hosted checkout sends somebody back to.
 *
 * The query string is read for one purpose only: choosing what the page says
 * first. Dodo does not document what it appends here, and a redirect arrives
 * before the webhook that proves a payment cleared, so nothing is granted on
 * the strength of it. The plan held when this page loads is passed to the
 * client, which polls until this deployment's own records disagree with it.
 */

import { headers } from "next/headers";
import { redirectOutcome } from "@billing/lifecycle";
import { getSessionUser } from "@/lib/auth";
import { resolveEntitlement } from "@/lib/billing/accounts";
import { attemptPlan } from "@/lib/billing/checkout";
import { activeOrganizationId } from "@/lib/organization";
import { Page, PageHead } from "@/components/dashboard/Page";
import { BillingReturn } from "@/components/dashboard/BillingReturn";

export const dynamic = "force-dynamic";

export default async function BillingReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [organizationId, user, params] = await Promise.all([
    activeOrganizationId(),
    getSessionUser(await headers()),
    searchParams,
  ]);

  // Read generously: the parameter Dodo uses is not documented, and a checkout
  // that succeeded must not read as unknown because the key was `state`.
  const reported = first(params.status) ?? first(params.state) ?? first(params.payment_status);
  const outcome = redirectOutcome(reported);

  const entitlement = user ? await resolveEntitlement(organizationId, user.id) : null;
  const attemptId = first(params.attempt);
  const targetPlan =
    entitlement && attemptId ? await attemptPlan(entitlement.account.id, attemptId) : null;

  return (
    <Page>
      <PageHead title="Checkout" lede="Confirming what Dodo has told us about this payment." />
      <BillingReturn outcome={outcome} startingPlan={entitlement?.plan ?? "free"} targetPlan={targetPlan} />
    </Page>
  );
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
