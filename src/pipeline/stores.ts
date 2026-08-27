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

/** One role event, flattened with the run it belongs to. */
export interface LogEntry {
  at: string;
  kind: string;
  text: string;
  role: RoleName;
  runId: string;
  commit: string;
  subject: string;
  /** `error` events are the ones worth surfacing on their own. */
  level: 'error' | 'info';
}

export interface LogQuery {
  limit: number;
  kind?: string;
  role?: RoleName;
  /**
   * A single run. It narrows the listing within `repoPaths`; it never widens
   * past it. A run id is guessable from any dashboard URL, so a query that
   * named one used to be the way to read another project's role events.
   */
  runId?: string;
  /**
   * Repositories whose runs the caller is allowed to see. Omitted only by
   * callers that already are the deployment — the CLI reading its own runs.
   */
  repoPaths?: string[];
}

export interface LogPage {
  entries: LogEntry[];
  /** Matches before the limit, so a listing can say what it is not showing. */
  total: number;
  /** Every kind present in the unfiltered window, for the filter control. */
  kinds: string[];
}

export interface RunStorage {
  save(run: RunRecord): Promise<void>;
  load(id: string): Promise<RunRecord | null>;
  /**
   * Newest first.
   *
   * `repoPaths` widens the listing beyond the configured repository. The
   * dashboard needs it: docxy is synced to every repository the GitHub App is
   * installed on, each of which runs against its own managed checkout, and a
   * listing keyed only to the directory the server happens to have started in
   * shows an empty dashboard for all of them.
   */
  list(limit?: number, repoPaths?: string[]): Promise<RunRecord[]>;
  pending(): Promise<RunRecord[]>;
  /**
   * Role events across runs, newest first.
   *
   * Its own method rather than a fold over `list` because the two backends
   * answer it very differently: Postgres can filter and order events in the
   * database, where reconstructing whole runs to flatten them in memory read
   * every prompt and file body a run ever recorded to render a log line.
   */
  logs(query: LogQuery): Promise<LogPage>;
}

/** A stored session and how much history it is carrying. */
export interface StoredSession {
  sessionId: string;
  /** Turns already spent on it. Drives rotation before the context overflows. */
  turns: number;
}

export interface SessionStorage {
  /**
   * The session for a role, but only if it was created from the same agent
   * spec. A changed prompt or model yields a miss, so the caller starts a new
   * session instead of silently talking to an agent built from stale config.
   */
  get(role: RoleName, specHash: string): Promise<StoredSession | undefined>;
  /** Record a new session for a role, resetting its turn count. */
  set(role: RoleName, sessionId: string, specHash: string): Promise<void>;
  /** Count one completed turn against the role's current session. */
  recordTurn(role: RoleName): Promise<void>;
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
