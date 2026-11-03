import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { RunRecord } from '../types.js';
import type { LogEntry, LogPage, LogQuery, RunStorage } from './stores.js';

/** How many run files a listing reads at once. */
const READ_BATCH = 32;

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
   * so a process killed mid-write would otherwise leave truncated JSON - and a
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
      // SAFETY: these files are written only by `save` below, which serialises a RunRecord.
      return JSON.parse(await readFile(this.file(id), 'utf8')) as RunRecord;
    } catch {
      return null;
    }
  }

  /**
   * Whether a run belongs to one of the repositories the caller may see.
   *
   * `list` applies the same rule as it reads; this exists for the paths that
   * address a run by id and so never pass through the listing at all.
   */
  /**
   * An absent scope is every run; an empty one is none.
   *
   * The two used to be the same answer, which is wrong once a caller computes
   * its scope: an organization that owns no repositories produces an empty
   * array, and reading that as "no filter" showed it everybody's runs.
   */
  private visible(run: RunRecord, repoPaths?: string[]): boolean {
    if (repoPaths === undefined) return true;
    return repoPaths.includes(run.repoPath);
  }

  /** Newest first. */
  async list(limit = 50, repoPaths?: string[]): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    // `.tmp` files are half-written saves in flight; they are not runs yet.
    const files = names.filter((n) => n.endsWith('.json'));
    const runs: RunRecord[] = [];
    // Read in parallel batches rather than one file at a time: a listing reads
    // every record in the directory, and awaiting each in turn made it as slow
    // as the sum of the reads. Bounded so a large history does not open every
    // file at once.
    for (let start = 0; start < files.length; start += READ_BATCH) {
      const batch = await Promise.all(
        files.slice(start, start + READ_BATCH).map(async (name) => {
          try {
            // SAFETY: these files are written only by `save` below, which serialises a RunRecord.
            return JSON.parse(await readFile(join(this.dir, name), 'utf8')) as RunRecord;
          } catch {
            // skip a corrupt record rather than failing the listing
            return null;
          }
        }),
      );
      for (const run of batch) if (run) runs.push(run);
    }
    const wanted = repoPaths === undefined ? null : new Set(repoPaths);
    return runs
      .filter((run) => !wanted || wanted.has(run.repoPath))
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, limit);
  }

  async listByRepo(limitEach: number, repoPaths: string[]): Promise<Map<string, RunRecord[]>> {
    const out = new Map<string, RunRecord[]>(repoPaths.map((path) => [path, []]));
    if (repoPaths.length === 0 || limitEach <= 0) return out;
    // One pass over the directory for every repository, newest first, so each
    // bucket fills with its own newest runs.
    for (const run of await this.list(Number.POSITIVE_INFINITY, repoPaths)) {
      const bucket = out.get(run.repoPath);
      if (bucket && bucket.length < limitEach) bucket.push(run);
    }
    return out;
  }

  async forCommit(sha: string, repoPath: string): Promise<RunRecord | null> {
    const runs = await this.list(Number.POSITIVE_INFINITY, [repoPath]);
    return runs.find((run) => run.commit.sha === sha && run.status !== 'failed') ?? null;
  }

  /**
   * Runs whose proposal is ready but has no pull request.
   *
   * It used to mean "waiting for a person", which nothing produces any more.
   * The set it returns is still the one worth surfacing: a run that finished,
   * cost five model calls, and has nothing to show for it because publishing
   * failed.
   */
  async pending(): Promise<RunRecord[]> {
    return (await this.list(200)).filter((r) => r.status === 'approved' && !r.pullRequestUrl);
  }

  /**
   * Flattened in memory, which is the honest cost of JSON files: there is no
   * index to ask. The window is capped at fifty runs for exactly that reason.
   */
  async logs(query: LogQuery): Promise<LogPage> {
    // A named run still has to sit inside the repositories the caller may see.
    // Loading it by id alone would let anyone holding a run id read the events
    // of a project they were never granted.
    const named = query.runId ? await this.load(query.runId) : null;
    const runs = query.runId
      ? [named].filter((run) => run !== null).filter((run) => this.visible(run, query.repoPaths))
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
