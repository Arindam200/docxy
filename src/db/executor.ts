import { eq, inArray } from 'drizzle-orm';
import type { Database } from './index.js';
import { projects } from './schema.js';

/** A connection or an open transaction - the stores work against either. */
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Executor = Database | Transaction;

const cache = new Map<string, string>();

/**
 * The project row for a repository, created on first sight.
 *
 * Memoised per process: the id never changes while the row exists, and every
 * store call would otherwise open with a round trip to look it up again. A
 * disconnected project's row is deleted, though, and a repository connected
 * again gets a new one - see `forgetProjectKeys`, which `deleteProject` calls so
 * the next run is not written against an id that is gone.
 *
 * For writers only. A read has no business minting a row: see
 * `existingProjectIds`.
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

/**
 * The project rows that already exist for some checkout paths, without
 * creating any.
 *
 * What a read wants. Listing an organization's runs used to resolve each path
 * through `projectId`, which is an upsert - so a dashboard page load was one
 * write per project on a cold cache, and a path with no history got a
 * placeholder row merely for having been asked about. A path with no row has
 * no runs, so leaving it out of the answer is the same answer, reached with
 * one indexed select and no writes.
 *
 * Deliberately not memoised: it is one statement for the whole set, and a
 * cache here would have to be invalidated on every delete as well.
 */
export async function existingProjectIds(db: Executor, keys: string[]): Promise<string[]> {
  const wanted = [...new Set(keys)];
  if (wanted.length === 0) return [];
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(inArray(projects.key, wanted));
  return rows.map((row) => row.id);
}

/**
 * Drop the memoised ids for some checkout paths, because their rows are gone.
 *
 * Without this, disconnecting a project and connecting the same repository
 * again left the old id cached against its path: every save for the new
 * project then referenced a deleted row and failed its foreign key until the
 * process restarted.
 */
export function forgetProjectKeys(keys: string[]): void {
  for (const key of keys) cache.delete(key);
}

/** Only for tests and `docxy reset`, where the cache would go stale. */
export function forgetProjects(): void {
  cache.clear();
}
