/**
 * The billing tables, against a real Postgres.
 *
 * Not a unit test and deliberately not named `*.test.ts`: it needs
 * `DATABASE_URL` and it writes rows. What it proves cannot be proved anywhere
 * else — every guarantee billing rests on is a database constraint, and a
 * constraint that has never been violated on purpose is a constraint nobody has
 * checked. Two tabs racing a checkout, a redelivered webhook, two pushes
 * claiming the last run in an allowance: each of those is one index doing its
 * job, and each is exercised below.
 *
 *   cd web && npm run test:billing
 *
 * Everything it creates is namespaced to a random `test-org-…` id and deleted
 * at the end, including after a failure. It never reads or writes `public` or
 * `auth`, and it runs in whichever environment `DODO_PAYMENTS_ENVIRONMENT`
 * names — test_mode unless a deployment says otherwise.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { entitlementsFor, plans } from "@billing";
import { freePeriodBounds } from "@billing/periods";
import {
  billingAccounts,
  checkoutAttempts,
  payments,
  runReservations,
  subscriptions,
  usagePeriods,
  webhookDeliveries,
} from "@billing/schema";
import {
  ensureBillingAccount,
  isBillingOwner,
  resolveEntitlement,
} from "@/lib/billing/accounts";
import { billingEnvironment } from "@/lib/billing/config";
import { getBillingDb } from "@/lib/billing/db";
import { ensureUsagePeriod, remainingRuns } from "@/lib/billing/periods";

for (const file of [".env.local", ".env", "../.env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    // Absent or unreadable; the next candidate (or the ambient env) covers it.
  }
}

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. This test needs a real Postgres to say anything.");
  process.exit(1);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ok   ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

/** The Postgres error code a failed write carried, or null if it succeeded. */
async function violation<T>(work: () => Promise<T>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (cause) {
    const code = cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
    return code ?? `no code: ${cause instanceof Error ? cause.message : String(cause)}`;
  }
}

const db = getBillingDb();
const environment = billingEnvironment();
const organizationId = `test-org-${randomUUID()}`;
const otherOrganizationId = `test-org-${randomUUID()}`;
const ownerUserId = `test-user-${randomUUID()}`;

console.log(`billing integration · environment ${environment} · org ${organizationId}\n`);

try {
  // --- one workspace, one account -----------------------------------------
  const account = await ensureBillingAccount(organizationId, ownerUserId);
  check("an organization gets a billing account", Boolean(account.id));
  check("free is where every account starts", account.entitledPlan === "free");
  check("and it may start work", account.accessState === "active");
  check("with no provider customer behind it", account.dodoCustomerId === null);
  check("the owner is the one who may spend", isBillingOwner(account, ownerUserId));
  check("and nobody else is", !isBillingOwner(account, "someone-else"));

  const again = await ensureBillingAccount(organizationId, ownerUserId);
  check("asking twice does not make two accounts", again.id === account.id);

  // Five callers arriving together is the real case: a dashboard page and its
  // widgets all resolving an entitlement on the same first request.
  await Promise.all(
    Array.from({ length: 5 }, () => ensureBillingAccount(organizationId, ownerUserId)),
  );
  const accountRows = await db
    .select()
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.organizationId, organizationId),
        eq(billingAccounts.environment, environment),
      ),
    );
  check("and five at once still make one", accountRows.length === 1, `got ${accountRows.length}`);

  const duplicate = await violation(() =>
    db.insert(billingAccounts).values({ organizationId, ownerUserId, environment }),
  );
  check("a second account for the same org is refused", duplicate === "23505", `got ${duplicate}`);

  // --- the free allowance ---------------------------------------------------
  const entitlement = await resolveEntitlement(organizationId, ownerUserId);
  check("free allows three runs", entitlement.entitlements.runsPerMonth === 3);
  check("and one repository", entitlement.entitlements.repositories === 1);
  check("and no run starts from a push", entitlement.entitlements.automaticRuns === false);
  check("all three are still there", entitlement.runsLeft === 3);
  check("so work may start", entitlement.canStartRuns);
  check("with no subscription behind it", entitlement.subscription === null);

  const expected = freePeriodBounds(account.createdAt);
  check(
    "the period is anchored to the account, not the calendar",
    entitlement.period.periodStart.getTime() === expected.start.getTime(),
  );
  check(
    "and it resets a month later",
    entitlement.period.periodEnd.getTime() === expected.end.getTime(),
  );
  check(
    "the allowance is a snapshot, not a lookup",
    entitlement.period.runsAllowed === plans.free.entitlements.runsPerMonth,
  );

  // Two pushes landing together must not open two periods and two allowances.
  await Promise.all(
    Array.from({ length: 5 }, () =>
      ensureUsagePeriod(db, {
        accountId: account.id,
        planKey: "free",
        seats: 1,
        bounds: expected,
        subscriptionId: null,
      }),
    ),
  );
  const periodRows = await db
    .select()
    .from(usagePeriods)
    .where(eq(usagePeriods.accountId, account.id));
  check("one period, however many callers", periodRows.length === 1, `got ${periodRows.length}`);

  // --- what a claimed run does to the allowance ----------------------------
  await db
    .update(usagePeriods)
    .set({ runsReserved: 1, runsConsumed: 1 })
    .where(eq(usagePeriods.id, entitlement.period.id));
  const spent = await resolveEntitlement(organizationId, ownerUserId);
  check("reserved work counts before it finishes", spent.runsLeft === 1);
  check("and the account may still start one more", spent.canStartRuns);

  await db
    .update(usagePeriods)
    .set({ runsReserved: 1, runsConsumed: 2 })
    .where(eq(usagePeriods.id, entitlement.period.id));
  const exhausted = await resolveEntitlement(organizationId, ownerUserId);
  check("an exhausted allowance is exhausted", exhausted.runsLeft === 0);
  check("and stops new work", !exhausted.canStartRuns);
  check("without ever going negative", remainingRuns({ ...exhausted.period, runsConsumed: 99 }) === 0);

  // A suspended account may not start work whatever its allowance says.
  await db
    .update(billingAccounts)
    .set({ accessState: "suspended", accessReason: "test" })
    .where(eq(billingAccounts.id, account.id));
  await db
    .update(usagePeriods)
    .set({ runsReserved: 0, runsConsumed: 0 })
    .where(eq(usagePeriods.id, entitlement.period.id));
  const suspended = await resolveEntitlement(organizationId, ownerUserId);
  check("a suspended account has its allowance", suspended.runsLeft === 3);
  check("and still may not use it", !suspended.canStartRuns);
  await db
    .update(billingAccounts)
    .set({ accessState: "active", accessReason: null })
    .where(eq(billingAccounts.id, account.id));

  // --- one open checkout at a time -----------------------------------------
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await db
    .insert(checkoutAttempts)
    .values({
      accountId: account.id,
      environment,
      planKey: "pro",
      requestedSeats: 1,
      requestKey: "attempt-one",
      expiresAt,
    });

  const secondOpen = await violation(() =>
    db.insert(checkoutAttempts).values({
      accountId: account.id,
      environment,
      planKey: "team",
      requestedSeats: 5,
      requestKey: "attempt-two",
      expiresAt,
    }),
  );
  check("a second tab cannot open a second checkout", secondOpen === "23505", `got ${secondOpen}`);

  const sameKey = await violation(() =>
    db.insert(checkoutAttempts).values({
      accountId: account.id,
      environment,
      planKey: "pro",
      requestedSeats: 1,
      requestKey: "attempt-one",
      expiresAt,
    }),
  );
  check("and a retried request is the same attempt", sameKey === "23505", `got ${sameKey}`);

  await db
    .update(checkoutAttempts)
    .set({ state: "completed", completedAt: new Date() })
    .where(eq(checkoutAttempts.requestKey, "attempt-one"));
  const afterClose = await violation(() =>
    db.insert(checkoutAttempts).values({
      accountId: account.id,
      environment,
      planKey: "team",
      requestedSeats: 5,
      requestKey: "attempt-three",
      expiresAt,
    }),
  );
  check("a finished attempt frees the slot", afterClose === null, `got ${afterClose}`);

  // --- a paid subscription --------------------------------------------------
  const periodStart = new Date("2026-09-01T00:00:00.000Z");
  const periodEnd = new Date("2026-10-01T00:00:00.000Z");
  const providerSubscriptionId = `sub_${randomUUID()}`;
  const [subscription] = await db
    .insert(subscriptions)
    .values({
      accountId: account.id,
      environment,
      providerSubscriptionId,
      planKey: "team",
      planVersion: "2026-09-10",
      purchasedSeats: 8,
      providerStatus: "active",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      providerEventAt: new Date(),
    })
    .returning();
  check("a subscription can be recorded", Boolean(subscription?.id));

  const replay = await violation(() =>
    db.insert(subscriptions).values({
      accountId: account.id,
      environment,
      providerSubscriptionId,
      planKey: "team",
      planVersion: "2026-09-10",
      providerStatus: "active",
    }),
  );
  check("the same subscription cannot arrive twice", replay === "23505", `got ${replay}`);

  await db
    .update(billingAccounts)
    .set({ entitledPlan: "team", purchasedSeats: 8 })
    .where(eq(billingAccounts.id, account.id));
  const paid = await resolveEntitlement(organizationId, ownerUserId);
  check("the paid plan is what the account honours", paid.plan === "team");
  check("eight seats bring eight repositories", paid.entitlements.repositories === 8);
  check(
    "and their share of the pool",
    paid.entitlements.runsPerMonth === entitlementsFor("team", 8).runsPerMonth,
  );
  check(
    "the paid period is the provider's, not ours",
    paid.period.periodStart.getTime() === periodStart.getTime(),
  );
  check("it is a different period from the free one", paid.period.id !== entitlement.period.id);
  check("and it carries the subscription", paid.period.subscriptionId === subscription?.id);

  const freeLedger = await db
    .select()
    .from(usagePeriods)
    .where(and(eq(usagePeriods.accountId, account.id), eq(usagePeriods.planKey, "free")));
  check("the free ledger survives the upgrade", freeLedger.length === 1);

  // --- one run, one claim ---------------------------------------------------
  const invocationKey = `github:${randomUUID()}`;
  await db.insert(runReservations).values({
    accountId: account.id,
    usagePeriodId: paid.period.id,
    invocationKey,
    projectId: randomUUID(),
    commitSha: "abc123",
  });
  const redelivered = await violation(() =>
    db.insert(runReservations).values({
      accountId: account.id,
      usagePeriodId: paid.period.id,
      invocationKey,
    }),
  );
  check("a redelivered push claims nothing new", redelivered === "23505", `got ${redelivered}`);

  const rerun = await violation(() =>
    db.insert(runReservations).values({
      accountId: account.id,
      usagePeriodId: paid.period.id,
      invocationKey: `manual:${randomUUID()}`,
    }),
  );
  check("but a deliberate rerun does", rerun === null, `got ${rerun}`);

  // --- a webhook delivery arrives exactly once ------------------------------
  const deliveryId = `whd_${randomUUID()}`;
  await db.insert(webhookDeliveries).values({
    environment,
    providerDeliveryId: deliveryId,
    type: "subscription.active",
    payload: { note: "billing integration test" },
  });
  const duplicateDelivery = await violation(() =>
    db.insert(webhookDeliveries).values({
      environment,
      providerDeliveryId: deliveryId,
      type: "subscription.active",
      payload: { note: "billing integration test" },
    }),
  );
  check("a redelivered webhook collides", duplicateDelivery === "23505", `got ${duplicateDelivery}`);

  // --- the provider customer is unique, and null is not a value -------------
  const other = await ensureBillingAccount(otherOrganizationId, ownerUserId);
  check("a second organization gets its own account", other.id !== account.id);
  check("two accounts may both have no customer", other.dodoCustomerId === null);

  const customerId = `cus_${randomUUID()}`;
  await db
    .update(billingAccounts)
    .set({ dodoCustomerId: customerId })
    .where(eq(billingAccounts.id, account.id));
  const stolenCustomer = await violation(() =>
    db
      .update(billingAccounts)
      .set({ dodoCustomerId: customerId })
      .where(eq(billingAccounts.id, other.id)),
  );
  check("one customer belongs to one account", stolenCustomer === "23505", `got ${stolenCustomer}`);

  // --- money records outlive the things they refer to -----------------------
  await db.insert(payments).values({
    accountId: account.id,
    subscriptionId: subscription?.id ?? null,
    environment,
    providerPaymentId: `pay_${randomUUID()}`,
    status: "succeeded",
    amountMinor: 20_400,
    currency: "USD",
    periodStart,
    periodEnd,
    paidAt: new Date(),
  });
  const deletedTooSoon = await violation(() =>
    db.delete(billingAccounts).where(eq(billingAccounts.id, account.id)),
  );
  check(
    "an account with payments cannot be deleted out from under them",
    deletedTooSoon === "23503",
    `got ${deletedTooSoon}`,
  );
} finally {
  // Cleanup, in dependency order, whatever happened above.
  const ids = sql`(select id from ${billingAccounts} where ${billingAccounts.organizationId} in (${organizationId}, ${otherOrganizationId}))`;
  await db.delete(runReservations).where(sql`${runReservations.accountId} in ${ids}`);
  await db.delete(payments).where(sql`${payments.accountId} in ${ids}`);
  await db.delete(usagePeriods).where(sql`${usagePeriods.accountId} in ${ids}`);
  await db.delete(subscriptions).where(sql`${subscriptions.accountId} in ${ids}`);
  await db.delete(checkoutAttempts).where(sql`${checkoutAttempts.accountId} in ${ids}`);
  await db
    .delete(webhookDeliveries)
    .where(sql`${webhookDeliveries.payload}->>'note' = 'billing integration test'`);
  await db
    .delete(billingAccounts)
    .where(sql`${billingAccounts.organizationId} in (${organizationId}, ${otherOrganizationId})`);

  const left = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(billingAccounts)
    .where(sql`${billingAccounts.organizationId} like 'test-org-%'`);
  check("the test leaves nothing behind", (left[0]?.n ?? -1) === 0, `got ${left[0]?.n}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
