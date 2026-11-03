/**
 * Billing: what this organization is on, what it has used, and how to change it.
 *
 * Everything shown here comes from this deployment's own records rather than
 * from Dodo, so the page is honest while a webhook is in flight and still
 * renders on a deployment that has no payment credentials at all.
 */

import { headers } from "next/headers";
import Link from "next/link";
import { formatUsd, monthlyPriceMinor, planList } from "@billing";
import { getSessionUser } from "@/lib/auth";
import { resolveEntitlement, isBillingOwner } from "@/lib/billing/accounts";
import { canSell, missingBillingConfig } from "@/lib/billing/config";
import { remainingRuns } from "@/lib/billing/periods";
import { activeOrganizationId } from "@/lib/organization";
import { Page, PageHead } from "@/components/dashboard/Page";
import { BillingPlans, BillingPortalButton, type PlanOption } from "@/components/dashboard/BillingPlans";
import { ToastNotice } from "@/components/dashboard/Toast";

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const [organizationId, user, params] = await Promise.all([
    activeOrganizationId(),
    getSessionUser(await headers()),
    searchParams,
  ]);

  if (!user) {
    return (
      <Page>
        <PageHead title="Billing" />
        <p className="border border-rule bg-surface p-5 text-sm text-muted">
          <Link href="/login?next=/dashboard/billing" className="focus-ring text-accent hover:underline">Sign in</Link> to see this organization&apos;s plan.
        </p>
      </Page>
    );
  }

  const entitlement = await resolveEntitlement(organizationId, user.id);
  const owner = isBillingOwner(entitlement.account, user.id);
  const runsLeft = remainingRuns(entitlement.period);
  const used = entitlement.period.runsAllowed - runsLeft;
  const missing = missingBillingConfig();

  const options: PlanOption[] = planList.map((plan) => ({
    key: plan.key,
    name: plan.name,
    price: formatUsd(monthlyPriceMinor(plan.key)),
    description: plan.description,
    repositories: plan.entitlements.repositories,
    runsPerMonth: plan.entitlements.runsPerMonth,
    automaticRuns: plan.entitlements.automaticRuns,
    available: canSell(plan.key),
    current: plan.key === entitlement.plan,
  }));

  return (
    <Page>
      <ToastNotice
        message={params.checkout === "cancelled" ? "Checkout was cancelled. Nothing was charged." : undefined}
        tone="info"
        parameters={["checkout"]}
      />

      <PageHead
        title="Billing"
        lede="The plan this organization is on, and what it has used this period."
      >
        <BillingPortalButton enabled={owner && Boolean(entitlement.account.dodoCustomerId)} />
      </PageHead>

      <section aria-labelledby="current-heading" className="space-y-3">
        <h2 id="current-heading" className="text-lg font-semibold">This period</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Stat label="Plan" value={planName(entitlement.plan)} note={formatUsd(monthlyPriceMinor(entitlement.plan, entitlement.account.purchasedSeats)) + " / month"} />
          <Stat label="Runs used" value={`${used} of ${entitlement.period.runsAllowed}`} note={runsLeft === 0 ? "No runs left in this period" : `${runsLeft} left`} />
          <Stat label="Resets" value={entitlement.period.periodEnd.toLocaleDateString()} note={entitlement.subscription?.cancelAt ? "Plan ends at the close of this period" : "Allowance refreshes"} />
        </div>

        {entitlement.account.accessReason && (
          <p role="status" className="border border-rule bg-surface p-4 text-sm text-danger">
            {entitlement.account.accessReason}
          </p>
        )}
      </section>

      <section aria-labelledby="plans-heading" className="space-y-3">
        <div>
          <h2 id="plans-heading" className="text-lg font-semibold">Plans</h2>
          <p className="mt-1 text-sm text-muted">
            {owner
              ? "Only you can change the plan for this organization."
              : "Ask the billing owner of this organization to change the plan."}
          </p>
        </div>

        <BillingPlans plans={options} canBuy={owner} />

        {missing.length > 0 && owner && (
          <div className="border border-rule bg-surface p-4 text-sm text-muted">
            <p className="font-medium text-foreground">Payments are not fully configured on this deployment.</p>
            <ul className="mt-2 space-y-1">
              {missing.map((item) => (
                <li key={item.key}>
                  <code className="text-xs">{item.key}</code> — {item.hint}
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </Page>
  );
}

function planName(key: string): string {
  return planList.find((plan) => plan.key === key)?.name ?? key;
}

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="border border-rule bg-surface p-5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-2 text-xl font-semibold">{value}</p>
      <p className="mt-1 text-sm text-muted">{note}</p>
    </div>
  );
}
