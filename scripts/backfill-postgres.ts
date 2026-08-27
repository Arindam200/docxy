/**
 * One-off: copy `.docxy/` into Postgres.
 *
 * Run once, after `npm run db:migrate`, when a project that has been using the
 * JSON stores moves to Neon:
 *
 *   DATABASE_URL=postgres://… npx tsx scripts/backfill-postgres.ts
 *
 * Re-running is safe. Runs upsert on their id, sessions and symbols upsert on
 * their unique keys, and commits are inserted with `on conflict do nothing`.
 * Nothing in `.docxy/` is modified or removed — verify the copy first, then
 * delete it by hand if you want to.
 */

import { readdir, readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { join } from 'node:path';
import { loadConfig, type Config } from '../src/config.js';
import { ROLES } from '../src/agents/roles.js';
import { closeDb, databaseConfigured, getDb } from '../src/db/index.js';
import { projectId } from '../src/db/executor.js';
import { agentSessions, knowledgeCommits, knowledgeSymbols, projects } from '../src/db/schema.js';
import { PgRunStore } from '../src/db/run-store.js';
import { KnowledgeStore } from '../src/pipeline/state.js';
import { SessionStore, specHash } from '../src/trueforge/session.js';
import type { RunRecord } from '../src/types.js';

async function main(): Promise<void> {
  if (!databaseConfigured()) {
    throw new Error('DATABASE_URL is not set — there is nothing to back fill into.');
  }

  const config = loadConfig();
  const db = getDb();
  const project = await projectId(db, config.repoPath);

  console.log(`repository  ${config.repoPath}`);
  console.log(`state dir   ${config.stateDir}\n`);

  const runs = await backfillRuns(config.stateDir, new PgRunStore(config));
  const sessions = await backfillSessions(config, project);
  const knowledge = await backfillKnowledge(config, project);

  console.log(`\n✓ ${runs} run(s), ${sessions} session(s), ${knowledge} symbol(s) copied.`);
  console.log('  .docxy/ was left untouched. Verify, then remove it if you like.');
}

async function backfillRuns(stateDir: string, store: PgRunStore): Promise<number> {
  let names: string[];
  try {
    names = (await readdir(join(stateDir, 'runs'))).filter((name) => name.endsWith('.json'));
  } catch {
    console.log('runs        none on disk');
    return 0;
  }

  let copied = 0;
  for (const name of names) {
    let record: RunRecord;
    try {
      record = JSON.parse(await readFile(join(stateDir, 'runs', name), 'utf8')) as RunRecord;
    } catch {
      console.warn(`runs        skipped ${name} (unreadable)`);
      continue;
    }
    await store.save(record);
    copied += 1;
  }
  console.log(`runs        ${copied} copied`);
  return copied;
}

/**
 * Existing sessions are stamped with the *current* spec hash, which adopts them
 * rather than orphaning every one on the first run after the move. A session
 * genuinely built from a stale spec would have been reused by the JSON store
 * too, so this changes nothing about what the pipeline does next.
 */
async function backfillSessions(
  config: Config,
  project: string,
): Promise<number> {
  const existing = await new SessionStore(config).all();
  const rows = ROLES.filter((role) => existing[role.name]).map((role) => ({
    projectId: project,
    role: role.name,
    sessionId: existing[role.name] as string,
    specHash: specHash(config, role),
  }));

  if (rows.length === 0) {
    console.log('sessions    none on disk');
    return 0;
  }

  for (const row of rows) {
    await getDb()
      .insert(agentSessions)
      .values(row)
      .onConflictDoUpdate({
        target: [agentSessions.projectId, agentSessions.role],
        set: { sessionId: row.sessionId, specHash: row.specHash },
      });
  }
  console.log(`sessions    ${rows.length} copied`);
  return rows.length;
}

async function backfillKnowledge(
  config: Config,
  project: string,
): Promise<number> {
  const map = await new KnowledgeStore(config).load();
  const symbols = Object.entries(map.symbols);

  if (symbols.length === 0 && map.processedCommits.length === 0) {
    console.log('knowledge   none on disk');
    return 0;
  }

  const db = getDb();
  const updatedAt = map.updatedAt ? new Date(map.updatedAt) : new Date();

  if (symbols.length > 0) {
    await db
      .insert(knowledgeSymbols)
      .values(
        symbols.map(([symbol, docSections]) => ({
          projectId: project,
          symbol,
          docSections,
          updatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [knowledgeSymbols.projectId, knowledgeSymbols.symbol],
        set: { docSections: sql`excluded.doc_sections`, updatedAt },
      });
  }

  if (map.processedCommits.length > 0) {
    // The JSON list is newest-last and carries no per-commit timestamp, so
    // ordering is reconstructed by spacing them a second apart before `updatedAt`.
    const base = updatedAt.getTime() - map.processedCommits.length * 1000;
    await db
      .insert(knowledgeCommits)
      .values(
        map.processedCommits.map((sha, index) => ({
          projectId: project,
          sha,
          seenAt: new Date(base + index * 1000),
        })),
      )
      .onConflictDoNothing();
  }

  await db.update(projects).set({ knowledgeUpdatedAt: updatedAt }).where(eq(projects.id, project));

  console.log(`knowledge   ${symbols.length} symbol(s), ${map.processedCommits.length} commit(s)`);
  return symbols.length;
}

main()
  .catch((err: unknown) => {
    console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
