/**
 * Neon connection for the dashboard.
 *
 * Uses the HTTP driver rather than the WebSocket pool: Better Auth's Drizzle
 * adapter never opens a transaction on Postgres (its transactional paths are
 * MySQL-only, and `transaction` defaults to false), so the extra machinery of a
 * pooled WebSocket connection would buy nothing here. The docxy pipeline is the
 * opposite case and uses `neon-serverless` — see guides/DATABASE.md.
 */

import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { schema } from "./schema";

export type Database = ReturnType<typeof create>;

function create(connectionString: string) {
  return drizzle(neon(connectionString), { schema });
}

// Cached across module reloads so `next dev` does not leak a client per edit.
declare global {
  // eslint-disable-next-line no-var
  var docxyDb: Database | undefined;
}

let cached = globalThis.docxyDb;

/**
 * Throws — with a message that names the fix — rather than failing later inside
 * the driver with an opaque connection error.
 */
export function getDb(): Database {
  if (cached) return cached;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy web/.env.local.example to web/.env.local and paste your Neon connection string.",
    );
  }

  cached = create(connectionString);
  if (process.env.NODE_ENV !== "production") globalThis.docxyDb = cached;
  return cached;
}
