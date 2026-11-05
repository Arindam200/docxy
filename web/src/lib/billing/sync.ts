/**
 * Applying a verified provider event to this deployment's own records.
 *
 * Four rules, each of which exists because the alternative loses money or
 * grants access nobody paid for:
 *
 *   1. Deliveries are recorded before they are acted on, and marked processed
 *      in the same transaction as the change they caused. The other order
 *      acknowledges work a crash then loses. A delivery that is still pending
 *      when Dodo retries it is processed again, not waved through as a
 *      duplicate: the 500 that left it pending is what asked for the retry.
 *   2. An older event never overwrites a newer one. Deliveries arrive out of
 *      order, and an `active` from ten minutes ago must not undo a cancellation
 *      from one minute ago.
 *   3. An account this deployment cannot identify is queued for review, never
 *      guessed at. An unknown product is not a free upgrade.
 *   4. What a status *means* is decided in `src/billing/lifecycle.ts`, not here.
 *      That file holds the judgement; this one moves rows.
 *
 * The event is the SDK's own verified union, so `payload_type` narrows it and
 * nothing here parses a field by hand out of an untyped payload.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { catalogVersion, plans, type PlanKey } from "@billing";
import {
  disputeDecision,
  disputeIsOpen,
  LIVE_SUBSCRIPTION_STATUSES,
  subscriptionDecision,
  type LifecycleDecision,
} from "@billing/lifecycle";
import {
  billingAccounts,
  checkoutAttempts,
  payments,
  subscriptions,
  webhookDeliveries,
} from "@billing/schema";
import { getDodo } from "./client";
import { billingEnvironment, planForProduct, seatProductId } from "./config";
import { getBillingDb, type BillingDatabase } from "./db";

/** One open transaction. Every write below happens inside the delivery's own. */
type Tx = Parameters<Parameters<BillingDatabase["transaction"]>[0]>[0];

/** One verified Dodo event, as the SDK's own signature verification returns it. */
export type ProviderEvent = ReturnType<ReturnType<typeof getDodo>["webhooks"]["unwrap"]>;

/**
 * The event families this deployment acts on, picked out of the union by the
 * shape of their `type` literal.
 *
 * Narrowing on `type` rather than on the payload, because the SDK's per-event
 * payloads do not carry a discriminator of their own - `subscription.active`
 * and `subscription.cancelled` both hand back a plain subscription.
 */
type EventOf<Prefix extends string> = Extract<ProviderEvent, { type: `${Prefix}.${string}` }>;

type SubscriptionEvent = EventOf<"subscription">;
type PaymentEvent = EventOf<"payment">;
type DisputeEvent = EventOf<"dispute">;
type RefundEvent = EventOf<"refund">;

type SubscriptionPayload = SubscriptionEvent["data"];
type PaymentPayload = PaymentEvent["data"];
type DisputePayload = DisputeEvent["data"];
type RefundPayload = RefundEvent["data"];

const isSubscriptionEvent = (event: ProviderEvent): event is SubscriptionEvent =>
  event.type.startsWith("subscription.");
const isPaymentEvent = (event: ProviderEvent): event is PaymentEvent =>
  event.type.startsWith("payment.");
const isDisputeEvent = (event: ProviderEvent): event is DisputeEvent =>
  event.type.startsWith("dispute.");
const isRefundEvent = (event: ProviderEvent): event is RefundEvent =>
  event.type.startsWith("refund.");

/** What happened to one delivery, and what the inbox row should say. */
export type SyncOutcome =
  /** A record moved. */
  | { state: "processed"; note: string }
  /** Verified, understood, and deliberately without effect here. */
  | { state: "ignored"; note: string }
  /** Verified but unusable: an unknown account or product. A person decides. */
  | { state: "failed"; note: string };

/**
 * Record the delivery, or report that it has already been settled.
 *
 * Returns null when this delivery id exists and was settled, which is the whole
 * point: a redelivery collides on a unique index instead of applying twice.
 *
 * A delivery that exists but is still `pending` comes back instead. It was
 * never applied - the attempt before this one threw, or died, before settling
 * it - and acknowledging the retry as a duplicate would drop the event for
 * good. `processDelivery` locks the row, so two copies racing here still apply
 * once.
 */
export async function recordDelivery(
  deliveryId: string,
  event: ProviderEvent,
): Promise<{ id: string } | null> {
  const rows = await getBillingDb()
    .insert(webhookDeliveries)
    .values({
      environment: billingEnvironment(),
      providerDeliveryId: deliveryId,
      type: event.type,
      payload: event,
    })
    .onConflictDoUpdate({
      target: [webhookDeliveries.environment, webhookDeliveries.providerDeliveryId],
      set: { updatedAt: new Date() },
      setWhere: eq(webhookDeliveries.state, "pending"),
    })
    .returning({ id: webhookDeliveries.id });
  return rows[0] ?? null;
}

/**
 * Apply one recorded delivery and settle it, as a single transaction.
 *
 * The inbox row is locked first, so two copies of one delivery arriving
 * together - a retry that overtook a slow first attempt - take turns, and the
 * second finds the first already settled. Settling inside the same transaction
 * is rule 1 made literal: `processed` commits with the change it describes, or
 * neither does.
 *
 * Returns null when another attempt settled the delivery first. Throws, with
 * nothing written, when the change could not be made.
 */
export async function processDelivery(id: string, event: ProviderEvent): Promise<SyncOutcome | null> {
  return getBillingDb().transaction(async (tx) => {
    const [row] = await tx
      .select({ state: webhookDeliveries.state })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.id, id))
      .for("update");
    if (row?.state !== "pending") return null;

    const outcome = await applyIn(tx, event);
    await tx
      .update(webhookDeliveries)
      .set({
        state: outcome.state,
        error: outcome.state === "processed" ? null : outcome.note.slice(0, 500),
        processedAt: new Date(),
        attempts: sql`${webhookDeliveries.attempts} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(webhookDeliveries.id, id));
    return outcome;
  });
}

/** Leave a delivery pending, with a note, so a retry can pick it up. */
export async function deferDelivery(id: string, note: string): Promise<void> {
  await getBillingDb()
    .update(webhookDeliveries)
    .set({
      state: "pending",
      error: note.slice(0, 500),
      attempts: sql`${webhookDeliveries.attempts} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(webhookDeliveries.id, id));
}

/**
 * Apply one verified event, in a transaction of its own.
 *
 * For replays and tests. The webhook goes through `processDelivery`, which
 * settles the inbox row in the same transaction.
 *
 * Throwing means "retry this delivery"; returning `failed` means "stop
 * retrying, a person needs to look". The distinction matters because Dodo
 * retries on a non-2xx, and retrying an event about a product nobody configured
 * will never succeed.
 */
export async function applyEvent(event: ProviderEvent): Promise<SyncOutcome> {
  return getBillingDb().transaction((tx) => applyIn(tx, event));
}

async function applyIn(tx: Tx, event: ProviderEvent): Promise<SyncOutcome> {
  const eventAt = new Date(event.timestamp);
  if (Number.isNaN(eventAt.getTime())) {
    return { state: "failed", note: `${event.type} carried an unreadable timestamp (${event.timestamp})` };
  }
  if (isSubscriptionEvent(event)) return applySubscription(tx, event.type, eventAt, event.data);
  if (isPaymentEvent(event)) return applyPayment(tx, event.type, eventAt, event.data);
  if (isDisputeEvent(event)) return applyDispute(tx, event.type, event.data);
  if (isRefundEvent(event)) return applyRefund(tx, event.type, event.data);
  return { state: "ignored", note: `nothing here acts on ${event.type}` };
}

/**
 * The account an event belongs to.
 *
 * Metadata first, because checkout puts the organization id there itself. The
 * stored provider customer id second. Never an email address: an address is not
 * proof of a customer, and two accounts can share one.
 *
 * The row is locked for the rest of the transaction. Every event about one
 * account therefore applies one at a time, which is what makes the ordering
 * check below mean anything: two deliveries that both read the old row and both
 * pass it would otherwise let the older one commit last.
 */
async function accountFor(
  db: Tx,
  metadata: Record<string, string | number | boolean> | undefined,
  customerId: string | undefined,
) {
  const environment = billingEnvironment();

  const organizationId = text(metadata?.organization_id);
  if (organizationId) {
    const rows = await db
      .select()
      .from(billingAccounts)
      .where(
        and(
          eq(billingAccounts.organizationId, organizationId),
          eq(billingAccounts.environment, environment),
        ),
      )
      .limit(1)
      .for("update");
    if (rows[0]) return rows[0];
  }

  if (customerId) {
    const rows = await db
      .select()
      .from(billingAccounts)
      .where(
        and(
          eq(billingAccounts.dodoCustomerId, customerId),
          eq(billingAccounts.environment, environment),
        ),
      )
      .limit(1)
      .for("update");
    if (rows[0]) return rows[0];
  }

  return null;
}

async function applySubscription(
  db: Tx,
  type: string,
  eventAt: Date,
  data: SubscriptionPayload,
): Promise<SyncOutcome> {
  const account = await accountFor(db, data.metadata, data.customer.customer_id);
  if (!account) {
    return {
      state: "failed",
      note: `no billing account matches subscription ${data.subscription_id}; queued for review`,
    };
  }

  const planKey = planForProduct(data.product_id);
  if (!planKey) {
    return {
      state: "failed",
      note: `product ${data.product_id} is not in this deployment's catalog`,
    };
  }

  const environment = billingEnvironment();
  const seats = seatsFrom(data, planKey);
  const cancelAtPeriodEnd = data.cancel_at_next_billing_date;

  const existing = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.environment, environment),
        eq(subscriptions.providerSubscriptionId, data.subscription_id),
      ),
    )
    .limit(1);

  const current = existing[0];
  // Rule 2: an event older than what is already stored is evidence about the
  // past, not an instruction about the present.
  if (current?.providerEventAt && current.providerEventAt > eventAt) {
    return { state: "ignored", note: `a newer event for ${data.subscription_id} is applied` };
  }

  const periodStart = asDate(data.previous_billing_date);
  const periodEnd = asDate(data.next_billing_date);

  const values = {
    accountId: account.id,
    environment,
    providerSubscriptionId: data.subscription_id,
    planKey,
    planVersion: catalogVersion,
    purchasedSeats: seats,
    providerStatus: data.status,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
    cancelAt: cancelAtPeriodEnd ? periodEnd : null,
    canceledAt: data.status === "cancelled" ? eventAt : null,
    providerEventAt: eventAt,
    reconciledAt: new Date(),
    updatedAt: new Date(),
  };

  if (current) {
    await db.update(subscriptions).set(values).where(eq(subscriptions.id, current.id));
  } else {
    await db.insert(subscriptions).values(values);
  }

  await rememberCustomer(db, account.id, data.customer.customer_id);
  await closeAttempt(db, account.id, text(data.metadata?.checkout_attempt_id), data.status);

  // The account follows the subscription that governs it, which is not always
  // the one this event is about. Cancelling and buying again leaves the old
  // subscription's `cancelled` free to arrive after the new one's `active`;
  // applied as it stands, it would drop a paying account to Free.
  const governing = await governingSubscription(db, account.id);
  if (governing && governing.providerSubscriptionId !== data.subscription_id) {
    return {
      state: "processed",
      note: `${type}: ${data.subscription_id} is ${data.status}; ${governing.providerSubscriptionId} governs this account`,
    };
  }

  const decision = await holdForDispute(
    db,
    account.id,
    subscriptionDecision(data.status, { cancelAtPeriodEnd }),
  );
  await applyDecision(db, account.id, decision, planKey, seats);

  return {
    state: "processed",
    note: `${type}: ${data.subscription_id} is ${data.status}, access ${decision.access}`,
  };
}

/** Payment states that are final. A late `processing` must not undo one. */
const SETTLED_PAYMENT = ["succeeded", "failed", "cancelled"];

async function applyPayment(
  db: Tx,
  type: string,
  eventAt: Date,
  data: PaymentPayload,
): Promise<SyncOutcome> {
  const account = await accountFor(db, data.metadata, data.customer.customer_id);
  if (!account) {
    return { state: "failed", note: `no billing account matches payment ${data.payment_id}` };
  }

  const environment = billingEnvironment();
  const local = data.subscription_id
    ? await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(
          and(
            eq(subscriptions.environment, environment),
            eq(subscriptions.providerSubscriptionId, data.subscription_id),
          ),
        )
        .limit(1)
    : [];

  const status = data.status ?? type.replace("payment.", "");
  await db
    .insert(payments)
    .values({
      accountId: account.id,
      subscriptionId: local[0]?.id ?? null,
      environment,
      providerPaymentId: data.payment_id,
      status,
      // Minor units, in the currency the customer was actually charged. Never
      // converted: a converted total is a number nobody was charged.
      amountMinor: data.total_amount,
      currency: data.currency,
      paidAt: status === "succeeded" ? eventAt : null,
    })
    .onConflictDoUpdate({
      target: [payments.environment, payments.providerPaymentId],
      // `paid_at` too: a `processing` that arrived first inserted the row
      // without one, and the `succeeded` behind it is the only thing that
      // knows when the money landed.
      set: { status, paidAt: sql`coalesce(${payments.paidAt}, excluded.paid_at)`, updatedAt: new Date() },
      setWhere: sql`${payments.status} not in ${SETTLED_PAYMENT} or excluded.status in ${SETTLED_PAYMENT}`,
    });

  await rememberCustomer(db, account.id, data.customer.customer_id);
  return { state: "processed", note: `payment ${data.payment_id} is ${status}` };
}

async function applyDispute(db: Tx, type: string, data: DisputePayload): Promise<SyncOutcome> {
  // A dispute payload names a payment, not a customer, so the payment this
  // deployment already recorded is what identifies the account.
  const environment = billingEnvironment();
  const rows = await db
    .select({ accountId: payments.accountId })
    .from(payments)
    .where(
      and(eq(payments.environment, environment), eq(payments.providerPaymentId, data.payment_id)),
    )
    .limit(1);

  const accountId = rows[0]?.accountId;
  if (!accountId) {
    return { state: "failed", note: `no recorded payment matches dispute ${data.dispute_id}` };
  }

  // The same lock a subscription event takes, so the two cannot interleave.
  await db
    .select({ id: billingAccounts.id })
    .from(billingAccounts)
    .where(eq(billingAccounts.id, accountId))
    .for("update");

  // Open while it is being argued, and only then. `challenged` is the merchant
  // answering, not the dispute ending.
  await db
    .update(payments)
    .set({ disputed: disputeIsOpen(type), updatedAt: new Date() })
    .where(
      and(eq(payments.environment, environment), eq(payments.providerPaymentId, data.payment_id)),
    );

  let decision = disputeDecision(type);
  if (decision.access === "active") {
    // Settled in the account's favour. Back to what its subscription says,
    // unless another payment is still being disputed.
    decision = await holdForDispute(db, accountId, await subscriptionAccess(db, accountId));
  }
  await applyDecision(db, accountId, decision, null, null);

  return { state: "processed", note: `${type}, access ${decision.access}` };
}

/**
 * A refund is recorded and nothing else.
 *
 * Deliberately not treated as a cancellation: a partial refund for a bad month
 * is not somebody leaving, and the subscription events say what the
 * subscription is doing.
 *
 * Added to what is already refunded rather than written over it, because a
 * payment can be refunded in parts. That is safe to add because each delivery
 * applies exactly once (`processDelivery`), and capped at the payment so a
 * replayed refund cannot record more than was ever charged.
 */
async function applyRefund(db: Tx, type: string, data: RefundPayload): Promise<SyncOutcome> {
  if (type !== "refund.succeeded") {
    return { state: "ignored", note: `${type} for ${data.payment_id} moved no money` };
  }
  if (data.amount == null && data.is_partial) {
    return { state: "failed", note: `partial refund ${data.refund_id} carried no amount` };
  }

  const amount = data.amount ?? sql`${payments.amountMinor}`;
  const updated = await db
    .update(payments)
    .set({
      refundedMinor: sql`least(${payments.amountMinor}, ${payments.refundedMinor} + ${amount})`,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(payments.environment, billingEnvironment()),
        eq(payments.providerPaymentId, data.payment_id),
      ),
    )
    .returning({ id: payments.id });

  if (!updated[0]) {
    return { state: "failed", note: `no recorded payment matches refund ${data.refund_id}` };
  }
  return { state: "processed", note: `refund ${data.refund_id} recorded against ${data.payment_id}` };
}

/** Write the decision onto the account: the plan honoured, and whether work starts. */
async function applyDecision(
  db: Tx,
  accountId: string,
  decision: LifecycleDecision,
  planKey: PlanKey | null,
  seats: number | null,
): Promise<void> {
  const base = {
    accessState: decision.access,
    accessReason: decision.reason,
    updatedAt: new Date(),
  };

  const changes =
    decision.plan === "subscription" && planKey
      ? { ...base, entitledPlan: planKey, purchasedSeats: seats ?? 1 }
      : decision.plan === "free"
        ? { ...base, entitledPlan: plans.free.key, purchasedSeats: 1 }
        : base;

  await db.update(billingAccounts).set(changes).where(eq(billingAccounts.id, accountId));
}

/** The newest subscription that still decides what this account may do, if any. */
async function governingSubscription(db: Tx, accountId: string) {
  const rows = await db
    .select()
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.accountId, accountId),
        inArray(subscriptions.providerStatus, [...LIVE_SUBSCRIPTION_STATUSES]),
      ),
    )
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/** What the governing subscription says about access, leaving the plan alone. */
async function subscriptionAccess(db: Tx, accountId: string): Promise<LifecycleDecision> {
  const governing = await governingSubscription(db, accountId);
  if (!governing) return { plan: "unchanged", access: "active", reason: null };
  const decision = subscriptionDecision(governing.providerStatus, {
    cancelAtPeriodEnd: governing.cancelAt !== null,
  });
  return { ...decision, plan: "unchanged" };
}

/**
 * Keep an account in review while any of its payments is disputed.
 *
 * A dispute moves the account to review until a person, or the dispute's own
 * outcome, says otherwise. A renewal landing in the meantime is not that, so a
 * decision that would start runs again is held back.
 */
async function holdForDispute(
  db: Tx,
  accountId: string,
  decision: LifecycleDecision,
): Promise<LifecycleDecision> {
  if (decision.access !== "active") return decision;
  const open = await db
    .select({ id: payments.id })
    .from(payments)
    .where(and(eq(payments.accountId, accountId), eq(payments.disputed, true)))
    .limit(1);
  if (!open[0]) return decision;
  return { ...decision, access: "review", reason: disputeDecision("dispute.opened").reason };
}

/** Store the provider customer the first time an event names one. */
async function rememberCustomer(db: Tx, accountId: string, customerId: string | undefined): Promise<void> {
  if (!customerId) return;
  await db
    .update(billingAccounts)
    .set({ dodoCustomerId: customerId, updatedAt: new Date() })
    .where(and(eq(billingAccounts.id, accountId), sql`${billingAccounts.dodoCustomerId} is null`));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Close the attempt this subscription came from, so the slot is free again.
 *
 * Only the attempt the event names, only on this account, and only while it is
 * still open. Closing "whatever is open" instead would let a renewal of the
 * current plan close a checkout the owner has open for a different one, and
 * would stamp a new completion time on every renewal after that.
 */
async function closeAttempt(
  db: Tx,
  accountId: string,
  attemptId: string | undefined,
  status: string,
): Promise<void> {
  // Ours, from checkout metadata - but a malformed id would fail the uuid cast
  // and turn into a retry loop rather than a skipped update.
  if (!attemptId || !UUID.test(attemptId)) return;
  await db
    .update(checkoutAttempts)
    .set({
      state: status === "failed" ? "failed" : "completed",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(checkoutAttempts.id, attemptId),
        eq(checkoutAttempts.accountId, accountId),
        eq(checkoutAttempts.state, "open"),
      ),
    );
}

/**
 * Purchased seats: the base package, plus the seat add-on's quantity.
 *
 * Read from the subscription's add-on lines rather than from its quantity,
 * because the base product is always quantity one and the seats beyond five are
 * a separate recurring add-on. Only the seat add-on counts: any other add-on a
 * subscription carries is not a seat.
 */
function seatsFrom(data: SubscriptionPayload, planKey: PlanKey): number {
  if (planKey !== "team") return plans[planKey].entitlements.seats;
  const seatAddOn = seatProductId();
  const extra = data.addons
    .filter((addon) => addon.addon_id === seatAddOn)
    .reduce((total, addon) => total + addon.quantity, 0);
  return plans.team.entitlements.seats + extra;
}

/**
 * One metadata value as text, or undefined.
 *
 * Dodo's metadata is typed as string, number or boolean, and everything this
 * deployment puts there is an id. Coercing is the honest read: an id that came
 * back as a number is still that id.
 */
function text(value: string | number | boolean | undefined): string | undefined {
  if (value === undefined) return undefined;
  const result = String(value);
  return result.length > 0 ? result : undefined;
}

function asDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
