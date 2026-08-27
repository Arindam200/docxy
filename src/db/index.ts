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

/** Only the part of a pooled client this module touches. */
interface PoolClientLike {
  on: (event: 'error', handler: (cause: Error) => void) => void;
}

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

  pool = new Pool({
    connectionString,
    // Retire an idle connection before Neon does.
    //
    // This is the actual fix for "Connection terminated unexpectedly", not the
    // listeners below. Neon drops idle WebSocket connections after a few
    // minutes; if it wins that race the driver surfaces the close as an `error`
    // on a client, and a client that never finished connecting has no listener
    // for it — which is a process-level throw. Closing first means the race
    // does not happen, so the failure has no opportunity to occur.
    idleTimeoutMillis: 30_000,
    // A single pipeline plus a dashboard does not need more, and a smaller pool
    // means fewer idle sockets to lose in the first place.
    max: 8,
    connectionTimeoutMillis: 15_000,
  });

  // Idle clients that die anyway.
  //
  // The pool discards the broken client and hands out a fresh one on the next
  // query; there is nothing to do here but say so and let it. Without a
  // listener this is a process-level throw, and a dropped idle socket took the
  // whole server down mid-run with a stack trace from inside the driver.
  pool.on('error', (cause: Error) => {
    console.error(`postgres connection dropped (the pool will reconnect): ${cause.message}`);
  });

  // And on every client the pool hands out, for the same reason one level down:
  // a socket that closes with a query in flight emits `error` on the client
  // rather than the pool. The query's own promise still rejects, which is where
  // the failure belongs; this listener exists so that rejection is the only
  // thing that happens.
  pool.on('connect', (client: PoolClientLike) => {
    client.on('error', (cause: Error) => {
      console.error(`postgres client error (the query will reject): ${cause.message}`);
    });
  });

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
