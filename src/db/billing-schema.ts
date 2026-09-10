/**
 * Billing, in its own `billing` Postgres schema of the same Neon database.
 *
 * Three namespaces now share one database: `auth` belongs to the dashboard's
 * drizzle-kit config, `public` to the pipeline's, and `billing` to the
 * pipeline's as well - this file is listed beside `schema.ts` in the root
 * drizzle.config.ts. One migration owner, deliberately: money records that two
 * ledgers could each offer to drop are money records that will eventually be
 * dropped. See guides/DATABASE.md and guides/DODO-PAYMENTS-PLAN.md.
 *
 * Four rules run through the whole file:
 *
 *   1. Money is integer minor units. Never a float, never a computed total.
 *   2. Provider state and the local decision are separate columns. Dodo says
 *      what a subscription is; this deployment says whether work may start.
 *      Conflating them means an ambiguous provider status silently granting or
 *      denying runs somebody paid for.
 *   3. Anything that can arrive twice has a unique key to arrive against -
 *      webhook deliveries, checkout attempts, run reservations. Idempotency
 *      here is a constraint, not a code path that hopes.
 *   4. No foreign keys out of this schema. Billing records outlive the projects
 *      and accounts they refer to, because an invoice is evidence and deleting
 *      a repository is not a reason to lose it.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import type { BillingEnvironment, PlanKey } from '../billing/catalog.js';

export const billing = pgSchema('billing');

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

/**
 * Whether this deployment will start new work for an account, and why.
 *
 * Derived from provider state and written down, so admission asks one column
 * instead of re-deriving a policy from a status string at the moment a run
 * wants to begin.
 *
 *   `active`     - a Free grant or a confirmed paid period. Runs may start.
 *   `suspended`  - on hold, failed payment, expired. Existing results stay
 *                  readable; new runs do not start.
 *   `review`     - disputed, refunded, or a state nobody has taught this
 *                  deployment yet. A person decides; nothing is granted.
 */
export type AccessState = 'active' | 'suspended' | 'review';

/** Where a checkout attempt got to. Only one `open` attempt exists per account. */
export type CheckoutState = 'open' | 'completed' | 'expired' | 'abandoned' | 'failed';

/** A webhook delivery's progress through the inbox. */
export type InboxState = 'pending' | 'processed' | 'failed' | 'ignored';

/**
 * A run's claim on an allowance.
 *
 * `reserved` before any provider is called, `consumed` when the run finishes,
 * `released` when it never started or failed before doing paid work. A
 * reservation is what stops the last slot being spent twice.
 */
export type ReservationState = 'reserved' | 'consumed' | 'released';

/**
 * The thing that is billed: one organization's workspace.
 *
 * Keyed on the Better Auth organization rather than on a user, because that is
 * already what owns projects - see `projects.organizationId`. A solo customer
 * is an organization of one, so there is no second billing shape to grow team
 * support into later.
 *
 * `ownerUserId` is the one person who may buy, change, or cancel. Members of
 * the organization use what it bought; they do not get to change the charge.
 */
export const billingAccounts = billing.table(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `auth.organization.id`, as text. No FK: see the note at the top of the file. */
    organizationId: text('organization_id').notNull(),
    /** `auth.user.id` of the billing owner. Transferable, never plural. */
    ownerUserId: text('owner_user_id').notNull(),
    /** Which Dodo account this row belongs to. Test and live records never mix. */
    environment: text('environment').$type<BillingEnvironment>().notNull(),
    /**
     * Dodo's customer id, once one exists.
     *
     * Null on Free, which never contacts the provider. Matching is by this
     * stored id and never by email - an address is not proof of a customer.
     */
    dodoCustomerId: text('dodo_customer_id'),
    /**
     * The plan this deployment currently honours.
     *
     * Written only from confirmed provider events, never from a checkout
     * redirect: a successful-looking return can arrive before the payment does.
     */
    entitledPlan: text('entitled_plan').$type<PlanKey>().default('free').notNull(),
    /** Purchased seats, including the base package's. */
    purchasedSeats: integer('purchased_seats').default(1).notNull(),
    accessState: text('access_state').$type<AccessState>().default('active').notNull(),
    /** Why access is not `active`, in words a support reply can quote. */
    accessReason: text('access_reason'),
    ...timestamps,
  },
  (t) => [
    // One workspace, one billing account, per environment. Test mode gets its
    // own row for the same organization so a pilot cannot corrupt live state.
    uniqueIndex('billing_accounts_org_env').on(t.organizationId, t.environment),
    uniqueIndex('billing_accounts_customer')
      .on(t.environment, t.dodoCustomerId)
      .where(sql`dodo_customer_id is not null`),
    index('billing_accounts_owner').on(t.ownerUserId),
  ],
);

/**
 * A provider subscription, mirrored.
 *
 * `providerStatus` is Dodo's own string, stored as it arrived and not narrowed
 * to a union - a provider that adds a state should not fail an insert. The
 * decision that reads it is `billingAccounts.accessState`.
 *
 * `providerEventAt` is what makes late and reordered deliveries safe: an older
 * event carrying `active` must not overwrite a newer cancellation, so a write
 * compares timestamps before it lands.
 */
export const subscriptions = billing.table(
  'subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .references(() => billingAccounts.id, { onDelete: 'restrict' })
      .notNull(),
    environment: text('environment').$type<BillingEnvironment>().notNull(),
    providerSubscriptionId: text('provider_subscription_id').notNull(),
    planKey: text('plan_key').$type<PlanKey>().notNull(),
    /** The catalog version this was sold under. Prices move; sold terms do not. */
    planVersion: text('plan_version').notNull(),
    purchasedSeats: integer('purchased_seats').default(1).notNull(),
    providerStatus: text('provider_status').notNull(),
    /** The paid period, in UTC, as the provider defines it. */
    currentPeriodStart: timestamp('current_period_start', { withTimezone: true }),
    currentPeriodEnd: timestamp('current_period_end', { withTimezone: true }),
    /** Set when a cancellation is scheduled; work continues until it arrives. */
    cancelAt: timestamp('cancel_at', { withTimezone: true }),
    canceledAt: timestamp('canceled_at', { withTimezone: true }),
    /** A capacity or plan change confirmed for the next renewal, if any. */
    scheduledPlanKey: text('scheduled_plan_key').$type<PlanKey>(),
    scheduledSeats: integer('scheduled_seats'),
    /** When the provider says the state this row holds was true. */
    providerEventAt: timestamp('provider_event_at', { withTimezone: true }),
    /** When this row was last checked against the provider's current state. */
    reconciledAt: timestamp('reconciled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('subscriptions_provider_id').on(t.environment, t.providerSubscriptionId),
    index('subscriptions_account').on(t.accountId),
  ],
);

/**
 * One attempt to buy something, from before the hosted checkout opens.
 *
 * It exists so that a double-clicked button, a second tab, and a retried
 * request are the same attempt rather than three subscriptions. `requestKey` is
 * the caller's idempotency key; the partial unique index below is what enforces
 * one open attempt per account no matter how many callers race.
 */
export const checkoutAttempts = billing.table(
  'checkout_attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .references(() => billingAccounts.id, { onDelete: 'cascade' })
      .notNull(),
    environment: text('environment').$type<BillingEnvironment>().notNull(),
    planKey: text('plan_key').$type<PlanKey>().notNull(),
    requestedSeats: integer('requested_seats').default(1).notNull(),
    requestKey: text('request_key').notNull(),
    /** Dodo's checkout session id, once the provider has answered. */
    providerSessionId: text('provider_session_id'),
    state: text('state').$type<CheckoutState>().default('open').notNull(),
    /** Why it ended, when it ended badly. Never a provider payload. */
    failureReason: text('failure_reason'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('checkout_attempts_request_key').on(t.accountId, t.requestKey),
    uniqueIndex('checkout_attempts_one_open')
      .on(t.accountId)
      .where(sql`state = 'open'`),
    index('checkout_attempts_session').on(t.providerSessionId),
  ],
);

/**
 * A payment, as the provider reported it.
 *
 * Amounts are minor units in the currency the provider charged, not converted:
 * a total in the customer's currency is the number on their statement, and
 * converting it here would invent a figure nobody was charged.
 */
export const payments = billing.table(
  'payments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .references(() => billingAccounts.id, { onDelete: 'restrict' })
      .notNull(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    environment: text('environment').$type<BillingEnvironment>().notNull(),
    providerPaymentId: text('provider_payment_id').notNull(),
    status: text('status').notNull(),
    amountMinor: integer('amount_minor').notNull(),
    /** ISO 4217, upper case. */
    currency: text('currency').notNull(),
    /** The period this payment covers, when the provider says so. */
    periodStart: timestamp('period_start', { withTimezone: true }),
    periodEnd: timestamp('period_end', { withTimezone: true }),
    refundedMinor: integer('refunded_minor').default(0).notNull(),
    /** A dispute is not a cancellation. It is a flag for a person to look at. */
    disputed: boolean('disputed').default(false).notNull(),
    paidAt: timestamp('paid_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('payments_provider_id').on(t.environment, t.providerPaymentId),
    index('payments_account').on(t.accountId),
  ],
);

/**
 * Every webhook delivery, written down before it is acted on.
 *
 * The unique key is the provider's delivery id, so a redelivery collides
 * instead of applying twice. A row is marked `processed` only after the
 * business change it caused has committed - the other order acknowledges work
 * that a crash then loses.
 *
 * `payload` keeps the verified event for replay. Nothing here logs card
 * details; Dodo does not send them and this row is not where they would go.
 */
export const webhookDeliveries = billing.table(
  'webhook_deliveries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    environment: text('environment').$type<BillingEnvironment>().notNull(),
    /** The `webhook-id` header, unique per environment. */
    providerDeliveryId: text('provider_delivery_id').notNull(),
    type: text('type').notNull(),
    state: text('state').$type<InboxState>().default('pending').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    /** The last failure, for an operator replaying by hand. */
    error: text('error'),
    payload: jsonb('payload').notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('webhook_deliveries_provider_id').on(t.environment, t.providerDeliveryId),
    index('webhook_deliveries_state').on(t.state, t.receivedAt),
  ],
);

/**
 * One account's allowance for one period, with what has been claimed against it.
 *
 * The allowance is a snapshot, copied from the catalog when the period opens.
 * Reading the catalog at admission time instead would apply a price change
 * retroactively to a period somebody has already paid for.
 *
 * Paid periods follow the provider's boundaries. Free periods are monthly UTC
 * windows anchored to when the account was created, and the ledger survives an
 * upgrade and a cancellation - otherwise switching plans twice is a way to mint
 * fresh Free quota.
 */
export const usagePeriods = billing.table(
  'usage_periods',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .references(() => billingAccounts.id, { onDelete: 'restrict' })
      .notNull(),
    subscriptionId: uuid('subscription_id').references(() => subscriptions.id, {
      onDelete: 'set null',
    }),
    planKey: text('plan_key').$type<PlanKey>().notNull(),
    periodStart: timestamp('period_start', { withTimezone: true }).notNull(),
    periodEnd: timestamp('period_end', { withTimezone: true }).notNull(),
    /** The entitlement snapshot, so admission never recomputes a sold term. */
    runsAllowed: integer('runs_allowed').notNull(),
    seatsAllowed: integer('seats_allowed').notNull(),
    repositoriesAllowed: integer('repositories_allowed').notNull(),
    automaticRuns: boolean('automatic_runs').notNull(),
    /** Held by work that has been admitted and has not finished. */
    runsReserved: integer('runs_reserved').default(0).notNull(),
    /** Spent by work that finished. Reserved + consumed is what admission checks. */
    runsConsumed: integer('runs_consumed').default(0).notNull(),
    ...timestamps,
  },
  (t) => [
    // One period per account per start. A second grant for the same window is
    // the bug this index exists to make impossible.
    uniqueIndex('usage_periods_account_start').on(t.accountId, t.planKey, t.periodStart),
    index('usage_periods_account_window').on(t.accountId, t.periodEnd),
  ],
);

/**
 * One run's claim on a period, from before the first provider call.
 *
 * `invocationKey` is what makes the claim exactly once: a GitHub delivery id
 * for a push, a client key for a manual run. A redelivered webhook and a
 * retried request collide on it and reuse the reservation they already have. A
 * deliberate rerun is a different key on purpose, and costs another run.
 *
 * The run itself lives in `public.runs`; `runId` is filled in once one exists.
 * There is no foreign key to it, because a reservation is created before the
 * run and must survive its deletion.
 */
export const runReservations = billing.table(
  'run_reservations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: uuid('account_id')
      .references(() => billingAccounts.id, { onDelete: 'restrict' })
      .notNull(),
    usagePeriodId: uuid('usage_period_id')
      .references(() => usagePeriods.id, { onDelete: 'restrict' })
      .notNull(),
    /** `public.projects.id`. No FK: billing outlives the project. */
    projectId: uuid('project_id'),
    /** `public.runs.id`, once the run has been created. */
    runId: uuid('run_id'),
    commitSha: text('commit_sha'),
    invocationKey: text('invocation_key').notNull(),
    state: text('state').$type<ReservationState>().default('reserved').notNull(),
    /** Why it was released, when it was. */
    releaseReason: text('release_reason'),
    reservedAt: timestamp('reserved_at', { withTimezone: true }).defaultNow().notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('run_reservations_invocation').on(t.accountId, t.invocationKey),
    index('run_reservations_period').on(t.usagePeriodId, t.state),
    index('run_reservations_run').on(t.runId),
  ],
);

export const billingSchema = {
  billingAccounts,
  subscriptions,
  checkoutAttempts,
  payments,
  webhookDeliveries,
  usagePeriods,
  runReservations,
};
