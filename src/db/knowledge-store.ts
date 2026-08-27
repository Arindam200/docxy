import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { KnowledgeStorage } from '../pipeline/stores.js';
import type { KnowledgeMap } from '../pipeline/state.js';
import { getDb } from './index.js';
import { projectId, type Executor } from './executor.js';
import { knowledgeCommits, knowledgeSymbols, projects } from './schema.js';

/** Matches the file-backed store: the map is durable, the commit tail is not. */
const COMMIT_HISTORY = 500;

/**
 * The symbol → doc-section map in Postgres.
 *
 * Commits are rows rather than an array column so that recording one is an
 * insert instead of a read-modify-write of the whole list — which is what makes
 * it safe for two workers to process different commits on the same repository.
 */
export class PgKnowledgeStore implements KnowledgeStorage {
  constructor(private readonly config: Config) {}

  private project(db: Executor): Promise<string> {
    return projectId(db, this.config.repoPath);
  }

  private async read(db: Executor, project: string): Promise<KnowledgeMap> {
    const [symbolRows, commitRows, projectRow] = await Promise.all([
      db
        .select({ symbol: knowledgeSymbols.symbol, docSections: knowledgeSymbols.docSections })
        .from(knowledgeSymbols)
        .where(eq(knowledgeSymbols.projectId, project)),
      db
        .select({ sha: knowledgeCommits.sha })
        .from(knowledgeCommits)
        .where(eq(knowledgeCommits.projectId, project))
        .orderBy(asc(knowledgeCommits.seenAt)),
      db
        .select({ updatedAt: projects.knowledgeUpdatedAt })
        .from(projects)
        .where(eq(projects.id, project))
        .limit(1),
    ]);

    const symbols: Record<string, string[]> = {};
    for (const row of symbolRows) symbols[row.symbol] = row.docSections;

    return {
      symbols,
      processedCommits: commitRows.map((row) => row.sha),
      updatedAt: projectRow[0]?.updatedAt?.toISOString() ?? '',
    };
  }

  async load(): Promise<KnowledgeMap> {
    const db = getDb();
    return this.read(db, await this.project(db));
  }

  async merge(
    incoming: Record<string, string[]>,
    commitSha: string,
  ): Promise<{ map: KnowledgeMap; added: number }> {
    const db = getDb();

    return db.transaction(async (tx) => {
      const project = await this.project(tx);
      const now = new Date();

      const names = Object.keys(incoming ?? {}).filter(
        (symbol) => symbol && Array.isArray(incoming[symbol]),
      );

      // Only the symbols this run touched are read back, not the whole map.
      const existing =
        names.length > 0
          ? await tx
              .select({
                symbol: knowledgeSymbols.symbol,
                docSections: knowledgeSymbols.docSections,
              })
              .from(knowledgeSymbols)
              .where(
                and(
                  eq(knowledgeSymbols.projectId, project),
                  inArray(knowledgeSymbols.symbol, names),
                ),
              )
          : [];

      const known = new Map(existing.map((row) => [row.symbol, row.docSections]));
      let added = 0;
      const updates: Array<{ symbol: string; docSections: string[] }> = [];

      for (const symbol of names) {
        const merged = new Set(known.get(symbol) ?? []);
        const before = merged.size;
        for (const section of incoming[symbol] ?? []) {
          if (typeof section === 'string' && section.trim()) merged.add(section.trim());
        }
        // "added" counts newly learned mappings, whether a brand-new symbol or
        // a new section for one already known.
        added += merged.size - before;
        if (merged.size !== before || !known.has(symbol)) {
          updates.push({ symbol, docSections: [...merged].sort() });
        }
      }

      if (updates.length > 0) {
        await tx
          .insert(knowledgeSymbols)
          .values(updates.map((u) => ({ projectId: project, ...u, updatedAt: now })))
          .onConflictDoUpdate({
            target: [knowledgeSymbols.projectId, knowledgeSymbols.symbol],
            set: {
              // `excluded` is the row Postgres was about to insert — the merged
              // set computed above — rather than a second round trip per symbol.
              docSections: sql`excluded.doc_sections`,
              updatedAt: now,
            },
          });
      }

      await tx
        .insert(knowledgeCommits)
        .values({ projectId: project, sha: commitSha, seenAt: now })
        .onConflictDoNothing();

      await this.trimCommits(tx, project);
      await tx
        .update(projects)
        .set({ knowledgeUpdatedAt: now })
        .where(eq(projects.id, project));

      return { map: await this.read(tx, project), added };
    });
  }

  /** Keep the tail bounded; the symbol map itself is the durable part. */
  private async trimCommits(tx: Executor, project: string): Promise<void> {
    const keep = await tx
      .select({ sha: knowledgeCommits.sha })
      .from(knowledgeCommits)
      .where(eq(knowledgeCommits.projectId, project))
      .orderBy(desc(knowledgeCommits.seenAt))
      .limit(COMMIT_HISTORY);

    if (keep.length < COMMIT_HISTORY) return;

    await tx.delete(knowledgeCommits).where(
      and(
        eq(knowledgeCommits.projectId, project),
        notInArray(
          knowledgeCommits.sha,
          keep.map((row) => row.sha),
        ),
      ),
    );
  }

  async reset(): Promise<void> {
    const db = getDb();
    await db.transaction(async (tx) => {
      const project = await this.project(tx);
      await tx.delete(knowledgeSymbols).where(eq(knowledgeSymbols.projectId, project));
      await tx.delete(knowledgeCommits).where(eq(knowledgeCommits.projectId, project));
      await tx
        .update(projects)
        .set({ knowledgeUpdatedAt: new Date() })
        .where(eq(projects.id, project));
    });
  }
}

