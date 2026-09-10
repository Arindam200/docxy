/**
 * The Dodo Payments client, built on first use.
 *
 * Lazy for the same reason `lib/auth.ts` is: a module that constructs a client
 * at import time turns a missing key into a blank page on every route that
 * shares a chunk with it, and into a failing build on a deployment that has no
 * payment credentials at all. Nothing here contacts the provider until
 * something asks it to.
 *
 * Server-side only. The key this constructs with is a secret, and no client
 * component has any reason to import this file.
 */

import DodoPayments from "dodopayments";
import { billingConfig } from "./config";

let cached: DodoPayments | undefined;
let cachedFor: string | undefined;

/**
 * The client, or an error naming what is missing.
 *
 * Callers that can proceed without payments should ask `billingConfig()` first
 * and take null for an answer; this one is for the paths that cannot.
 */
export function getDodo(): DodoPayments {
  const config = billingConfig();
  if (!config) {
    throw new Error(
      "Dodo Payments is not configured on this deployment. Set DODO_PAYMENTS_API_KEY and DODO_PAYMENTS_WEBHOOK_KEY.",
    );
  }

  // Rebuilt if the environment changes under a running process - which happens
  // in development, where a test key is swapped in without a restart.
  const fingerprint = `${config.environment}:${config.apiKey.slice(-6)}`;
  if (cached && cachedFor === fingerprint) return cached;

  cached = new DodoPayments({
    bearerToken: config.apiKey,
    // Named explicitly. The SDK defaults to live_mode, and a deployment that
    // forgot to say should not discover its choice by charging somebody.
    environment: config.environment,
    webhookKey: config.webhookKey,
  });
  cachedFor = fingerprint;
  return cached;
}
