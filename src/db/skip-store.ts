import { and, desc, eq } from 'drizzle-orm';
import type { SkipKind, SkippedCommit } from '../api/contract.js';
import { getDb } from './index.js';
import { skippedCommits } from './schema.js';

/** The commit a skip is about, as the pipeline already describes it. */
export interface SkippedCommitRef {
  sha: string;
  shortSha: string;
  subject: string;
}

/**
 * Write down that a commit was passed over, and why.
 *
 * Upserted on (project, commit): a redelivered push, or a commit refused for
 * the allowance and later skipped by triage, leaves one row carrying the latest
 * reason rather than a list of the same commit.
 */
export async function recordSkip(
  projectId: string,
  commit: SkippedCommitRef,
  kind: SkipKind,
  reason: string,
  triage?: SkippedCommit['triage'],
): Promise<void> {
  const row = {
    projectId,
    commitSha: commit.sha,
    commitShortSha: commit.shortSha,
    commitSubject: commit.subject,
    kind,
    reason,
    triage: triage ?? null,
    at: new Date(),
  };
  await getDb()
    .insert(skippedCommits)
    .values(row)
    .onConflictDoUpdate({ target: [skippedCommits.projectId, skippedCommits.commitSha], set: row });
}

/** A project's skipped commits, newest first. */
export async function skipsForProject(projectId: string, limit = 25): Promise<SkippedCommit[]> {
  const rows = await getDb()
    .select()
    .from(skippedCommits)
    .where(eq(skippedCommits.projectId, projectId))
    .orderBy(desc(skippedCommits.at))
    .limit(limit);

  return rows.map((row) => {
    const skip: SkippedCommit = {
      id: row.id,
      projectId: row.projectId,
      commit: { sha: row.commitSha, shortSha: row.commitShortSha, subject: row.commitSubject },
      kind: row.kind,
      reason: row.reason,
      at: row.at.toISOString(),
    };
    if (row.triage) skip.triage = row.triage;
    return skip;
  });
}

/**
 * Forget a skip once the commit is being documented after all.
 *
 * Called when a run for it is queued, so the Activity page stops offering to
 * document something that is already on its way.
 */
export async function clearSkip(projectId: string, commitSha: string): Promise<void> {
  await getDb()
    .delete(skippedCommits)
    .where(and(eq(skippedCommits.projectId, projectId), eq(skippedCommits.commitSha, commitSha)));
}
