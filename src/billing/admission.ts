/**
 * Admission: whether a run may start, and the claim it makes on an allowance.
 *
 * Checkout sells monthly run allowances and the dashboard shows them. This is
 * the part that makes them true - the one place a run asks for a slot before
 * anything is cloned, prompted, or sandboxed, and the one place that slot is
 * given back. guides/DODO-PAYMENTS-PLAN.md (phase 4) and
 * guides/ABUSE-PREVENTION-PLAN.md set the rules this file follows:
 *
 *   - A run reserves its slot atomically, inside the applicable Free or paid
 *     period, before any provider is called. Two pushes racing for the last
 *     run in an allowance get one run between them, not two.
 *   - Completion consumes the slot. A platform or provider failure, a skipped
 *     duplicate, or a triage skip releases it - exactly once, however many
 *     times the caller says so.
 *   - A preflight rejection consumes nothing. A refusal writes no row at all,
 *     so asking again after an upgrade is simply asking again.
 *   - The included allowance is a hard stop. There are no overages to fall
 *     into, so the last slot is the last slot.
 *
 * Off unless a deployment turns it on. A self-hosted install has no billing
 * account, no plan, and nobody to sell it one; metering it would only be a way
 * to stop somebody's own server documenting their own code. With enforcement
 * off, `admitRun` admits everything without touching the database and
 * `settleReservation` has nothing to settle.
 *
 * The usage period row and the account are opened here exactly as the
 * dashboard opens them - the period in the window `usageWindow` picks with the
 * catalog's allowance (see `./usage.ts` for why that is a copy of the
 * dashboard's insert rather than the same function), the account with the same
 * owner rule - so whichever side gets there first, the other finds the row it
 * would have written.
 */

import { asc, and, desc, eq, sql } from 'drizzle-orm';
import { pgSchema, text, timestamp, type PgUpdateSetSource } from 'drizzle-orm/pg-core';
import {
  billingAccounts,
  runReservations,
  subscriptions,
  usagePeriods,
  type ReservationState,
} from '../db/billing-schema.js';
import type { Executor } from '../db/executor.js';
import { databaseConfigured, getDb } from '../db/index.js';
import type { BillingEnvironment } from './catalog.js';
import type { AccessState } from './lifecycle.js';
import { ensureUsagePeriod, periodRequestFor } from './usage.js';

/** What asked for the run. Pushes are automatic; everything else is somebody asking. */
export type RunTrigger = 'push' | 'manual';

/**
 * Why a run was refused, as a stable code a caller can branch on.
 *
 *   `access`          - billing is suspended or under review, or there is no
 *                       owner to bill. Nothing about this run would change it.
 *   `automatic-runs`  - a push, on a plan whose runs start only on request.
 *   `allowance`       - the period's included runs are all claimed.
 */
export type RefusalCode = 'allowance' | 'automatic-runs' | 'access';

export interface AdmissionRequest {
  /** `auth.organization.id` of the workspace that owns the project. */
  organizationId: string;
  /** `public.projects.id`, when the run belongs to one. Recorded, not checked. */
  projectId: string | null;
  commitSha: string;
  trigger: RunTrigger;
  /**
   * The identity of this one request to run, and what makes asking twice safe.
   *
   * A push uses the GitHub delivery id, so a redelivery collides with the claim
   * it already made. A manual run uses a key minted once per click or API
   * request. A deliberate rerun is a new key on purpose, and costs another run.
   */
  invocationKey: string;
}

export type Admission =
  | {
      admitted: true;
      /** Null when allowances are not enforced on this deployment. */
      reservationId: string | null;
      /**
       * True when this invocation key had already been admitted.
       *
       * Nothing new was reserved. The reservation is the earlier one, in
       * whatever state it has reached - possibly already consumed or
       * released - and the work it covered has already been accepted once. A
       * caller must not start that work a second time on the strength of a
       * replay; settling the earlier reservation again is harmless.
       */
      replayed: boolean;
    }
  | { admitted: false; code: RefusalCode; reason: string };

/** The facts a decision is made from, gathered under the period's row lock. */
export interface AdmissionFacts {
  access: AccessState;
  /** The period's snapshot of whether pushes may start runs. */
  automaticRuns: boolean;
  trigger: RunTrigger;
  /** Runs the period includes. */
  allowed: number;
  /** Runs already claimed against it: reserved plus consumed. */
  used: number;
  /** When the period ends, for telling somebody when to come back. */
  resetsAt: Date;
}

export type AdmissionDecision =
  | { admitted: true }
  | { admitted: false; code: RefusalCode; reason: string };

/** How a reservation ended. */
export type Settlement = Exclude<ReservationState, 'reserved'>;

export interface SettlementDetails {
  /** `public.runs.id`, linking the claim to the run it paid for. Ignored unless a UUID. */
  runId?: string;
  /** Why a release happened, for whoever reconciles the ledger later. */
  reason?: string;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

/** Postgres `uuid` text form. Every id this file writes or matches is one. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Long enough for a sentence about what failed; short enough not to be a log. */
const RELEASE_REASON_LIMIT = 500;

/**
 * Whether this deployment meters runs at all.
 *
 * Both conditions, never one: `DOCXY_ENFORCE_ALLOWANCES` is the decision and
 * `DATABASE_URL` is where the ledger lives. The flag without a database would
 * be a metered deployment with nowhere to count, and the honest answer to that
 * is not to pretend; the database without the flag is every self-hosted
 * install that happens to use Postgres, which is not a customer.
 */
export function allowancesEnforced(): boolean {
  const flag = process.env.DOCXY_ENFORCE_ALLOWANCES?.trim().toLowerCase();
  return flag !== undefined && TRUTHY.has(flag) && databaseConfigured();
}

/**
 * Which Dodo account's ledger this deployment counts against.
 *
 * The same rule as the dashboard's `billingEnvironment()` in
 * web/src/lib/billing/config.ts, and it has to be: the two halves look up the
 * same organization's account row by environment, and if they disagreed a run
 * would be metered against a test-mode allowance the customer never sees.
 * Explicitly `live_mode` or it is `test_mode` - an unset or misspelt variable
 * should fail towards the ledger that takes no money.
 */
export function billingEnvironment(): BillingEnvironment {
  return process.env.DODO_PAYMENTS_ENVIRONMENT?.trim() === 'live_mode' ? 'live_mode' : 'test_mode';
}

/** A date somebody can act on: "November 14, 2026", in UTC like the period itself. */
function resetDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' }).format(date);
}

/**
 * Whether a run may start, from facts alone.
 *
 * Pure so the policy can be read and tested without a database. Checked in a
 * fixed order, and the order is the policy:
 *
 *   1. Access. A suspended or disputed account starts nothing, whatever is
 *      left of its allowance - that allowance is exactly what is in question.
 *   2. Trigger. A push on a plan without automatic runs is refused before it
 *      can count against anything, because it was never going to run.
 *   3. Allowance. Reserved work counts as used: a run that has started and not
 *      finished is holding its slot, and handing that slot to somebody else is
 *      how the last run in a period gets spent twice.
 *
 * Each refusal is one sentence addressed to the customer, saying what would
 * change the answer - an upgrade, a date, or a payment.
 */
export function admissionDecision(facts: AdmissionFacts): AdmissionDecision {
  if (facts.access === 'suspended') {
    return {
      admitted: false,
      code: 'access',
      reason:
        'Runs are paused for this workspace until its billing is settled; the billing owner can update the payment method on the billing page to resume them.',
    };
  }
  // Anything but `active`, including a state written by a later version of
  // this deployment that this one has never heard of. Unknown is not a licence.
  if (facts.access !== 'active') {
    return {
      admitted: false,
      code: 'access',
      reason:
        "Runs are paused while this workspace's billing is under review; contact support if you think this is a mistake.",
    };
  }

  if (facts.trigger === 'push' && !facts.automaticRuns) {
    return {
      admitted: false,
      code: 'automatic-runs',
      reason:
        'Pushes do not start runs on this plan; start the run from the dashboard, or upgrade to Pro to document every push automatically.',
    };
  }

  if (facts.used >= facts.allowed) {
    const allowance =
      facts.allowed === 1 ? 'the 1 run' : `all ${Math.max(0, facts.allowed)} runs`;
    return {
      admitted: false,
      code: 'allowance',
      reason: `This workspace has used ${allowance} included in its plan this period; the allowance resets on ${resetDate(facts.resetsAt)}, or the billing owner can upgrade the plan for more runs now.`,
    };
  }

  return { admitted: true };
}

/**
 * Better Auth's membership table, as much of it as admission reads.
 *
 * The pipeline's schema does not include the `auth` tables - they belong to the
 * dashboard's migrations - so this is a read-only window onto the columns the
 * owner lookup needs. It is deliberately not in `src/db/schema.ts` or
 * `billing-schema.ts`: those are the root drizzle-kit inputs, and a table
 * declared there is a table the root migrations would try to own.
 */
const auth = pgSchema('auth');
const members = auth.table('member', {
  organizationId: text('organization_id').notNull(),
  userId: text('user_id').notNull(),
  role: text('role').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

type AccountRow = typeof billingAccounts.$inferSelect;

/**
 * The longest-standing member holding the owner role, if any.
 *
 * The same rule the dashboard applies when it opens an account: the billing
 * owner is the organization's owner, not whichever request arrived first.
 * Better Auth stores several roles as one comma-separated string, so the role
 * is split rather than compared whole.
 */
async function organizationOwner(db: Executor, organizationId: string): Promise<string | null> {
  const rows = await db
    .select({ userId: members.userId, role: members.role })
    .from(members)
    .where(eq(members.organizationId, organizationId))
    .orderBy(asc(members.createdAt));
  const owner = rows.find((row) => row.role.split(',').some((role) => role.trim() === 'owner'));
  return owner?.userId ?? null;
}

async function findAccount(
  db: Executor,
  organizationId: string,
  environment: BillingEnvironment,
): Promise<AccountRow | null> {
  const rows = await db
    .select()
    .from(billingAccounts)
    .where(
      and(
        eq(billingAccounts.organizationId, organizationId),
        eq(billingAccounts.environment, environment),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * This organization's billing account, opened on Free if it has none.
 *
 * A first run is as good a first sight as a first billing page view: the
 * account is where the Free ledger lives, and it has to exist before a run can
 * be counted against it. `on conflict do nothing` against the per-environment
 * unique key makes the dashboard and the pipeline racing to create it land on
 * one row.
 *
 * Null when the organization has no owner on record. The dashboard falls back
 * to whoever is looking at the page; a run has nobody looking, and inventing a
 * billing owner from a push is how the wrong person ends up holding the card.
 */
async function ensureAccount(
  db: Executor,
  organizationId: string,
  environment: BillingEnvironment,
): Promise<AccountRow | null> {
  const found = await findAccount(db, organizationId, environment);
  if (found) return found;

  const owner = await organizationOwner(db, organizationId);
  if (!owner) return null;

  await db
    .insert(billingAccounts)
    .values({ organizationId, ownerUserId: owner, environment })
    .onConflictDoNothing({ target: [billingAccounts.organizationId, billingAccounts.environment] });

  const account = await findAccount(db, organizationId, environment);
  if (!account) {
    throw new Error(`the billing account for organization ${organizationId} could not be created`);
  }
  return account;
}

/**
 * The subscription a paid entitlement rests on: the most recent one.
 *
 * Same choice as the dashboard. An upgrade replaces a subscription rather than
 * running two, and if a provider ever leaves an older row behind, the newer one
 * is the one that was paid for.
 */
async function latestSubscription(db: Executor, accountId: string) {
  const rows = await db
    .select({
      id: subscriptions.id,
      currentPeriodStart: subscriptions.currentPeriodStart,
      currentPeriodEnd: subscriptions.currentPeriodEnd,
    })
    .from(subscriptions)
    .where(eq(subscriptions.accountId, accountId))
    .orderBy(desc(subscriptions.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

async function priorReservation(db: Executor, accountId: string, invocationKey: string) {
  const rows = await db
    .select({ id: runReservations.id })
    .from(runReservations)
    .where(
      and(
        eq(runReservations.accountId, accountId),
        eq(runReservations.invocationKey, invocationKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

const NO_OWNER =
  'This workspace has no owner on record to bill, so its runs cannot start until an organization owner is added.';

/**
 * Ask for a run, and claim its slot if the answer is yes.
 *
 * Call it once per request to run, before the run is queued and before any
 * provider is touched - a manual run, a rerun, a resumed run that has no
 * reservation yet, and a verified push alike. An admitted run holds its slot
 * until `settleReservation` is called with the id this returns.
 *
 * Exactly-once rests on two things. The usage period row is locked `for
 * update` before anything is counted, so every claim on one period queues
 * behind the one before it and reads the counters it left. And the reservation
 * row is unique per account and invocation key, so a second request with the
 * same key - a redelivered webhook, a retried POST - finds the first claim and
 * returns it instead of making another. The insert itself is `on conflict do
 * nothing`, which covers the one case the lock cannot: the same key arriving
 * in two different periods at once, either side of a renewal.
 *
 * A refusal writes nothing, so a refused request costs no run and asking again
 * after an upgrade or a reset is an ordinary first ask. A database failure
 * throws: with enforcement on, a run that cannot be counted does not start.
 */
export async function admitRun(request: AdmissionRequest): Promise<Admission> {
  if (!allowancesEnforced()) return { admitted: true, reservationId: null, replayed: false };

  const invocationKey = request.invocationKey.trim();
  if (!invocationKey) throw new Error('admitRun needs an invocation key to make the claim idempotent.');
  if (request.projectId !== null && !UUID.test(request.projectId)) {
    throw new Error(`admitRun was given "${request.projectId}" as a project id; it must be a projects.id UUID.`);
  }

  const db = getDb();
  const account = await ensureAccount(db, request.organizationId, billingEnvironment());
  if (!account) return { admitted: false, code: 'access', reason: NO_OWNER };

  const subscription = account.entitledPlan === 'free' ? null : await latestSubscription(db, account.id);
  const opened = await ensureUsagePeriod(db, periodRequestFor(account, subscription));

  return db.transaction(async (tx): Promise<Admission> => {
    const [period] = await tx
      .select()
      .from(usagePeriods)
      .where(eq(usagePeriods.id, opened.id))
      .for('update');
    if (!period) throw new Error(`usage period ${opened.id} disappeared while a run was being admitted`);

    // Under the lock, so a concurrent request with the same key has either
    // committed its claim (and is found here) or not started counting yet.
    const prior = await priorReservation(tx, account.id, invocationKey);
    if (prior) return { admitted: true, reservationId: prior.id, replayed: true };

    const decision = admissionDecision({
      access: account.accessState,
      automaticRuns: period.automaticRuns,
      trigger: request.trigger,
      allowed: period.runsAllowed,
      used: period.runsReserved + period.runsConsumed,
      resetsAt: period.periodEnd,
    });
    if (!decision.admitted) return decision;

    const [created] = await tx
      .insert(runReservations)
      .values({
        accountId: account.id,
        usagePeriodId: period.id,
        projectId: request.projectId,
        commitSha: request.commitSha,
        invocationKey,
      })
      .onConflictDoNothing({ target: [runReservations.accountId, runReservations.invocationKey] })
      .returning({ id: runReservations.id });

    if (!created) {
      // The same key, claimed against another period by a request that
      // committed while this one waited. Theirs is the claim; nothing is
      // counted twice, because the counter below is only reached on insert.
      const raced = await priorReservation(tx, account.id, invocationKey);
      if (raced) return { admitted: true, reservationId: raced.id, replayed: true };
      throw new Error(`the reservation for ${invocationKey} neither inserted nor exists`);
    }

    await tx
      .update(usagePeriods)
      .set({ runsReserved: sql`${usagePeriods.runsReserved} + 1`, updatedAt: sql`now()` })
      .where(eq(usagePeriods.id, period.id));

    return { admitted: true, reservationId: created.id, replayed: false };
  });
}

/**
 * Close a reservation: `consumed` when the run finished, `released` when it
 * did not do the work it was admitted for.
 *
 * Consume on completion - a completed run that proposed nothing still counts,
 * because the analysis that found nothing was paid for. Release on a platform
 * or provider failure, on a run the pipeline skipped as already documented, on
 * a push triage judged not worth documenting, and on an admitted request that
 * then never ran (a full queue, a duplicate the queue already held).
 *
 * Exactly once. The transition is an update guarded by `state = 'reserved'`,
 * so only the first call finds a row to change, and the period's counters move
 * in the same transaction as that transition or not at all. Every later call -
 * a retry, a `finally` that runs after a `catch` already settled, a resumed run
 * settling what its first attempt already settled - changes nothing and
 * returns false. A null id, which is what an unenforced admission hands back,
 * is the same no-op.
 *
 * Not gated on `allowancesEnforced()`: a reservation made while enforcement was
 * on still has a slot to give back after somebody turns it off.
 */
export async function settleReservation(
  reservationId: string | null,
  outcome: Settlement,
  details: SettlementDetails = {},
): Promise<boolean> {
  if (reservationId === null) return false;
  if (!UUID.test(reservationId)) {
    throw new Error(`"${reservationId}" is not a reservation id; pass the id admitRun returned.`);
  }

  const changes: PgUpdateSetSource<typeof runReservations> = {
    state: outcome,
    settledAt: sql`now()`,
    updatedAt: sql`now()`,
  };
  // A malformed run id would fail the whole update and leave the slot held,
  // which is a worse ledger than one missing a link.
  if (details.runId && UUID.test(details.runId)) changes.runId = details.runId;
  if (outcome === 'released' && details.reason) {
    changes.releaseReason = details.reason.slice(0, RELEASE_REASON_LIMIT);
  }

  return getDb().transaction(async (tx) => {
    const [settled] = await tx
      .update(runReservations)
      .set(changes)
      .where(and(eq(runReservations.id, reservationId), eq(runReservations.state, 'reserved')))
      .returning({ usagePeriodId: runReservations.usagePeriodId });
    if (!settled) return false;

    await tx
      .update(usagePeriods)
      .set({
        // Floored at zero: a counter that went negative would quietly be extra
        // allowance, and the ledger should never be able to grant runs.
        runsReserved: sql`greatest(${usagePeriods.runsReserved} - 1, 0)`,
        runsConsumed: sql`${usagePeriods.runsConsumed} + ${outcome === 'consumed' ? sql`1` : sql`0`}`,
        updatedAt: sql`now()`,
      })
      .where(eq(usagePeriods.id, settled.usagePeriodId));
    return true;
  });
}

/**
 * The reservation still held for one commit of one project, if any.
 *
 * How work a restart interrupted finds the slot it was admitted on. The run
 * record does not carry its reservation, but the reservation carries the
 * project and the commit - so a run resumed after a deploy settles the slot it
 * already holds instead of taking a second one, and a run that cannot be
 * resumed hands its slot back. Newest first, should one commit have been
 * admitted twice.
 */
export async function openReservation(projectId: string, commitSha: string): Promise<string | null> {
  if (!databaseConfigured() || !UUID.test(projectId)) return null;
  const [row] = await getDb()
    .select({ id: runReservations.id })
    .from(runReservations)
    .where(
      and(
        eq(runReservations.projectId, projectId),
        eq(runReservations.commitSha, commitSha),
        eq(runReservations.state, 'reserved'),
      ),
    )
    .orderBy(desc(runReservations.reservedAt))
    .limit(1);
  return row?.id ?? null;
}
