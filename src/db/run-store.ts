import { randomUUID } from 'node:crypto';
import { asc, desc, eq, inArray } from 'drizzle-orm';
import type { Config, RoleName } from '../config.js';
import type { RunStorage } from '../pipeline/stores.js';
import type { ApprovalRequest, ProposedFile, RoleTrace, RunRecord } from '../types.js';
import { getDb } from './index.js';
import { projectId, type Executor } from './executor.js';
import {
  approvals,
  approvalSignoffs,
  projects,
  runEvents,
  runFiles,
  runOutputs,
  runRoleBodies,
  runRoles,
  runs,
} from './schema.js';

/**
 * Runs in Postgres.
 *
 * `save` is an upsert of the whole aggregate inside one transaction — the
 * pipeline calls it at each role boundary with a `RunRecord` that has grown,
 * and a partially written run is worse than a slow one. Children are replaced
 * rather than diffed: they are append-only in practice and small enough that
 * working out what changed would cost more than rewriting them.
 */
export class PgRunStore implements RunStorage {
  constructor(private readonly config: Config) {}

  async save(run: RunRecord): Promise<void> {
    const db = getDb();

    await db.transaction(async (tx) => {
      const project = await projectId(tx, run.repoPath || this.config.repoPath);

      const row = {
        id: run.id,
        projectId: project,
        commitSha: run.commit.sha,
        commitShortSha: run.commit.shortSha,
        commitSubject: run.commit.subject,
        status: run.status,
        docsBranch: run.docsBranch ?? null,
        error: run.error ?? null,
        priorSymbolCount: run.priorSymbolCount,
        newSymbolCount: run.newSymbolCount,
        pullRequestUrl: run.pullRequestUrl ?? null,
        durationMs: run.durationMs ?? null,
        inputTokens: run.totals?.inputTokens ?? 0,
        outputTokens: run.totals?.outputTokens ?? 0,
        cacheReadTokens: run.totals?.cacheReadTokens ?? 0,
        costUsd: run.totals?.costUsd?.toString() ?? null,
        startedAt: new Date(run.startedAt),
        finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
      };

      await tx
        .insert(runs)
        .values(row)
        .onConflictDoUpdate({ target: runs.id, set: row });

      const outputs = {
        runId: run.id,
        classification: run.classification ?? null,
        impact: run.impact ?? null,
        docs: run.docs ?? null,
        changelog: run.changelog ?? null,
        validation: run.validation ?? null,
      };
      await tx
        .insert(runOutputs)
        .values(outputs)
        .onConflictDoUpdate({ target: runOutputs.runId, set: outputs });

      await this.replaceTraces(tx, run);
      await this.replaceFiles(tx, run);
      await this.replaceApproval(tx, run);
    });
  }

  /** Deleting the roles cascades to their events, so this is one statement plus inserts. */
  private async replaceTraces(tx: Executor, run: RunRecord): Promise<void> {
    await tx.delete(runRoles).where(eq(runRoles.runId, run.id));
    if (run.traces.length === 0) return;

    // Ids are generated here rather than read back, so events can be batched in
    // the same pass without depending on the order RETURNING happens to give.
    const rows = run.traces.map((trace, ordinal) => ({ id: randomUUID(), trace, ordinal }));

    await tx.insert(runRoles).values(
      rows.map(({ id, trace, ordinal }) => ({
        id,
        runId: run.id,
        ordinal,
        role: trace.role,
        status: trace.status,
        sessionId: trace.sessionId,
        turnId: trace.turnId ?? null,
        reusedSession: trace.reusedSession,
        model: trace.model ?? null,
        error: trace.error ?? null,
        failure: trace.failure ?? null,
        durationMs: trace.durationMs ?? null,
        usage: trace.usage ?? null,
        startedAt: new Date(trace.startedAt),
        finishedAt: trace.finishedAt ? new Date(trace.finishedAt) : null,
      })),
    );

    // Bodies go in their own table; only roles that actually have one get a row.
    const bodies = rows
      .filter(({ trace }) => trace.prompt !== undefined || trace.rawOutput !== undefined)
      .map(({ id, trace }) => ({
        roleId: id,
        prompt: trace.prompt ?? null,
        rawOutput: trace.rawOutput ?? null,
      }));
    if (bodies.length > 0) await tx.insert(runRoleBodies).values(bodies);

    const events = rows.flatMap(({ id, trace }) =>
      trace.events.map((event, ordinal) => ({
        roleId: id,
        ordinal,
        at: new Date(event.at),
        kind: event.kind,
        text: event.text,
      })),
    );
    if (events.length > 0) await tx.insert(runEvents).values(events);
  }

  private async replaceFiles(tx: Executor, run: RunRecord): Promise<void> {
    await tx.delete(runFiles).where(eq(runFiles.runId, run.id));
    const files = run.proposedFiles ?? [];
    if (files.length === 0) return;

    await tx.insert(runFiles).values(
      files.map((file, ordinal) => ({
        runId: run.id,
        ordinal,
        path: file.path,
        contentBefore: file.before,
        contentAfter: file.after,
        appliedEdits: file.appliedEdits,
      })),
    );
  }

  private async replaceApproval(tx: Executor, run: RunRecord): Promise<void> {
    const approval = run.approval;
    if (!approval) {
      await tx.delete(approvals).where(eq(approvals.runId, run.id));
      return;
    }

    const row = {
      id: approval.id,
      runId: run.id,
      scope: approval.scope,
      scopeRationale: approval.scopeRationale,
      requiredSignoffs: approval.requiredSignoffs,
      status: approval.status,
      deniedReason: approval.deniedReason ?? null,
      summary: approval.summary,
      createdAt: new Date(approval.createdAt),
    };
    await tx.insert(approvals).values(row).onConflictDoUpdate({ target: approvals.id, set: row });

    await tx.delete(approvalSignoffs).where(eq(approvalSignoffs.approvalId, approval.id));
    if (approval.signoffs.length > 0) {
      await tx.insert(approvalSignoffs).values(
        approval.signoffs.map((signoff) => ({
          approvalId: approval.id,
          by: signoff.by,
          at: new Date(signoff.at),
        })),
      );
    }
  }

  async load(id: string): Promise<RunRecord | null> {
    const [record] = await this.hydrate(
      await getDb()
        .select({ run: runs, repoPath: projects.key })
        .from(runs)
        .innerJoin(projects, eq(projects.id, runs.projectId))
        .where(eq(runs.id, id))
        .limit(1),
      { bodies: true },
    );
    return record ?? null;
  }

  async list(limit = 50): Promise<RunRecord[]> {
    const db = getDb();
    const project = await projectId(db, this.config.repoPath);

    return this.hydrate(
      await db
        .select({ run: runs, repoPath: projects.key })
        .from(runs)
        .innerJoin(projects, eq(projects.id, runs.projectId))
        .where(eq(runs.projectId, project))
        .orderBy(desc(runs.startedAt))
        .limit(limit),
    );
  }

  async pending(): Promise<RunRecord[]> {
    return (await this.list(200)).filter((run) => run.status === 'awaiting-approval');
  }

  /**
   * Rebuild whole `RunRecord`s from a page of run rows.
   *
   * Children are fetched with one query each over the full id set rather than
   * per run: listing 50 runs is six queries, not three hundred.
   *
   * `bodies` is off for listings. Prompts and raw outputs are the two largest
   * fields on a run and nothing in a list renders them, which is the reason
   * they sit in their own table at all.
   */
  private async hydrate(
    rows: Array<{ run: typeof runs.$inferSelect; repoPath: string }>,
    options: { bodies: boolean } = { bodies: false },
  ): Promise<RunRecord[]> {
    if (rows.length === 0) return [];

    const db = getDb();
    const ids = rows.map((row) => row.run.id);

    const [outputRows, roleRows, fileRows, approvalRows] = await Promise.all([
      db.select().from(runOutputs).where(inArray(runOutputs.runId, ids)),
      db.select().from(runRoles).where(inArray(runRoles.runId, ids)).orderBy(asc(runRoles.ordinal)),
      db.select().from(runFiles).where(inArray(runFiles.runId, ids)).orderBy(asc(runFiles.ordinal)),
      db.select().from(approvals).where(inArray(approvals.runId, ids)),
    ]);

    const roleIds = roleRows.map((role) => role.id);
    const approvalIds = approvalRows.map((approval) => approval.id);

    const [eventRows, signoffRows, bodyRows] = await Promise.all([
      roleIds.length > 0
        ? db
            .select()
            .from(runEvents)
            .where(inArray(runEvents.roleId, roleIds))
            .orderBy(asc(runEvents.ordinal))
        : Promise.resolve([]),
      approvalIds.length > 0
        ? db
            .select()
            .from(approvalSignoffs)
            .where(inArray(approvalSignoffs.approvalId, approvalIds))
            .orderBy(asc(approvalSignoffs.at))
        : Promise.resolve([]),
      options.bodies && roleIds.length > 0
        ? db.select().from(runRoleBodies).where(inArray(runRoleBodies.roleId, roleIds))
        : Promise.resolve([]),
    ]);

    const bodiesByRole = new Map(bodyRows.map((body) => [body.roleId, body]));
    const eventsByRole = groupBy(eventRows, (event) => event.roleId);
    const signoffsByApproval = groupBy(signoffRows, (signoff) => signoff.approvalId);
    const rolesByRun = groupBy(roleRows, (role) => role.runId);
    const filesByRun = groupBy(fileRows, (file) => file.runId);
    const outputsByRun = new Map(outputRows.map((output) => [output.runId, output]));
    const approvalsByRun = new Map(approvalRows.map((approval) => [approval.runId, approval]));

    return rows.map(({ run, repoPath }) => {
      const outputs = outputsByRun.get(run.id);
      const approval = approvalsByRun.get(run.id);
      const files = filesByRun.get(run.id) ?? [];

      // SAFETY: `role` and `status` are free-text columns holding domain unions.
      // Only this store writes them, always from a `RoleTrace`, so a value that
      // is not a member could only come from a hand-edited row.
      const traces: RoleTrace[] = (rolesByRun.get(run.id) ?? []).map((role) => {
        const body = bodiesByRole.get(role.id);
        return {
          role: role.role as RoleName,
          sessionId: role.sessionId,
          turnId: role.turnId ?? undefined,
          startedAt: role.startedAt.toISOString(),
          finishedAt: role.finishedAt?.toISOString(),
          status: role.status as RoleTrace['status'],
          events: (eventsByRole.get(role.id) ?? []).map((event) => ({
            at: event.at.toISOString(),
            kind: event.kind,
            text: event.text,
          })),
          error: role.error ?? undefined,
          reusedSession: role.reusedSession,
          model: role.model ?? undefined,
          failure: role.failure ?? undefined,
          durationMs: role.durationMs ?? undefined,
          usage: role.usage ?? undefined,
          prompt: body?.prompt ?? undefined,
          rawOutput: body?.rawOutput ?? undefined,
        };
      });

      const proposedFiles: ProposedFile[] = files.map((file) => ({
        path: file.path,
        before: file.contentBefore,
        after: file.contentAfter,
        appliedEdits: file.appliedEdits,
      }));

      // SAFETY: as above — `scope` and `status` are only ever written from an
      // `ApprovalRequest` by `replaceApproval`.
      const request: ApprovalRequest | undefined = approval
        ? {
            id: approval.id,
            runId: run.id,
            createdAt: approval.createdAt.toISOString(),
            scope: approval.scope as ApprovalRequest['scope'],
            scopeRationale: approval.scopeRationale,
            requiredSignoffs: approval.requiredSignoffs,
            signoffs: (signoffsByApproval.get(approval.id) ?? []).map((signoff) => ({
              by: signoff.by,
              at: signoff.at.toISOString(),
            })),
            status: approval.status as ApprovalRequest['status'],
            deniedReason: approval.deniedReason ?? undefined,
            summary: approval.summary,
          }
        : undefined;

      return {
        id: run.id,
        repoPath,
        commit: {
          sha: run.commitSha,
          shortSha: run.commitShortSha,
          subject: run.commitSubject,
        },
        startedAt: run.startedAt.toISOString(),
        finishedAt: run.finishedAt?.toISOString(),
        status: run.status,
        traces,
        classification: outputs?.classification ?? undefined,
        impact: outputs?.impact ?? undefined,
        docs: outputs?.docs ?? undefined,
        changelog: outputs?.changelog ?? undefined,
        validation: outputs?.validation ?? undefined,
        // Absent, not empty: a run saved before any file was proposed should
        // round-trip as `undefined` the way the JSON store leaves it.
        proposedFiles: proposedFiles.length > 0 ? proposedFiles : undefined,
        docsBranch: run.docsBranch ?? undefined,
        approval: request,
        pullRequestUrl: run.pullRequestUrl ?? undefined,
        error: run.error ?? undefined,
        priorSymbolCount: run.priorSymbolCount,
        newSymbolCount: run.newSymbolCount,
        durationMs: run.durationMs ?? undefined,
        totals: {
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          cacheReadTokens: run.cacheReadTokens,
          costUsd: run.costUsd ? Number(run.costUsd) : undefined,
        },
      };
    });
  }
}

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const bucket = out.get(key(item));
    if (bucket) bucket.push(item);
    else out.set(key(item), [item]);
  }
  return out;
}
