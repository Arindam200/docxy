/**
 * Whether a hosted checkout has already taken somebody's money.
 *
 * The local record cannot say. A checkout attempt stays open until the payment
 * webhook closes it, and that webhook can land minutes after the customer has
 * paid - or after the attempt's own half-hour lock has run out. Releasing the
 * attempt on local evidence alone is how one person paid for Pro, clicked Team
 * before the webhook arrived, and was sold a second subscription beside the
 * first. So before an attempt that reached Dodo is let go, Dodo is asked.
 *
 * No database or client imports: the lookup is passed in, which is what lets
 * the decision be tested without a provider account.
 */

import type { IntentStatus } from "dodopayments/resources/payments";

/** What Dodo says about one checkout session, as far as this file reads it. */
export interface SessionStatus {
  payment_status?: IntentStatus | null;
}

/**
 * Payment states in which money has moved, or is moving without anything
 * more from the customer.
 *
 * The others are left out on purpose. `requires_customer_action`,
 * `requires_confirmation` and `requires_payment_method` wait on the customer,
 * and if they never come back nothing settles; refusing a new checkout on
 * those would lock somebody out of buying for as long as Dodo keeps an
 * abandoned 3-D Secure prompt around. `failed`, `cancelled` and no payment at
 * all took nothing.
 */
const SETTLING = new Set<IntentStatus>([
  "succeeded",
  "processing",
  "requires_capture",
  "requires_merchant_action",
  "partially_captured",
  "partially_captured_and_capturable",
]);

/**
 * `paid` when the session's payment has gone through or is going through,
 * `unpaid` when it has not, and `unknown` when Dodo could not be asked. An
 * unknown answer is not "unpaid": treating a provider outage as permission to
 * open a second checkout is the double charge this exists to prevent.
 */
export type SessionPayment = "paid" | "unpaid" | "unknown";

export function paymentSettling(status: IntentStatus | null | undefined): boolean {
  return status ? SETTLING.has(status) : false;
}

export async function sessionPayment(
  sessionId: string,
  retrieve: (id: string) => Promise<SessionStatus>,
): Promise<SessionPayment> {
  try {
    const session = await retrieve(sessionId);
    return paymentSettling(session.payment_status) ? "paid" : "unpaid";
  } catch {
    return "unknown";
  }
}
