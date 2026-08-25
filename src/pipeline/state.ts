import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { KnowledgeStorage } from './stores.js';

export interface KnowledgeMap {
  /** symbol -> ["docs/api.md#Configuration", ...] */
  symbols: Record<string, string[]>;
  /** Commit shas already processed, newest last. */
  processedCommits: string[];
  updatedAt: string;
}

const EMPTY: KnowledgeMap = { symbols: {}, processedCommits: [], updatedAt: '' };

/**
 * The symbol-to-doc-section map, persisted per repository and updated
 * incrementally. This is what turns a second run on the same repo into a
 * cheaper one: the Impact Mapper is handed what it already learned.
 */
export class KnowledgeStore implements KnowledgeStorage {
  private readonly file: string;

  constructor(private readonly config: Config) {
    const key = createHash('sha256').update(config.repoPath).digest('hex').slice(0, 16);
    this.file = join(config.stateDir, `knowledge-${key}.json`);
  }

  async load(): Promise<KnowledgeMap> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<KnowledgeMap>;
      return {
        symbols: parsed.symbols ?? {},
        processedCommits: parsed.processedCommits ?? [],
        updatedAt: parsed.updatedAt ?? '',
      };
    } catch {
      return { ...EMPTY, symbols: {}, processedCommits: [] };
    }
  }

  async save(map: KnowledgeMap): Promise<void> {
    await mkdir(this.config.stateDir, { recursive: true });
    await writeFile(this.file, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
  }

  /** Merge a run's new mappings in, de-duplicated, and record the commit. */
  async merge(
    incoming: Record<string, string[]>,
    commitSha: string,
  ): Promise<{ map: KnowledgeMap; added: number }> {
    const map = await this.load();
    let added = 0;

    for (const [symbol, sections] of Object.entries(incoming ?? {})) {
      if (!symbol || !Array.isArray(sections)) continue;
      const existing = new Set(map.symbols[symbol] ?? []);
      const before = existing.size;
      for (const section of sections) {
        if (typeof section === 'string' && section.trim()) existing.add(section.trim());
      }
      // "added" counts newly learned mappings, whether a brand-new symbol or a
      // new section for one already known.
      added += existing.size - before;
      map.symbols[symbol] = [...existing].sort();
    }

    if (!map.processedCommits.includes(commitSha)) {
      map.processedCommits.push(commitSha);
      // Keep the tail bounded; the map itself is the durable part.
      if (map.processedCommits.length > 500) {
        map.processedCommits = map.processedCommits.slice(-500);
      }
    }
    map.updatedAt = new Date().toISOString();

    await this.save(map);
    return { map, added };
  }

  async reset(): Promise<void> {
    await this.save({ symbols: {}, processedCommits: [], updatedAt: new Date().toISOString() });
  }
}

/** Render the map for a prompt, budgeted so a large repo cannot blow the context. */
export function renderKnowledgeMap(map: KnowledgeMap, maxEntries = 200): string {
  const entries = Object.entries(map.symbols);
  if (entries.length === 0) {
    return '(empty — this is the first commit processed for this repository)';
  }
  const shown = entries.slice(0, maxEntries);
  const lines = shown.map(([symbol, sections]) => `${symbol} -> ${sections.join(', ')}`);
  const omitted = entries.length - shown.length;
  return [
    `${entries.length} symbol(s) mapped across ${map.processedCommits.length} processed commit(s).`,
    '',
    ...lines,
    omitted > 0 ? `\n... and ${omitted} more` : '',
  ]
    .join('\n')
    .trim();
}
