import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { RunRecord } from '../types.js';
import type { LogEntry, LogPage, LogQuery, RunStorage } from './stores.js';

/** Runs are plain JSON on disk: inspectable, diffable, and trivially replayable. */
export class RunStore implements RunStorage {
  private readonly dir: string;

  constructor(config: Config) {
    this.dir = join(config.stateDir, 'runs');
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Written to a sibling and renamed into place.
   *
   * `save` is called at every role boundary while the record is still growing,
   * so a process killed mid-write would otherwise leave truncated JSON — and a
   * corrupt file is silently dropped from `list`, which is the worst way to
   * lose a run: without a trace of it having existed.
   */
  async save(run: RunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const target = this.file(run.id);
    const staging = `${target}.${process.pid}.tmp`;
    try {
      await writeFile(staging, `${JSON.stringify(run, null, 2)}\n`, 'utf8');
      await rename(staging, target);
    } catch (err) {
      await unlink(staging).catch(() => {});
      throw err;
    }
  }

  async load(id: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as RunRecord;
    } catch {
      return null;
    }
  }

  /** Newest first. */
  async list(limit = 50, repoPaths?: string[]): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const runs: RunRecord[] = [];
    // `.tmp` files are half-written saves in flight; they are not runs yet.
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        runs.push(JSON.parse(await readFile(join(this.dir, name), 'utf8')) as RunRecord);
      } catch {
        // skip a corrupt record rather than failing the listing
      }
    }
    const wanted = repoPaths && repoPaths.length > 0 ? new Set(repoPaths) : null;
    return runs
      .filter((run) => !wanted || wanted.has(run.repoPath))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  async pending(): Promise<RunRecord[]> {
    return (await this.list(200)).filter((r) => r.status === 'awaiting-approval');
  }

  /**
   * Flattened in memory, which is the honest cost of JSON files: there is no
   * index to ask. The window is capped at fifty runs for exactly that reason.
   */
  async logs(query: LogQuery): Promise<LogPage> {
    const runs = query.runId
      ? [await this.load(query.runId)].filter((run) => run !== null)
      : await this.list(50, query.repoPaths);

    const entries: LogEntry[] = runs.flatMap((run) =>
      run.traces.flatMap((trace) =>
        trace.events.map((event) => ({
          at: event.at,
          kind: event.kind,
          text: event.text,
          role: trace.role,
          runId: run.id,
          commit: run.commit.shortSha,
          subject: run.commit.subject,
          level: event.kind === 'error' ? ('error' as const) : ('info' as const),
        })),
      ),
    );

    const matched = entries.filter(
      (entry) =>
        (!query.kind || entry.kind === query.kind) && (!query.role || entry.role === query.role),
    );
    matched.sort((a, b) => b.at.localeCompare(a.at));

    return {
      entries: matched.slice(0, query.limit),
      total: matched.length,
      kinds: [...new Set(entries.map((entry) => entry.kind))].sort(),
    };
  }
}
