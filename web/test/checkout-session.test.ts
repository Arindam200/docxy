import assert from "node:assert/strict";
import { test } from "node:test";
import type { IntentStatus } from "dodopayments/resources/payments";
import { paymentSettling, sessionPayment } from "../src/lib/billing/provider-session";

/** A stand-in for `checkoutSessions.retrieve`, recording what it was asked. */
function provider(status: IntentStatus | null | undefined) {
  const asked: string[] = [];
  return {
    asked,
    retrieve: async (id: string) => {
      asked.push(id);
      return { payment_status: status };
    },
  };
}

test("a paid checkout holds the slot even before its webhook arrives", async () => {
  // The double charge: Pro paid, the webhook not yet in, Team clicked.
  for (const status of ["succeeded", "processing", "requires_capture", "requires_merchant_action", "partially_captured"] as const) {
    const dodo = provider(status);
    assert.equal(await sessionPayment("cks_1", dodo.retrieve), "paid", status);
    assert.deepEqual(dodo.asked, ["cks_1"]);
  }
});

test("a checkout nobody paid for releases the slot", async () => {
  // No payment yet, a failed or cancelled one, or one still waiting on the
  // customer - who may never come back to finish it.
  for (const status of [null, undefined, "failed", "cancelled", "requires_payment_method", "requires_customer_action", "requires_confirmation"] as const) {
    assert.equal(await sessionPayment("cks_1", provider(status).retrieve), "unpaid", String(status));
  }
});

test("a provider that cannot be asked is not a provider that said no", async () => {
  const unreachable = async (): Promise<{ payment_status?: IntentStatus | null }> => {
    throw new Error("Dodo is down");
  };
  assert.equal(await sessionPayment("cks_1", unreachable), "unknown");
});

test("settling is decided by the payment state alone", () => {
  assert.equal(paymentSettling("succeeded"), true);
  assert.equal(paymentSettling("failed"), false);
  assert.equal(paymentSettling(null), false);
});
