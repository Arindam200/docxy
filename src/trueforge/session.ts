import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config, RoleName } from '../config.js';
import type { RoleDefinition } from '../agents/roles.js';

type SessionMap = Record<string, Partial<Record<RoleName, string>>>;

function repoKey(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
}

export class SessionStore {
  private readonly file: string;
  private cache: SessionMap | null = null;

  constructor(private readonly config: Config) {
    this.file = join(config.stateDir, 'sessions.json');
  }

  private async read(): Promise<SessionMap> {
    if (this.cache) return this.cache;
    try {
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

  async get(role: RoleName): Promise<string | undefined> {
    const map = await this.read();
    return map[repoKey(this.config.repoPath)]?.[role];
  }

  async set(role: RoleName, sessionId: string): Promise<void> {
    const map = await this.read();
    const key = repoKey(this.config.repoPath);
    map[key] = { ...(map[key] ?? {}), [role]: sessionId };
    await this.write(map);
  }

  async clear(): Promise<void> {
    const map = await this.read();
    delete map[repoKey(this.config.repoPath)];
    await this.write(map);
  }

  async all(): Promise<Partial<Record<RoleName, string>>> {
    const map = await this.read();
    return map[repoKey(this.config.repoPath)] ?? {};
  }
}

export interface ResolvedSession {
  id: string;
  /** True when an existing session was reused — this is the accumulating state. */
  reused: boolean;
}

/**
 * One long-lived session per role, per repository. Reusing it is the whole point:
 * a role's memory of the repo carries from one commit to the next instead of
 * being rebuilt from scratch every run.
 */
export async function resolveSession(
  client: TrueForge,
  config: Config,
  store: SessionStore,
  role: RoleDefinition,
): Promise<ResolvedSession> {
  const existing = await store.get(role.name);
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
  await store.set(role.name, data.id);
  return { id: data.id, reused: false };
}
