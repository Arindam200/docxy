import { neonConfig, Pool } from '@neondatabase/serverless';
import { drizzle } from 'drizzle-orm/neon-serverless';
import ws from 'ws';
import { schema } from './schema.js';

/**
 * Neon connection for the pipeline.
 *
 * Uses the WebSocket driver rather than `neon-http` because writing a run means
 * inserting the run, its roles, their events, and their file bodies together —
 * that wants a transaction, and the HTTP driver cannot do them. It is also a
 * drop-in for `pg`, so moving to a plain Postgres later costs one import.
 */

// `ws`, always — not only when the global is missing.
//
// Node 22+ ships a global WebSocket built on undici, and the Neon driver does
// not get along with it over a long-lived pool: the socket dies without a
// message and every query behind it fails with an `ErrorEvent` carrying no
// `message` to explain itself. `ws` is what the driver documents for Node, and
// pinning it removes the difference between a query that works in a short
// script and the same query failing in a server that has been up for an hour.
neonConfig.webSocketConstructor = ws;

export type Database = ReturnType<typeof drizzle<typeof schema>>;

let pool: Pool | null = null;
let db: Database | null = null;

/** True when the pipeline is configured to persist to Postgres at all. */
export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

export function getDb(): Database {
  if (db) return db;

  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is not set. Unset it entirely to use the JSON stores in .docxy/, or point it at a Neon connection string.',
    );
  }

  pool = new Pool({ connectionString });
  db = drizzle(pool, { schema });
  return db;
}

/** Lets `docxy` exit rather than hang on an open pool. */
export async function closeDb(): Promise<void> {
  if (!pool) return;
  const closing = pool.end();
  pool = null;
  db = null;
  await closing;
}
