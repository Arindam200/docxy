"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { LuCircleAlert, LuCircleCheck, LuLoaderCircle } from "react-icons/lu";
import type { ReturnOutcome } from "@billing/lifecycle";
import { useToast } from "@/components/dashboard/Toast";

/** What this deployment believes, as `/api/billing/status` reports it. */
interface Status {
  plan: string;
  accessState: string;
  accessReason: string | null;
  runsAllowed: number;
  runsLeft: number;
  subscription: { status: string; renewsAt: string | null; cancelAt: string | null } | null;
}

/** How long to wait for the webhook that confirms a purchase before saying so. */
const CONFIRM_TIMEOUT_MS = 45_000;
const POLL_MS = 2_500;

/**
 * The page somebody lands on when Dodo is finished with them.
 *
 * The redirect is a hint, never the answer. Dodo does not document what it
 * appends to a return URL, and even a redirect that plainly says "succeeded"
 * arrives before the webhook that proves a payment cleared - the two are
 * separate events, and only the second one is evidence. So the outcome in the
 * query string chooses the first sentence, and everything after that comes from
 * polling this deployment's own view until the plan actually changes.
 *
 * The states somebody can end up in:
 *
 *   confirmed  the plan changed. Toast, and a way back to the dashboard.
 *   waiting    the redirect looked successful and the webhook has not landed.
 *              Honest about it rather than claiming a plan they may not have.
 *   cancelled  they backed out. Nothing was charged and nothing changed.
 *   failed     the payment did not go through.
 */
export function BillingReturn({
  outcome,
  startingPlan,
  targetPlan,
}: {
  outcome: ReturnOutcome;
  startingPlan: string;
  /** The plan the checkout attempt was buying, when the return URL named one. */
  targetPlan: string | null;
}) {
  const notify = useToast();
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [waited, setWaited] = useState(false);
  const announced = useRef(false);

  const settled = outcome === "cancelled" || outcome === "failed";
  // Against the plan being bought when that is known: the webhook can land
  // before this page does, so "the plan has not changed since load" may mean
  // it already had. Otherwise, any change since load is the evidence.
  const isConfirmed = useCallback(
    (plan: string) => (targetPlan ? plan === targetPlan : plan !== startingPlan),
    [startingPlan, targetPlan],
  );
  const confirmed = Boolean(status && isConfirmed(status.plan));

  // Poll our own record, not the provider's redirect, until the purchase shows
  // up or the wait runs out. Stops as soon as either happens.
  useEffect(() => {
    if (settled) return;

    let cancelled = false;
    const startedAt = Date.now();

    const tick = async () => {
      try {
        const response = await fetch("/api/billing/status", { cache: "no-store" });
        if (!response.ok) return;
        // SAFETY: our own /api/billing/status, which is only read after an ok
        // response, and whose plan field is compared rather than dereferenced.
        const body = (await response.json()) as Status;
        if (cancelled) return;

        setStatus(body);
        if (isConfirmed(body.plan)) {
          // The dashboard's server-rendered pages hold the old plan.
          router.refresh();
          return;
        }
      } catch {
        // A failed poll is not a failed payment. Keep waiting.
      }

      if (Date.now() - startedAt > CONFIRM_TIMEOUT_MS) {
        if (!cancelled) setWaited(true);
        return;
      }
      if (!cancelled) window.setTimeout(tick, POLL_MS);
    };

    void tick();
    return () => {
      cancelled = true;
    };
  }, [isConfirmed, router, settled]);

  // One toast per arrival, saying what is actually known at the time.
  useEffect(() => {
    if (announced.current) return;

    if (outcome === "cancelled") {
      announced.current = true;
      notify("Checkout was cancelled. Nothing was charged.", "info");
      return;
    }
    if (outcome === "failed") {
      announced.current = true;
      notify("The payment did not go through. No plan was started.", "error");
      return;
    }
    if (confirmed && status) {
      announced.current = true;
      notify(`You are on the ${status.plan} plan. ${status.runsAllowed} runs a month.`, "success");
      return;
    }
    if (waited) {
      announced.current = true;
      notify(
        outcome === "succeeded"
          ? "Payment received. Confirmation from Dodo is taking longer than usual."
          : "No confirmation from Dodo yet. If you completed the payment, it will appear here shortly.",
        "info",
      );
    }
  }, [confirmed, notify, outcome, status, waited]);

  if (outcome === "cancelled" || outcome === "failed") {
    return (
      <Panel
        tone={outcome === "cancelled" ? "info" : "error"}
        title={outcome === "cancelled" ? "Checkout cancelled" : "Payment not completed"}
        body={
          outcome === "cancelled"
            ? "You closed the checkout before it finished. Nothing was charged and your plan is unchanged."
            : "Dodo could not complete the payment, so no plan was started. You can try again, or use a different card."
        }
      />
    );
  }

  if (confirmed && status) {
    return (
      <Panel
        tone="success"
        title={`You are on the ${status.plan} plan`}
        body={`${status.runsLeft} of ${status.runsAllowed} runs are available in this period.${
          status.subscription?.renewsAt
            ? ` It renews on ${new Date(status.subscription.renewsAt).toLocaleDateString()}.`
            : ""
        }`}
      />
    );
  }

  if (waited) {
    return (
      <Panel
        tone="info"
        title="Payment received, confirmation pending"
        body="Dodo has not confirmed the subscription yet. This usually takes a minute or two and needs nothing from you. The plan appears here as soon as it lands."
      />
    );
  }

  return (
    <Panel
      tone="pending"
      title="Confirming your payment"
      body="Waiting for Dodo to confirm the subscription. Access is granted on the confirmation, not on this redirect, so this page waits for the real thing."
    />
  );
}

function Panel({
  tone,
  title,
  body,
}: {
  tone: "success" | "info" | "error" | "pending";
  title: string;
  body: string;
}) {
  const Icon = tone === "success" ? LuCircleCheck : tone === "error" ? LuCircleAlert : tone === "pending" ? LuLoaderCircle : LuCircleAlert;
  const color = tone === "success" ? "text-ok" : tone === "error" ? "text-danger" : "text-accent";

  return (
    <div className="border border-rule bg-surface p-6">
      <div className="flex items-start gap-3">
        <Icon size={20} aria-hidden className={`mt-0.5 shrink-0 ${color} ${tone === "pending" ? "animate-spin" : ""}`} />
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p role="status" className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
          <div className="mt-4 flex flex-wrap gap-3 text-sm">
            <Link href="/dashboard/billing" className="focus-ring text-accent hover:underline">Back to billing</Link>
            <Link href="/dashboard" className="focus-ring text-muted hover:text-foreground">Dashboard</Link>
          </div>
        </div>
      </div>
    </div>
  );
}
