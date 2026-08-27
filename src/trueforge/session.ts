import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config, RoleName } from '../config.js';
import type { RoleDefinition } from '../agents/roles.js';
import type { SessionStorage, StoredSession } from '../pipeline/stores.js';

interface SessionEntry {
  sessionId: string;
  /** Hash of the agent spec the session was created from. */
  specHash: string;
  /** Turns already spent on it. Absent on entries written before rotation existed. */
  turns?: number;
}

/** Older files stored a bare session id per role; both shapes are read. */
type StoredEntry = SessionEntry | string;
type SessionMap = Record<string, Partial<Record<RoleName, StoredEntry>>>;

function repoKey(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
}

function normalize(entry: StoredEntry | undefined): SessionEntry | undefined {
  if (!entry) return undefined;
  return typeof entry === 'string' ? { sessionId: entry, specHash: '' } : entry;
}

export class SessionStore implements SessionStorage {
  private readonly file: string;
  private cache: SessionMap | null = null;

  constructor(private readonly config: Config) {
    this.file = join(config.stateDir, 'sessions.json');
  }

  private async read(): Promise<SessionMap> {
    if (this.cache) return this.cache;
    try {
      // SAFETY: `normalize` tolerates both stored shapes, and an unreadable or
      // unexpected file falls through to the empty map below.
      this.cache = JSON.parse(await readFile(this.file, 'utf8')) as SessionMap;
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async write(map: SessionMap): Promise<void> {
    this.cache = map;
    await mkdir(this.config.stateDir, { recursive: true });
    await writeFile(this.file, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  }

  async get(role: RoleName, specHash: string): Promise<StoredSession | undefined> {
    const map = await this.read();
    const entry = normalize(map[repoKey(this.config.repoPath)]?.[role]);
    if (!entry) return undefined;
    // A session written before spec hashing existed has no hash to compare, so
    // it is adopted rather than discarded — the first write re-stamps it.
    if (entry.specHash && entry.specHash !== specHash) return undefined;
    return { sessionId: entry.sessionId, turns: entry.turns ?? 0 };
  }

  async set(role: RoleName, sessionId: string, specHash: string): Promise<void> {
    const map = await this.read();
    const key = repoKey(this.config.repoPath);
    map[key] = { ...map[key], [role]: { sessionId, specHash, turns: 0 } };
    await this.write(map);
  }

  async recordTurn(role: RoleName): Promise<void> {
    const map = await this.read();
    const key = repoKey(this.config.repoPath);
    const entry = normalize(map[key]?.[role]);
    if (!entry) return;
    map[key] = { ...map[key], [role]: { ...entry, turns: (entry.turns ?? 0) + 1 } };
    await this.write(map);
  }

  async clear(): Promise<void> {
    const map = await this.read();
    delete map[repoKey(this.config.repoPath)];
    await this.write(map);
  }

  async all(): Promise<Partial<Record<RoleName, string>>> {
    const map = await this.read();
    const stored = map[repoKey(this.config.repoPath)] ?? {};
    const out: Partial<Record<RoleName, string>> = {};
    for (const [role, entry] of Object.entries(stored)) {
      const normalized = normalize(entry);
      if (!normalized) continue;
      // SAFETY: keys of `stored` are only ever written through `set`, which
      // types the role as `RoleName`.
      out[role as RoleName] = normalized.sessionId;
    }
    return out;
  }
}

export interface ResolvedSession {
  id: string;
  /** True when an existing session was reused — this is the accumulating state. */
  reused: boolean;
  /** Turns the session had already carried before this one. */
  priorTurns: number;
  /** Set when an existing session was deliberately retired to make this one. */
  rotatedBecause?: 'turn-limit' | 'requested';
}

export interface ResolveSessionOptions {
  /**
   * Retire whatever is stored and build a new session.
   *
   * The retry path sets this after a role runs out of budget: the accumulated
   * transcript is the likeliest cause, and asking the same overfull session the
   * same question again is the one thing guaranteed not to help.
   */
  fresh?: boolean;
}

/**
 * Identifies the agent configuration a session was built from.
 *
 * Sessions are long-lived, and the harness freezes the spec at creation. Without
 * this, editing a role's prompt or pointing it at a different model changed
 * nothing until sessions were cleared by hand.
 */
export function specHash(config: Config, role: RoleDefinition): string {
  return createHash('sha256').update(JSON.stringify(role.spec(config))).digest('hex').slice(0, 16);
}

/**
 * One long-lived session per role, per repository. Reusing it is the whole point:
 * a role's memory of the repo carries from one commit to the next instead of
 * being rebuilt from scratch every run.
 */
export async function resolveSession(
  client: TrueForge,
  config: Config,
  store: SessionStorage,
  role: RoleDefinition,
  options: ResolveSessionOptions = {},
): Promise<ResolvedSession> {
  const hash = specHash(config, role);
  const existing = await store.get(role.name, hash);
  const limit = config.agent.sessionMaxTurns;

  // Rotation is preventive, not reactive. A session that has carried a dozen
  // commits is one commit away from breaching its budget, and the cost of a
  // cold session is one uncached turn — far less than a failed run.
  const overLimit = Boolean(existing && limit > 0 && existing.turns >= limit);
  const rotatedBecause = options.fresh ? 'requested' : overLimit ? 'turn-limit' : undefined;

  if (existing && !rotatedBecause) {
    try {
      await client.sessions.get(existing.sessionId);
      return { id: existing.sessionId, reused: true, priorTurns: existing.turns };
    } catch {
      // Session was deleted server-side (or the harness store was reset); fall through.
    }
  }

  const { data } = await client.sessions.create({
    agent: { spec: role.spec(config) },
  });
  await store.set(role.name, data.id, hash);

  const resolved: ResolvedSession = { id: data.id, reused: false, priorTurns: 0 };
  if (rotatedBecause) resolved.rotatedBecause = rotatedBecause;
  return resolved;
}
