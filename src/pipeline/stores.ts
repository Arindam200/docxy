import type { Config, RoleName } from '../config.js';
import type { RunRecord } from '../types.js';
import { databaseConfigured } from '../db/index.js';
import { PgKnowledgeStore } from '../db/knowledge-store.js';
import { PgRunStore } from '../db/run-store.js';
import { PgSessionStore } from '../db/session-store.js';
import { KnowledgeStore, type KnowledgeMap } from './state.js';
import { RunStore } from './store.js';
import { SessionStore } from '../trueforge/session.js';

/**
 * The three persistence interfaces, and the one place that decides which
 * backend serves them.
 *
 * Nothing outside these implementations knows whether state lives in `.docxy/`
 * or in Postgres, which is what makes the choice a single environment variable
 * rather than a rewrite.
 */

export interface RunStorage {
  save(run: RunRecord): Promise<void>;
  load(id: string): Promise<RunRecord | null>;
  /** Newest first. */
  list(limit?: number): Promise<RunRecord[]>;
  pending(): Promise<RunRecord[]>;
}

export interface SessionStorage {
  /**
   * The session for a role, but only if it was created from the same agent
   * spec. A changed prompt or model yields a miss, so the caller starts a new
   * session instead of silently talking to an agent built from stale config.
   */
  get(role: RoleName, specHash: string): Promise<string | undefined>;
  set(role: RoleName, sessionId: string, specHash: string): Promise<void>;
  clear(): Promise<void>;
  all(): Promise<Partial<Record<RoleName, string>>>;
}

export interface KnowledgeStorage {
  load(): Promise<KnowledgeMap>;
  merge(
    incoming: Record<string, string[]>,
    commitSha: string,
  ): Promise<{ map: KnowledgeMap; added: number }>;
  reset(): Promise<void>;
}

export interface Stores {
  runs: RunStorage;
  sessions: SessionStorage;
  knowledge: KnowledgeStorage;
}

/**
 * Postgres when `DATABASE_URL` is set, JSON files otherwise.
 *
 * The JSON stores are not a fallback to be tolerated — they are what makes
 * `docxy run` work against a fresh clone with no setup at all, and they are
 * what the demo uses. Both are supported.
 */
export function createStores(config: Config): Stores {
  if (databaseConfigured()) {
    return {
      runs: new PgRunStore(config),
      sessions: new PgSessionStore(config),
      knowledge: new PgKnowledgeStore(config),
    };
  }
  return {
    runs: new RunStore(config),
    sessions: new SessionStore(config),
    knowledge: new KnowledgeStore(config),
  };
}

/** Which backend `createStores` will pick — for `docxy status` and the API. */
export function storageBackend(): 'postgres' | 'files' {
  return databaseConfigured() ? 'postgres' : 'files';
}
