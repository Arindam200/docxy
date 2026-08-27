import { eq } from 'drizzle-orm';
import type { Database } from './index.js';
import { projects } from './schema.js';

/** A connection or an open transaction — the stores work against either. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

const cache = new Map<string, string>();

/**
 * The project row for a repository, created on first sight.
 *
 * Memoised per process: the id never changes, and every store call would
 * otherwise open with a round trip to look it up again.
 */
export async function projectId(db: Executor, key: string): Promise<string> {
  const hit = cache.get(key);
  if (hit) return hit;

  // A plain `onConflictDoNothing` would return no row on the second call, so
  // the conflict path writes the key back to itself purely to get RETURNING.
  const [row] = await db
    .insert(projects)
    .values({ key })
    .onConflictDoUpdate({ target: projects.key, set: { key } })
    .returning({ id: projects.id });

  const id = row?.id ?? (await db.select({ id: projects.id }).from(projects).where(eq(projects.key, key)).limit(1))[0]?.id;
  if (!id) throw new Error(`Could not resolve a project row for ${key}.`);

  cache.set(key, id);
  return id;
}

/** Only for tests and `docxy reset`, where the cache would go stale. */
export function forgetProjects(): void {
  cache.clear();
}
