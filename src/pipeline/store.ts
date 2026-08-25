import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '../config.js';
import type { RunRecord } from '../types.js';

/** Runs are plain JSON on disk: inspectable, diffable, and trivially replayable. */
export class RunStore {
  private readonly dir: string;

  constructor(config: Config) {
    this.dir = join(config.stateDir, 'runs');
  }

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async save(run: RunRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(run.id), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }

  async load(id: string): Promise<RunRecord | null> {
    try {
      return JSON.parse(await readFile(this.file(id), 'utf8')) as RunRecord;
    } catch {
      return null;
    }
  }

  /** Newest first. */
  async list(limit = 50): Promise<RunRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const runs: RunRecord[] = [];
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try {
        runs.push(JSON.parse(await readFile(join(this.dir, name), 'utf8')) as RunRecord);
      } catch {
        // skip a corrupt record rather than failing the listing
      }
    }
    return runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
  }

  async pending(): Promise<RunRecord[]> {
    return (await this.list(200)).filter((r) => r.status === 'awaiting-approval');
  }
}
