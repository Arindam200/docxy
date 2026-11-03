/**
 * What a provider state means for this deployment.
 *
 * Pure, and separate from both the database and the SDK, because this is the
 * judgement that decides whether somebody's runs start tomorrow. It is the one
 * piece of billing that has to be readable on its own and testable without a
 * connection string, a webhook, or a card.
 *
 * The rule running through it: a provider status is evidence, not an
 * instruction. Dodo says what a subscription is; this file says what that means
 * for access, and the answer is written to a column so admission reads a
 * decision rather than re-deriving one at the moment a run wants to begin.
 */

/**
 * Whether this deployment will start new work for an account, and why.
 *
 *   `active`     - a Free grant or a confirmed paid period. Runs may start.
 *   `suspended`  - on hold, overdue, paused. Existing results stay readable;
 *                  new runs do not start.
 *   `review`     - disputed, or a state nobody has taught this deployment yet.
 *                  A person decides; nothing is granted automatically.
 */
export type AccessState = 'active' | 'suspended' | 'review';

/** What an account's entitled plan becomes when a decision is applied. */
export type PlanOutcome =
  /** Take the plan the subscription was sold as. */
  | 'subscription'
  /** Fall back to the Free allowance, keeping the existing Free ledger. */
  | 'free'
  /** Leave it alone: this event says nothing about entitlement. */
  | 'unchanged';

export interface LifecycleDecision {
  plan: PlanOutcome;
  access: AccessState;
  /** Shown to the customer and quotable in a support reply. Null when active. */
  reason: string | null;
}

/**
 * What a subscription status means for access.
 *
 * `cancelAtPeriodEnd` is the difference between the two things people call
 * cancellation. A scheduled cancellation leaves the status `active` and the
 * paid period intact: somebody paid for this month and should have it. An
 * actual `cancelled` status is the end, and the account returns to Free.
 *
 * `past_due` blocks new work, deliberately, even though a grace period may
 * still be running. The alternative is spending model and sandbox budget on a
 * renewal that has already failed once, and the work resumes the moment the
 * payment recovers.
 */
export function subscriptionDecision(
  status: string,
  options: { cancelAtPeriodEnd?: boolean } = {},
): LifecycleDecision {
  switch (status) {
    case 'active':
      return {
        plan: 'subscription',
        access: 'active',
        reason: options.cancelAtPeriodEnd
          ? 'This plan is set to end at the close of the paid period.'
          : null,
      };

    case 'on_hold':
      return {
        plan: 'subscription',
        access: 'suspended',
        reason: 'A renewal payment did not go through. Update the payment method to resume runs.',
      };

    case 'past_due':
      return {
        plan: 'subscription',
        access: 'suspended',
        reason: 'A payment is overdue. Runs resume as soon as it clears.',
      };

    case 'paused':
      return {
        plan: 'subscription',
        access: 'suspended',
        reason: 'This subscription is paused.',
      };

    // The mandate was never authorised, so nothing was bought and nothing is
    // owed. The account stays on the Free allowance it already had.
    case 'failed':
      return {
        plan: 'free',
        access: 'active',
        reason: 'The subscription could not be set up, so no plan was started.',
      };

    case 'cancelled':
    case 'expired':
      return { plan: 'free', access: 'active', reason: null };

    // Authorisation is still in flight. Granting here would hand out a paid
    // allowance on the strength of an intention.
    case 'pending':
      return { plan: 'unchanged', access: 'active', reason: null };

    default:
      return {
        plan: 'unchanged',
        access: 'review',
        reason: `Dodo reported a subscription state this deployment does not recognise (${status}). Billing is paused for review.`,
      };
  }
}

/**
 * Subscription states that still govern an account.
 *
 * A subscription in one of these is either paid for or waiting on a payment,
 * so it decides what the account may do. Two places depend on the same list:
 * checkout, which must not open a second subscription beside one of these, and
 * sync, where the end of an *older* subscription must not drop an account to
 * Free while a newer one is still running.
 */
export const LIVE_SUBSCRIPTION_STATUSES = ['active', 'on_hold', 'past_due', 'paused'] as const;

export function isLiveSubscription(status: string | null | undefined): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.some((live) => live === status);
}

/** Whether a dispute event leaves the dispute open, rather than settling it. */
export function disputeIsOpen(type: string): boolean {
  return type === 'dispute.opened' || type === 'dispute.challenged';
}

/**
 * What a dispute means for access.
 *
 * A dispute is not a cancellation and must not be processed as one: the money
 * is contested, not returned, and the account may well be in the right. It
 * moves to review, where a person decides, and a win puts it back.
 */
export function disputeDecision(type: string): LifecycleDecision {
  switch (type) {
    case 'dispute.opened':
    case 'dispute.challenged':
      return {
        plan: 'unchanged',
        access: 'review',
        reason: 'A payment on this account is disputed and is being looked at.',
      };

    // Accepting a dispute is conceding it: the money goes back, exactly as if
    // it had been lost, and the account is in the same position afterwards.
    case 'dispute.lost':
    case 'dispute.accepted':
      return {
        plan: 'unchanged',
        access: 'suspended',
        reason: 'A disputed payment was lost. Billing needs to be settled before runs resume.',
      };

    // "No longer held for this dispute", not "runs start". The account goes
    // back to whatever its subscription says, which sync reads at the time: a
    // won dispute on a subscription that went on hold meanwhile is still on hold.
    case 'dispute.won':
    case 'dispute.cancelled':
    case 'dispute.expired':
      return { plan: 'unchanged', access: 'active', reason: null };

    default:
      return { plan: 'unchanged', access: 'review', reason: `Unrecognised dispute event (${type}).` };
  }
}

/**
 * Where a customer coming back from hosted checkout has landed.
 *
 * Dodo does not document the query string it appends to a return URL, so this
 * reads generously and trusts nothing: the value only chooses the first thing
 * the page says. What the account may actually do comes from the webhook that
 * follows, which is the only evidence that money moved.
 */
export type ReturnOutcome = 'succeeded' | 'processing' | 'cancelled' | 'failed' | 'unknown';

export function redirectOutcome(status: string | null | undefined): ReturnOutcome {
  const value = status?.trim().toLowerCase();
  if (!value) return 'unknown';

  if (['succeeded', 'success', 'successful', 'active', 'paid', 'complete', 'completed'].includes(value)) {
    return 'succeeded';
  }
  if (
    [
      'processing',
      'pending',
      'requires_customer_action',
      'requires_merchant_action',
      'requires_confirmation',
      'requires_capture',
    ].includes(value)
  ) {
    return 'processing';
  }
  if (['cancelled', 'canceled', 'abandoned', 'cancel'].includes(value)) return 'cancelled';
  if (['failed', 'failure', 'declined', 'requires_payment_method', 'error'].includes(value)) {
    return 'failed';
  }
  return 'unknown';
}
