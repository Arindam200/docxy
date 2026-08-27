import { and, eq } from 'drizzle-orm';
import type { Config, RoleName } from '../config.js';
import type { SessionStorage } from '../pipeline/stores.js';
import { getDb } from './index.js';
import { projectId } from './executor.js';
import { agentSessions } from './schema.js';

/**
 * Harness sessions, one per role per project.
 *
 * Unlike the file-backed store this checks the spec hash: a session created
 * from a since-edited prompt or a swapped model is treated as a miss, so the
 * next run builds a fresh one instead of reusing an agent frozen around stale
 * configuration.
 */
export class PgSessionStore implements SessionStorage {
  constructor(private readonly config: Config) {}

  private project(): Promise<string> {
    return projectId(getDb(), this.config.repoPath);
  }

  async get(role: RoleName, specHash: string): Promise<string | undefined> {
    const db = getDb();
    const [row] = await db
      .select({ sessionId: agentSessions.sessionId, specHash: agentSessions.specHash })
      .from(agentSessions)
      .where(and(eq(agentSessions.projectId, await this.project()), eq(agentSessions.role, role)))
      .limit(1);

    if (!row || row.specHash !== specHash) return undefined;
    return row.sessionId;
  }

  async set(role: RoleName, sessionId: string, specHash: string): Promise<void> {
    const db = getDb();
    await db
      .insert(agentSessions)
      .values({ projectId: await this.project(), role, sessionId, specHash })
      .onConflictDoUpdate({
        target: [agentSessions.projectId, agentSessions.role],
        set: { sessionId, specHash, createdAt: new Date() },
      });
  }

  async clear(): Promise<void> {
    const db = getDb();
    await db.delete(agentSessions).where(eq(agentSessions.projectId, await this.project()));
  }

  async all(): Promise<Partial<Record<RoleName, string>>> {
    const db = getDb();
    const rows = await db
      .select({ role: agentSessions.role, sessionId: agentSessions.sessionId })
      .from(agentSessions)
      .where(eq(agentSessions.projectId, await this.project()));

    const out: Partial<Record<RoleName, string>> = {};
    for (const row of rows) {
      // SAFETY: `role` is a free-text column that only `set` writes, and it is
      // typed `RoleName` there.
      out[row.role as RoleName] = row.sessionId;
    }
    return out;
  }
}
