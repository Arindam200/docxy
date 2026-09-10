import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Config, RoleName } from '../config.js';
import type { SessionStorage, StoredSession } from './stores.js';

/**
 * The JSON-file session store, for running with no database.
 *
 * It records which thread a role is talking to and how many turns that thread
 * has carried, which is what `docxy run` needs against a fresh clone with no
 * infrastructure at all.
 */

interface SessionEntry {
  sessionId: string;
  /** Hash of the agent spec the session was created from. */
  specHash: string;
  /** Turns already spent on it. Absent on entries written before rotation existed. */
  turns?: number;
}

/**
 * One stored entry, in either shape this file has ever been written in.
 *
 * The old shape is a bare session id. Parsing rather than narrowing is the
 * point: this is a file on disk that earlier versions of this program wrote and
 * a person may have edited, so the two shapes are read as alternatives and
 * anything else is treated as absent instead of trusted.
 */
const storedEntrySchema = z.union([
  z.string().transform((sessionId) => ({ sessionId, specHash: '' })),
  z.object({
    sessionId: z.string(),
    specHash: z.string(),
    turns: z.number().int().nonnegative().optional(),
  }),
]);

const sessionMapSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

type StoredEntry = z.input<typeof storedEntrySchema>;
type SessionMap = Record<string, Partial<Record<RoleName, StoredEntry>>>;

function repoKey(repoPath: string): string {
  return createHash('sha256').update(repoPath).digest('hex').slice(0, 16);
}

function normalize(entry: StoredEntry | undefined): SessionEntry | undefined {
  if (entry === undefined) return undefined;
  const parsed = storedEntrySchema.safeParse(entry);
  return parsed.success ? parsed.data : undefined;
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
      // The outer shape is checked here and each entry by `normalize`, so an
      // unreadable or unexpected file falls through to the empty map below
      // rather than reaching the rest of the class.
      const parsed = sessionMapSchema.safeParse(JSON.parse(await readFile(this.file, 'utf8')));
      if (!parsed.success) throw new Error('unrecognised session file');
      // SAFETY: the schema establishes the two-level record shape; the leaf
      // values stay `unknown` there on purpose and are parsed one at a time by
      // `normalize`, which is the only thing that reads them.
      this.cache = parsed.data as SessionMap;
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
    // it is adopted rather than discarded - the first write re-stamps it.
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
