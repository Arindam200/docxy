"use client";

import { useState, useTransition } from "react";
import { LuArrowUpRight, LuLoaderCircle } from "react-icons/lu";
import { useToast } from "@/components/dashboard/Toast";

export interface PlanOption {
  key: string;
  name: string;
  price: string;
  description: string;
  repositories: number;
  runsPerMonth: number;
  automaticRuns: boolean;
  /** Purchasable here: configured, enabled, and not the plan already held. */
  available: boolean;
  current: boolean;
}

/**
 * The plan cards, and the one button that can spend money.
 *
 * Checkout is a POST rather than a link, so a crawler, a prefetch, or a pasted
 * URL cannot open a payment. The server answers with a hosted URL and the
 * browser follows it; nothing about the price travels through this component.
 */
export function BillingPlans({ plans, canBuy }: { plans: PlanOption[]; canBuy: boolean }) {
  const notify = useToast();
  const [pending, startTransition] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);

  const buy = (plan: PlanOption) => {
    setBusy(plan.key);
    startTransition(async () => {
      try {
        const response = await fetch("/api/billing/checkout", {
          method: "POST",
          headers: { "content-type": "application/json" },
          // One key per click: a retry of this request is the same attempt,
          // and the next click is a new one.
          body: JSON.stringify({ plan: plan.key, requestKey: crypto.randomUUID() }),
        });
        // SAFETY: this reads our own /api/billing/checkout, whose two fields are
        // both optional here and both checked on the next line before use.
        const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };

        if (!response.ok || !body.url) {
          notify(body.error ?? "Checkout could not be opened. Try again in a moment.", "error");
          setBusy(null);
          return;
        }

        // Dodo's hosted page is a different origin, so this is a navigation
        // rather than a router push.
        window.location.assign(body.url);
      } catch {
        notify("Checkout could not be reached. Check your connection and try again.", "error");
        setBusy(null);
      }
    });
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      {plans.map((plan) => (
        <div
          key={plan.key}
          className={`flex flex-col border p-5 ${plan.current ? "border-accent bg-surface" : "border-rule bg-surface"}`}
        >
          <div className="flex items-baseline justify-between gap-2">
            <h3 className="text-base font-semibold">{plan.name}</h3>
            {plan.current && <span className="text-xs font-medium text-accent">Current plan</span>}
          </div>
          <p className="mt-1 text-sm text-muted">{plan.description}</p>
          <p className="mt-4 flex items-baseline gap-1">
            <span className="text-3xl font-bold tracking-tight">{plan.price}</span>
            <span className="text-sm text-muted">/ month</span>
          </p>
          <ul className="my-5 flex-1 space-y-2 text-sm text-muted">
            <li>{plan.repositories === 1 ? "1 repository" : `${plan.repositories} repositories`}</li>
            <li>{plan.runsPerMonth} runs per month</li>
            <li>{plan.automaticRuns ? "Automatic runs on push + manual" : "Manual runs"}</li>
          </ul>

          {plan.current ? (
            <p className="text-sm text-muted">In use now.</p>
          ) : plan.available && canBuy ? (
            <button
              type="button"
              onClick={() => buy(plan)}
              disabled={pending}
              className="focus-ring inline-flex items-center justify-center gap-2 border border-rule bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-60"
            >
              {busy === plan.key && pending ? (
                <>
                  <LuLoaderCircle size={15} aria-hidden className="animate-spin" /> Opening checkout
                </>
              ) : (
                <>
                  Choose {plan.name} <LuArrowUpRight size={15} aria-hidden />
                </>
              )}
            </button>
          ) : (
            <p className="text-sm text-muted">
              {plan.key === "free" ? "Included with every account." : "Not available on this deployment yet."}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

/** Sends the billing owner to Dodo's portal for cards, invoices and cancellation. */
export function BillingPortalButton({ enabled }: { enabled: boolean }) {
  const notify = useToast();
  const [pending, startTransition] = useTransition();

  if (!enabled) return null;

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            const response = await fetch("/api/billing/portal", { method: "POST" });
            // SAFETY: our own /api/billing/portal, and both fields are optional
            // here and checked before either is used.
            const body = (await response.json().catch(() => ({}))) as { url?: string; error?: string };
            if (!response.ok || !body.url) {
              notify(body.error ?? "The billing portal could not be opened.", "error");
              return;
            }
            window.location.assign(body.url);
          } catch {
            notify("The billing portal could not be reached.", "error");
          }
        })
      }
      className="focus-ring inline-flex items-center gap-2 border border-rule px-4 py-2 text-sm font-medium hover:bg-surface disabled:opacity-60"
    >
      Manage payment and invoices <LuArrowUpRight size={15} aria-hidden />
    </button>
  );
}
