/**
 * Opening hosted checkout, exactly once per intent.
 *
 * The browser sends a plan key and, for Team, a desired seat count. Everything
 * that costs money is decided here: the product, the add-on quantity, the
 * price, the customer and the URL Dodo returns to. A request that could name
 * its own price, or its own redirect, is a request that will.
 *
 * The open attempt row is the lock. A double-clicked button, a second tab and a
 * retried request all land on the attempt that already exists and get the same
 * hosted URL back, because the alternative is two subscriptions for one
 * intention and a refund conversation.
 */

import type {
  CheckoutSessionCreateParams,
  ProductItemReq,
} from "dodopayments/resources/checkout-sessions";
import { and, eq } from "drizzle-orm";
import { hasSeatExpansion, isPaidPlan, normalizeSeats, seatAddOnQuantity, type PlanKey } from "@billing";
import { isLiveSubscription } from "@billing/lifecycle";
import { checkoutAttempts } from "@billing/schema";
import { ensureBillingAccount, findSubscription, isBillingOwner } from "./accounts";
import { getDodo } from "./client";
import {
  billingEnvironment,
  canSell,
  checkoutCancelUrl,
  checkoutReturnUrl,
  productIdFor,
  seatProductId,
} from "./config";
import { getBillingDb } from "./db";
import { sessionPayment } from "./provider-session";

/** How long an unfinished attempt holds the slot before another may open. */
const ATTEMPT_TTL_MS = 30 * 60 * 1000;

/** How long a second request waits for the first one's hosted URL. */
const URL_WAIT_MS = 8_000;

/**
 * An open attempt with no URL this long after it was created belongs to a
 * request that died between claiming the slot and hearing back from Dodo.
 */
const ORPHAN_AFTER_MS = 60_000;

export interface CheckoutRequest {
  organizationId: string;
  userId: string;
  planKey: PlanKey;
  /** Desired total seats, for Team. Bounded by the catalog, never trusted raw. */
  seats?: number;
  /**
   * The caller's idempotency key, so a retried request is the same attempt.
   * One per purchase intent, never reused across intents: the index on it
   * covers every attempt this account ever made, closed ones included.
   */
  requestKey: string;
}

export type CheckoutRefusal =
  | "billing-disabled"
  | "not-owner"
  | "not-purchasable"
  | "already-subscribed"
  | "in-progress"
  | "payment-pending"
  | "provider-error";

export type CheckoutResult =
  | { ok: true; url: string; attemptId: string; reused: boolean }
  | { ok: false; refusal: CheckoutRefusal; message: string };

/**
 * A hosted checkout URL for this account, or a refusal that says why not.
 *
 * Refusals are values rather than exceptions because every one of them is an
 * ordinary answer the billing page has to render: a deployment without
 * credentials, a member who is not the billing owner, an account that already
 * pays.
 */
export async function startCheckout(request: CheckoutRequest): Promise<CheckoutResult> {
  if (!isPaidPlan(request.planKey)) {
    return {
      ok: false,
      refusal: "not-purchasable",
      message: "The Free plan is granted here, not bought.",
    };
  }

  if (!canSell(request.planKey)) {
    return {
      ok: false,
      refusal: "billing-disabled",
      message: "This deployment cannot take payments yet.",
    };
  }

  const account = await ensureBillingAccount(request.organizationId, request.userId);
  if (!isBillingOwner(account, request.userId)) {
    return {
      ok: false,
      refusal: "not-owner",
      message: "Only the billing owner of this organization can change the plan.",
    };
  }

  // An account that already pays changes plan through an authenticated change,
  // not through a second checkout that would leave two subscriptions running.
  // Any live subscription counts: one on hold is still billing this account,
  // and buying another beside it is how a customer ends up charged twice.
  const existing = await findSubscription(account.id);
  if (existing && isLiveSubscription(existing.providerStatus)) {
    return {
      ok: false,
      refusal: "already-subscribed",
      message:
        existing.providerStatus === "active"
          ? "This organization already has an active subscription."
          : "This organization's subscription is waiting on a payment. Update the payment method under Manage payment and invoices.",
    };
  }

  const db = getBillingDb();
  const environment = billingEnvironment();
  const seats = normalizeSeats(request.planKey, request.seats);

  // At most one attempt is open per account - an index says so - and it is the
  // lock. Releasing it is the step that can sell somebody a second
  // subscription, so `releasable` asks Dodo first whenever it got that far.
  let open = await openAttempt(account.id);

  // Expire the stale lock: an attempt somebody abandoned half an hour ago must
  // not stop them trying again. Only once its own expiry has passed, so a
  // checkout opened seconds ago in another tab survives and is reused.
  if (open && open.expiresAt.getTime() < Date.now()) {
    const held = await releasable(open.providerSessionId);
    if (held) return held;
    await db
      .update(checkoutAttempts)
      .set({ state: "expired", updatedAt: new Date() })
      .where(and(eq(checkoutAttempts.id, open.id), eq(checkoutAttempts.state, "open")));
    open = null;
  }

  if (open) {
    const sameIntent = open.planKey === request.planKey && open.requestedSeats === seats;
    const orphaned = !open.checkoutUrl && Date.now() - open.createdAt.getTime() > ORPHAN_AFTER_MS;

    if (sameIntent && !orphaned) {
      // The same purchase, already under way: send them to it. If the request
      // that opened it is still waiting on Dodo, wait for its answer rather
      // than opening a second hosted page beside it.
      const url = open.checkoutUrl ?? (await settledUrl(open.id));
      if (url) return { ok: true, url, attemptId: open.id, reused: true };
      return inProgress();
    }

    // A different plan or seat count is a change of mind, and a checkout that
    // never got a URL was left by a request that died. Either way the slot is
    // released for the attempt below - unless the first checkout was paid for
    // and its webhook has not arrived yet, which looks exactly like a change
    // of mind from here. An orphan never reached Dodo, so it has nothing to ask.
    const held = orphaned ? null : await releasable(open.providerSessionId);
    if (held) return held;
    await db
      .update(checkoutAttempts)
      .set({
        state: orphaned ? "failed" : "abandoned",
        failureReason: orphaned ? "no checkout URL was ever recorded" : null,
        updatedAt: new Date(),
      })
      .where(and(eq(checkoutAttempts.id, open.id), eq(checkoutAttempts.state, "open")));
  }

  // No conflict target: either unique index may be the one that fires. The
  // request key catches a retried request; the one-open index catches another
  // tab that got here first. Both mean the same thing - this call lost.
  const [attempt] = await db
    .insert(checkoutAttempts)
    .values({
      accountId: account.id,
      environment,
      planKey: request.planKey,
      requestedSeats: seats,
      requestKey: request.requestKey,
      expiresAt: new Date(Date.now() + ATTEMPT_TTL_MS),
    })
    .onConflictDoNothing()
    .returning();

  if (!attempt) {
    // Only the caller that created an attempt asks Dodo for a session. A loser
    // waits for the winner's URL, which is what turns a double click into one
    // hosted page instead of two.
    const winner = await openAttempt(account.id);
    if (!winner || winner.planKey !== request.planKey || winner.requestedSeats !== seats) {
      return inProgress();
    }
    const url = winner.checkoutUrl ?? (await settledUrl(winner.id));
    if (url) return { ok: true, url, attemptId: winner.id, reused: true };
    return inProgress();
  }

  try {
    const params: CheckoutSessionCreateParams = {
      product_cart: productCart(request.planKey, seats),
      return_url: checkoutReturnUrl(attempt.id),
      cancel_url: checkoutCancelUrl(),
      // Carried back on every subscription event, so a webhook knows which
      // organization it belongs to without matching on an email address.
      metadata: {
        organization_id: request.organizationId,
        billing_account_id: account.id,
        checkout_attempt_id: attempt.id,
        plan_key: request.planKey,
        seats: String(seats),
      },
    };

    // Attached only when this account has bought before. Sending an absent
    // customer id is not the same as sending none: Dodo would create a second
    // customer for somebody who already exists.
    if (account.dodoCustomerId) {
      params.customer = { customer_id: account.dodoCustomerId };
    }

    const session = await getDodo().checkoutSessions.create(params);

    const url = session.checkout_url;
    if (!url) throw new Error("Dodo returned a session with no checkout URL");

    await db
      .update(checkoutAttempts)
      .set({ providerSessionId: session.session_id, checkoutUrl: url, updatedAt: new Date() })
      .where(eq(checkoutAttempts.id, attempt.id));

    return { ok: true, url, attemptId: attempt.id, reused: false };
  } catch (cause) {
    // The attempt is closed rather than left open, so a provider outage does
    // not lock the account out of trying again for half an hour.
    await db
      .update(checkoutAttempts)
      .set({
        state: "failed",
        failureReason: cause instanceof Error ? cause.message.slice(0, 500) : "unknown",
        updatedAt: new Date(),
      })
      .where(eq(checkoutAttempts.id, attempt.id));

    return {
      ok: false,
      refusal: "provider-error",
      message: "Dodo could not open a checkout just now. Try again in a moment.",
    };
  }
}

/**
 * A refusal when the attempt holding the slot has been paid for, or null when
 * the slot may be released.
 *
 * An attempt with no session id never reached Dodo, so nobody can have paid
 * it. One that did is asked about, and both "paid" and "could not tell" keep
 * the slot: the webhook that confirms the payment will close the attempt and
 * make the subscription live, and from then on the already-subscribed check
 * above answers instead of this one.
 */
async function releasable(providerSessionId: string | null): Promise<CheckoutResult | null> {
  if (!providerSessionId) return null;
  const payment = await sessionPayment(providerSessionId, (id) =>
    getDodo().checkoutSessions.retrieve(id),
  );
  if (payment === "unpaid") return null;
  return {
    ok: false,
    refusal: "payment-pending",
    message:
      payment === "paid"
        ? "Your last checkout for this organization was paid and the payment is being confirmed. Your plan will update in a few minutes, so there is no need to pay again."
        : "Could not confirm whether your last checkout for this organization was paid. Try again in a few minutes rather than paying twice.",
  };
}

function inProgress(): CheckoutResult {
  return {
    ok: false,
    refusal: "in-progress",
    message: "A checkout is already being opened for this organization. Try again in a few seconds.",
  };
}

type CheckoutAttemptRow = typeof checkoutAttempts.$inferSelect;

/** The open attempt for this account, if one is still holding the slot. */
async function openAttempt(accountId: string): Promise<CheckoutAttemptRow | null> {
  const rows = await getBillingDb()
    .select()
    .from(checkoutAttempts)
    .where(and(eq(checkoutAttempts.accountId, accountId), eq(checkoutAttempts.state, "open")))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The hosted URL another request is fetching for this attempt, once it lands.
 *
 * Null if that request gives up (the attempt closes) or takes longer than a
 * person would wait on a button.
 */
async function settledUrl(attemptId: string): Promise<string | null> {
  const deadline = Date.now() + URL_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const rows = await getBillingDb()
      .select({ url: checkoutAttempts.checkoutUrl, state: checkoutAttempts.state })
      .from(checkoutAttempts)
      .where(eq(checkoutAttempts.id, attemptId))
      .limit(1);
    if (rows[0]?.url) return rows[0].url;
    if (rows[0]?.state !== "open") return null;
  }
  return null;
}

/**
 * The cart: the base package, carrying the seat add-on for seats beyond it.
 *
 * The seats are an add-on *of* the base product, not a second product beside
 * it: Dodo reports them back on the subscription's `addons`, which is where
 * `seatsFrom` in sync.ts reads them, and a separate cart line would be a
 * separate product nobody's webhook counts. The quantity is derived from the
 * catalog rather than sent by the browser, which is what stops a request buying
 * twenty seats at the price of five.
 */
function productCart(planKey: PlanKey, seats: number): ProductItemReq[] {
  const base = productIdFor(planKey);
  if (!base) throw new Error(`no Dodo product is configured for the ${planKey} plan`);

  const item: ProductItemReq = { product_id: base, quantity: 1 };
  if (hasSeatExpansion(planKey)) {
    const extra = seatAddOnQuantity(planKey, seats);
    if (extra > 0) {
      const addOn = seatProductId();
      // Selling the base package while the customer asked for more seats would
      // charge for five and promise more.
      if (!addOn) throw new Error("no Dodo seat add-on is configured for extra Team seats");
      item.addons = [{ addon_id: addOn, quantity: extra }];
    }
  }
  return [item];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The plan an attempt set out to buy, when it belongs to this account.
 *
 * What the return page waits for. "The plan changed since this page loaded"
 * is the wrong question, because the webhook often lands before the browser
 * does - the plan has already changed, nothing changes again, and the page
 * would wait out its timeout to report a purchase that is already done.
 */
export async function attemptPlan(accountId: string, attemptId: string): Promise<PlanKey | null> {
  if (!UUID.test(attemptId)) return null;
  const rows = await getBillingDb()
    .select({ planKey: checkoutAttempts.planKey })
    .from(checkoutAttempts)
    .where(and(eq(checkoutAttempts.id, attemptId), eq(checkoutAttempts.accountId, accountId)))
    .limit(1);
  return rows[0]?.planKey ?? null;
}
