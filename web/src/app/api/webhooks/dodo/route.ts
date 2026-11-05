/**
 * Dodo's webhook endpoint.
 *
 * The only door through which a payment changes what somebody may do here, and
 * it trusts exactly one thing: a signature over the raw body. Not the redirect
 * the customer came back on, not a field in the JSON, not the fact that a
 * request reached this URL.
 *
 * The status code is the contract with Dodo's retry machinery:
 *
 *   400  the signature did not verify. Never retried, and nothing is recorded:
 *        an unverified body is a stranger's claim that somebody paid.
 *   200  handled, duplicated, ignored, or queued for review. Stop sending.
 *   500  something transient broke. Please send it again.
 *
 * A verified event that cannot be applied - an unknown account, a product this
 * deployment does not sell - is *not* a 500. Retrying will not teach it the
 * answer. It is stored with the reason, answered 200, and left for
 * reconciliation, because the alternative is Dodo retrying for days while
 * nothing changes.
 */

import { billingConfig } from "@/lib/billing/config";
import { getDodo } from "@/lib/billing/client";
import { deferDelivery, processDelivery, recordDelivery, type ProviderEvent } from "@/lib/billing/sync";

/** Standard Webhooks' three headers, which is what the signature covers. */
const SIGNATURE_HEADERS = ["webhook-id", "webhook-signature", "webhook-timestamp"];

export async function POST(request: Request): Promise<Response> {
  // A deployment with no webhook key cannot verify anything. 503 rather than
  // 200, so the deliveries queue up and arrive once it is configured.
  if (!billingConfig()) {
    return new Response("billing is not configured on this deployment", { status: 503 });
  }

  // The raw text, before anything parses it. `request.json()` here would verify
  // a signature over a re-serialised body, which is a different body.
  const body = await request.text();

  const headers: Record<string, string> = {};
  for (const name of SIGNATURE_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }

  let event: ProviderEvent;
  try {
    event = getDodo().webhooks.unwrap(body, { headers });
  } catch {
    return new Response("signature verification failed", { status: 400 });
  }

  const deliveryId = headers["webhook-id"];
  if (!deliveryId) {
    return new Response("the delivery carried no webhook-id", { status: 400 });
  }

  // Rule one: write it down before acting on it, and let the unique index
  // answer the question of whether this is the second time it arrived.
  let delivery: { id: string } | null;
  try {
    delivery = await recordDelivery(deliveryId, event);
  } catch (cause) {
    console.error(`billing: could not record delivery ${deliveryId}: ${message(cause)}`);
    return new Response("could not record the delivery", { status: 500 });
  }

  if (!delivery) {
    // Already settled. Acknowledged rather than reprocessed: this is how a
    // redelivery stops being a second subscription. (A delivery left pending
    // by a failed attempt does come back here, and is processed again.)
    return Response.json({ received: true, duplicate: true });
  }

  try {
    const outcome = await processDelivery(delivery.id, event);
    if (!outcome) {
      // A concurrent copy of this delivery settled it while this one waited.
      return Response.json({ received: true, duplicate: true });
    }
    if (outcome.state === "failed") {
      console.error(`billing: ${event.type} (${deliveryId}) needs review: ${outcome.note}`);
    }
    return Response.json({ received: true, state: outcome.state });
  } catch (cause) {
    // Transient: the database was unreachable, a write raced. The transaction
    // rolled back, the delivery row is still pending, and Dodo's retry will
    // find it that way and process it again.
    const note = message(cause);
    console.error(`billing: ${event.type} (${deliveryId}) failed, asking for a retry: ${note}`);
    try {
      await deferDelivery(delivery.id, note);
    } catch {
      // The database is the thing that is broken. The 500 is the signal.
    }
    return new Response("could not process the delivery", { status: 500 });
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
