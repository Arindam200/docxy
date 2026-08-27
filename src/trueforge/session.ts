import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config, RoleName } from '../config.js';
import type { RoleDefinition } from '../agents/roles.js';
import type { SessionStorage } from '../pipeline/stores.js';

interface SessionEntry {
  sessionId: string;
  /** Hash of the agent spec the session was created from. */
  specHash: string;
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

  async get(role: RoleName, specHash: string): Promise<string | undefined> {
    const map = await this.read();
    const entry = normalize(map[repoKey(this.config.repoPath)]?.[role]);
    if (!entry) return undefined;
    // A session written before spec hashing existed has no hash to compare, so
    // it is adopted rather than discarded — the first write re-stamps it.
    if (entry.specHash && entry.specHash !== specHash) return undefined;
    return entry.sessionId;
  }

  async set(role: RoleName, sessionId: string, specHash: string): Promise<void> {
    const map = await this.read();
    const key = repoKey(this.config.repoPath);
    map[key] = { ...map[key], [role]: { sessionId, specHash } };
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
): Promise<ResolvedSession> {
  const hash = specHash(config, role);
  const existing = await store.get(role.name, hash);

  if (existing) {
    try {
      await client.sessions.get(existing);
      return { id: existing, reused: true };
    } catch {
      // Session was deleted server-side (or the harness store was reset); fall through.
    }
  }

  const { data } = await client.sessions.create({
    agent: { spec: role.spec(config) },
  });
  await store.set(role.name, data.id, hash);
  return { id: data.id, reused: false };
}
