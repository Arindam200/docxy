/**
 * Billing accounts: who is billed, on what plan, and what that currently allows.
 *
 * The billed unit is the organization, because that is already what owns
 * projects - see `projects.organizationId`. A solo customer is an organization
 * of one, so there is no personal-billing shape to grow team support into
 * later, and no second code path deciding what a lone account may do.
 *
 * One person in that organization is the billing owner. Members use what the
 * organization bought; only the owner may buy, change capacity, or cancel.
 * Nothing here checks membership: callers arrive with a session that has
 * already been resolved to an organization, and pass the ids they proved.
 */

import { and, desc, eq } from "drizzle-orm";
import { entitlementsFor, type Entitlements, type PlanKey } from "@billing";
import { billingAccounts, subscriptions } from "@billing/schema";
import { billingEnvironment } from "./config";
import { getBillingDb } from "./db";
import { freePeriodBounds } from "@billing/periods";
import { ensureUsagePeriod, remainingRuns, type UsagePeriodRow } from "./periods";

export type BillingAccountRow = typeof billingAccounts.$inferSelect;
export type SubscriptionRow = typeof subscriptions.$inferSelect;

/**
 * This organization's billing account, creating it if it has none.
 *
 * Every organization gets one at first sight, including the ones that will only
 * ever be Free: the account is where the Free ledger lives, and an upgrade
 * followed by a cancellation has to land back on the same row. Creating it
 * lazily on the first paid action instead would mean a fresh Free quota is one
 * cancellation away.
 *
 * Test and live mode get separate rows for the same organization, so a pilot
 * cannot write over live entitlements.
 */
export async function ensureBillingAccount(
  organizationId: string,
  ownerUserId: string,
): Promise<BillingAccountRow> {
  const db = getBillingDb();
  const environment = billingEnvironment();

  await db
    .insert(billingAccounts)
    .values({ organizationId, ownerUserId, environment })
    .onConflictDoNothing({
      target: [billingAccounts.organizationId, billingAccounts.environment],
    });

  const account = await findBillingAccount(organizationId);
  if (!account) {
    throw new Error(`the billing account for organization ${organizationId} could not be created`);
  }
  return account;
}

/** This organization's billing account in the current environment, or null. */
export async function findBillingAccount(
  organizationId: string,
): Promise<BillingAccountRow | null> {
  const rows = await getBillingDb()
    .select()
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.organizationId, organizationId),
        eq(billingAccounts.environment, billingEnvironment()),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The subscription this account's paid entitlement rests on, or null.
 *
 * Most recent first, because an upgrade replaces a subscription rather than
 * running two - and if a provider ever leaves an older row behind, the newer
 * one is the one that was paid for.
 */
export async function findSubscription(accountId: string): Promise<SubscriptionRow | null> {
  const rows = await getBillingDb()
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export interface Entitlement {
  account: BillingAccountRow;
  /** The plan this deployment currently honours - not what a checkout attempted. */
  plan: PlanKey;
  entitlements: Entitlements;
  period: UsagePeriodRow;
  /** Allowance left in the current period, reserved work included. */
  runsLeft: number;
  subscription: SubscriptionRow | null;
  /** False while the account is suspended or under review, whatever it bought. */
  canStartRuns: boolean;
}

/**
 * What this organization may do right now.
 *
 * Reads the local decision (`entitledPlan`, `accessState`) rather than the
 * provider's status: those are separate columns on purpose, because an
 * ambiguous provider state must not silently grant or deny work somebody paid
 * for. Webhook processing moves the local decision; this only reports it.
 *
 * Opening the period is a write, and it belongs here rather than in a nightly
 * job: the first question anyone asks about an allowance is the moment it
 * should exist.
 */
export async function resolveEntitlement(
  organizationId: string,
  ownerUserId: string,
): Promise<Entitlement> {
  const account = await ensureBillingAccount(organizationId, ownerUserId);
  const plan = account.entitledPlan;
  const subscription = plan === "free" ? null : await findSubscription(account.id);

  // A paid plan uses the provider's own period boundaries. Falling back to the
  // Free window when a paid subscription has not reported them yet keeps the
  // account metered rather than unmetered - an unknown period is not a licence.
  const paidBounds =
    subscription?.currentPeriodStart && subscription.currentPeriodEnd
      ? { start: subscription.currentPeriodStart, end: subscription.currentPeriodEnd }
      : null;

  const period = await ensureUsagePeriod(getBillingDb(), {
    accountId: account.id,
    planKey: plan,
    seats: account.purchasedSeats,
    bounds: paidBounds ?? freePeriodBounds(account.createdAt),
    subscriptionId: paidBounds ? (subscription?.id ?? null) : null,
  });

  return {
    account,
    plan,
    entitlements: entitlementsFor(plan, account.purchasedSeats),
    period,
    runsLeft: remainingRuns(period),
    subscription,
    canStartRuns: account.accessState === "active" && remainingRuns(period) > 0,
  };
}

/** Whether this user is the one person who may spend money for this account. */
export function isBillingOwner(account: BillingAccountRow, userId: string): boolean {
  return account.ownerUserId === userId;
}
