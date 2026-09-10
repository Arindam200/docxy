/**
 * The billing connection: pooled, and able to open a transaction.
 *
 * Deliberately not the dashboard's `@/db` client. That one is `neon-http`,
 * chosen because Better Auth never opens a transaction - and billing is the
 * opposite case. Claiming the last run in an allowance means reading the
 * period, checking what is already reserved, and writing the reservation as one
 * indivisible step. Over HTTP those are three requests and two accounts can
 * each win the same slot.
 *
 * The tables come from the pipeline's schema file, imported across the
 * directory boundary rather than restated here: one definition, one migration
 * owner, and a column that moves moves for both sides at once. See
 * `src/db/billing-schema.ts` and the root drizzle.config.ts.
 */

import { neonConfig, Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import ws from "ws";
import { billingSchema } from "@billing/schema";
import { localDev } from "@/lib/runtime";

// `ws`, always - not only when the global is missing. Node 22's built-in
// WebSocket does not survive a long-lived Neon pool; the socket dies and every
// query behind it fails with an error carrying no message. Same reasoning, and
// the same fix, as src/db/index.ts.
neonConfig.webSocketConstructor = ws;

export type BillingDatabase = ReturnType<typeof create>;

function create(connectionString: string) {
  const pool = new Pool({
    connectionString,
    // Retire an idle connection before Neon does, so a dropped socket is not a
    // process-level throw on the next query.
    idleTimeoutMillis: 30_000,
    // Billing is a low-traffic path beside the dashboard's own reads.
    max: 4,
    connectionTimeoutMillis: 15_000,
  });

  pool.on("error", (cause: Error) => {
    console.error(`billing connection dropped (the pool will reconnect): ${cause.message}`);
  });

  return drizzle(pool, { schema: billingSchema });
}

// Cached across module reloads so `next dev` does not leak a pool per edit.
declare global {
  var docxyBillingDb: BillingDatabase | undefined;
}

let cached = globalThis.docxyBillingDb;

/**
 * Throws with a message that names the fix, rather than failing inside the
 * driver with an opaque connection error.
 */
export function getBillingDb(): BillingDatabase {
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      localDev
        ? "DATABASE_URL is not set. Copy web/.env.local.example to web/.env.local and paste your Neon connection string."
        : "DATABASE_URL is not set on this deployment. Billing cannot record anything without it.",
    );
  }

  cached = create(connectionString);
  if (process.env.NODE_ENV !== "production") globalThis.docxyBillingDb = cached;
  return cached;
}
