import { createHash } from 'node:crypto';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { Config, RoleName } from '../config.js';
import type { LogPage, LogQuery, RunStorage } from '../pipeline/stores.js';
import type { ApprovalRequest, ProposedFile, RoleTrace, RunRecord } from '../types.js';
import { getDb, type Database } from './index.js';
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

  /**
   * Events already written, per role row.
   *
   * Per instance, which is the right scope: the pipeline builds its own store
   * for the run it is writing, and it is the only writer of that run. A reader
   * elsewhere has its own instance and an empty map, which costs nothing
   * because readers never call `save`.
   */
  private readonly eventMark = new Map<string, number>();

  async save(run: RunRecord): Promise<void> {
    const db = getDb();

    try {
      await this.write(db, run);
    } catch (err) {
      // A rolled-back transaction may have left the marks claiming events are
      // stored that are not. Dropping them costs one full re-send on the next
      // save and is the only way back to a state that is certainly correct.
      this.eventMark.clear();
      throw err;
    }
  }

  private async write(db: Database, run: RunRecord): Promise<void> {
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
        publication: run.publication ?? null,
        degraded: run.degraded ?? null,
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

  /**
   * Write the roles, their bodies, and any events not yet stored.
   *
   * This used to delete every role and re-insert it — which cascaded to the
   * events and re-wrote them too — on each of the nineteen saves a run makes.
   * The last save of a five-role run therefore rewrote every row the run had
   * ever produced, so the cost of recording a run grew with the square of its
   * own length, and a long run spent more time rewriting its history than
   * making any.
   *
   * Now role ids are derived from the run and the ordinal rather than
   * generated, so a role keeps its identity across saves and can be upserted.
   * Events are append-only and only the ones past the high-water mark are sent.
   */
  private async replaceTraces(tx: Executor, run: RunRecord): Promise<void> {
    if (run.traces.length === 0) {
      await tx.delete(runRoles).where(eq(runRoles.runId, run.id));
      return;
    }

    const rows = run.traces.map((trace, ordinal) => ({
      id: roleRowId(run.id, ordinal),
      trace,
      ordinal,
    }));

    for (const { id, trace, ordinal } of rows) {
      const row = {
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
        attempts: trace.attempts ?? 1,
        durationMs: trace.durationMs ?? null,
        usage: trace.usage ?? null,
        startedAt: new Date(trace.startedAt),
        finishedAt: trace.finishedAt ? new Date(trace.finishedAt) : null,
      };
      await tx.insert(runRoles).values(row).onConflictDoUpdate({ target: runRoles.id, set: row });
    }

    // Bodies go in their own table; only roles that actually have one get a row.
    for (const { id, trace } of rows) {
      if (trace.prompt === undefined && trace.rawOutput === undefined) continue;
      const body = {
        roleId: id,
        prompt: trace.prompt ?? null,
        rawOutput: trace.rawOutput ?? null,
      };
      await tx
        .insert(runRoleBodies)
        .values(body)
        .onConflictDoUpdate({ target: runRoleBodies.roleId, set: body });
    }

    const events = rows.flatMap(({ id, trace }) => {
      // Events only ever accumulate, so everything below the mark is already
      // stored and identical. Sending it again is the cost this avoids.
      const written = this.eventMark.get(id) ?? 0;
      return trace.events.slice(written).map((event, offset) => ({
        roleId: id,
        ordinal: written + offset,
        at: new Date(event.at),
        kind: event.kind,
        text: event.text,
      }));
    });

    if (events.length > 0) {
      await tx.insert(runEvents).values(events);
      // Advanced only once the insert has gone through. The transaction may
      // still roll back, which `save` handles by dropping the marks entirely.
      for (const { id, trace } of rows) this.eventMark.set(id, trace.events.length);
    }

    // Anything left under this run that is not one of the rows above.
    //
    // Two cases, one statement. A run whose trace list shrank leaves a tail of
    // stale roles; and a run first saved before ids were derived has rows under
    // *random* ids, which would otherwise sit alongside the derived ones and
    // show every role twice. Cascades to their events, which is the intent.
    await tx
      .delete(runRoles)
      .where(
        and(
          eq(runRoles.runId, run.id),
          notInArray(
            runRoles.id,
            rows.map((r) => r.id),
          ),
        ),
      );
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
    // A run id is a UUID column, and Postgres rejects anything that is not one
    // with a cast error rather than an empty result. That turned every lookup
    // by a *prefix* — which `docxy approve 061fe721` and every short id in the
    // CLI's own output are — into a raw SQL failure instead of the miss the
    // caller is written to handle by widening the search.
    if (!UUID.test(id)) return null;

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

  async list(limit = 50, repoPaths?: string[]): Promise<RunRecord[]> {
    const db = getDb();

    // Resolving each path creates the project row if it is new, which is
    // correct: a repository the App is installed on is one docxy is synced to
    // whether or not it has run yet, and an empty listing is the honest answer
    // rather than a missing one.
    const paths = repoPaths && repoPaths.length > 0 ? repoPaths : [this.config.repoPath];
    const ids = await Promise.all(paths.map((path) => projectId(db, path)));

    return this.hydrate(
      await db
        .select({ run: runs, repoPath: projects.key })
        .from(runs)
        .innerJoin(projects, eq(projects.id, runs.projectId))
        .where(inArray(runs.projectId, [...new Set(ids)]))
        .orderBy(desc(runs.startedAt))
        .limit(limit),
    );
  }

  async pending(): Promise<RunRecord[]> {
    return (await this.list(200)).filter((run) => run.status === 'awaiting-approval');
  }

  /**
   * Events joined to their run, filtered and ordered in the database.
   *
   * The alternative — and what this replaces — was rebuilding fifty whole
   * `RunRecord`s and flattening them in memory, which read every role, file,
   * and approval those runs owned so that a few hundred log lines could be
   * rendered. Three indexed queries instead of six full hydrations.
   */
  async logs(query: LogQuery): Promise<LogPage> {
    const db = getDb();

    // Same reason as `load`: a `?run=` that is not a UUID is a miss, and
    // Postgres would answer it with a cast error instead of an empty page.
    if (query.runId && !UUID.test(query.runId)) return { entries: [], total: 0, kinds: [] };

    // As in `list`: naming a repository is what makes it visible, whether or
    // not it has run yet.
    const visibleProjects = [
      ...new Set(
        await Promise.all(
          (query.repoPaths && query.repoPaths.length > 0
            ? query.repoPaths
            : [this.config.repoPath]
          ).map((path) => projectId(db, path)),
        ),
      ),
    ];

    // A named run narrows within those projects rather than replacing them. Run
    // ids are visible in every dashboard URL, so a query that named one was a
    // way to read the events of a repository the caller was never granted.
    const withinScope = inArray(runs.projectId, visibleProjects);
    const scope = query.runId
      ? and(withinScope, eq(runs.id, query.runId))
      : withinScope;

    const filters = [
      scope,
      ...(query.kind ? [eq(runEvents.kind, query.kind)] : []),
      ...(query.role ? [eq(runRoles.role, query.role)] : []),
    ];

    const joined = db
      .select({
        at: runEvents.at,
        kind: runEvents.kind,
        text: runEvents.text,
        role: runRoles.role,
        runId: runs.id,
        commit: runs.commitShortSha,
        subject: runs.commitSubject,
      })
      .from(runEvents)
      .innerJoin(runRoles, eq(runRoles.id, runEvents.roleId))
      .innerJoin(runs, eq(runs.id, runRoles.runId))
      .where(and(...filters));

    const [rows, [counted], kindRows] = await Promise.all([
      joined.orderBy(desc(runEvents.at)).limit(query.limit),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(runEvents)
        .innerJoin(runRoles, eq(runRoles.id, runEvents.roleId))
        .innerJoin(runs, eq(runs.id, runRoles.runId))
        .where(and(...filters)),
      // Unfiltered by kind on purpose: the control has to offer the kinds you
      // are not currently looking at, or it can never be un-narrowed.
      db
        .selectDistinct({ kind: runEvents.kind })
        .from(runEvents)
        .innerJoin(runRoles, eq(runRoles.id, runEvents.roleId))
        .innerJoin(runs, eq(runs.id, runRoles.runId))
        .where(and(scope, ...(query.role ? [eq(runRoles.role, query.role)] : []))),
    ]);

    return {
      // SAFETY: `role` is a free-text column only this store writes, always
      // from a `RoleTrace`, where it is typed `RoleName`.
      entries: rows.map((row) => ({
        at: row.at.toISOString(),
        kind: row.kind,
        text: row.text,
        role: row.role as RoleName,
        runId: row.runId,
        commit: row.commit,
        subject: row.subject,
        level: row.kind === 'error' ? ('error' as const) : ('info' as const),
      })),
      total: counted?.total ?? rows.length,
      kinds: kindRows.map((row) => row.kind).sort(),
    };
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
   *
   * So are the proposed files, for the same reason and a worse one: a row in
   * `run_files` holds a documentation page twice over, before and after. Fifty
   * runs of those crossed the wire so that a dashboard could count how many
   * runs a repository had. Only the detail view — and the publish path behind
   * it, which reads `run.proposedFiles` to know what was approved — needs them.
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
      options.bodies
        ? db
            .select()
            .from(runFiles)
            .where(inArray(runFiles.runId, ids))
            .orderBy(asc(runFiles.ordinal))
        : Promise.resolve([]),
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
          // SAFETY: this column is written only by `save`, from the same `RoleName` union.
          role: role.role as RoleName,
          sessionId: role.sessionId,
          turnId: role.turnId ?? undefined,
          startedAt: role.startedAt.toISOString(),
          finishedAt: role.finishedAt?.toISOString(),
          // SAFETY: this column is written only by `save`, from the same status union.
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
          attempts: role.attempts,
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
        publication: outputs?.publication ?? undefined,
        // SAFETY: written only by `write`, always from `RunRecord.degraded`.
        degraded: (outputs?.degraded as RunRecord['degraded']) ?? undefined,
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

/**
 * A role's row id, derived rather than generated.
 *
 * A role is identified by its run and its position in that run, and both are
 * known before the row exists. Deriving the id is what lets a save upsert the
 * role it wrote last time instead of deleting and re-creating it — and keeps
 * the events hanging off it, which a delete would cascade away.
 *
 * Shaped as a UUID because the column is one; the bytes are a hash, so this is
 * a name, not a claim of randomness.
 */
function roleRowId(runId: string, ordinal: number): string {
  const hex = createHash('sha256').update(`${runId}:${ordinal}`).digest('hex');
  // Version and variant nibbles set so the value is a well-formed UUID.
  const v = `${hex.slice(0, 12)}5${hex.slice(13, 16)}${((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 32)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/** Canonical 8-4-4-4-12 hex, which is all the `uuid` columns will accept. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const bucket = out.get(key(item));
    if (bucket) bucket.push(item);
    else out.set(key(item), [item]);
  }
  return out;
}
