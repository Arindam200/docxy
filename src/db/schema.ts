/**
 * The pipeline's Postgres schema, in the `public` schema of the same Neon
 * database the dashboard uses. Better Auth's tables live in `auth`; see
 * guides/DATABASE.md for why the two are kept apart.
 *
 * Two principles shape this, both from that guide:
 *
 *   1. Big text lives outside the hot tables. Prompts, raw model output, and
 *      file bodies are large and read only on a detail view, so the run list
 *      stays a cheap query.
 *   2. Model output is jsonb. `classification`, `impact`, `docs`, `changelog`
 *      and `validation` are shaped but still evolving; columns would mean a
 *      migration every time a role's output schema moves.
 */

import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type {
  ChangelogProposal,
  Classification,
  DocsProposal,
  ImpactMap,
  RoleFailure,
  RoleUsage,
  RunStatus,
  ValidationReport,
} from '../types.js';

/** The repository being documented. Sessions and knowledge hang off this. */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  /** The repository path, as the pipeline is configured to see it. */
  key: text('key').notNull().unique(),
  /**
   * When the knowledge map last changed. Kept here rather than derived from
   * `max(knowledge_symbols.updated_at)` so that processing a commit that
   * teaches nothing new still moves the clock.
   */
  knowledgeUpdatedAt: timestamp('knowledge_updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/**
 * One long-lived harness session per role, per project.
 *
 * `specHash` fixes a real bug in the file-backed version: the agent spec is
 * frozen when the session is created, so editing a prompt or swapping a model
 * had no effect until sessions were manually cleared. Keying on the hash means
 * a changed spec transparently starts a new session.
 */
export const agentSessions = pgTable(
  'agent_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    role: text('role').notNull(),
    sessionId: text('session_id').notNull(),
    specHash: text('spec_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('agent_sessions_project_role').on(t.projectId, t.role)],
);

export const runs = pgTable(
  'runs',
  {
    /** Supplied by the pipeline (`randomUUID()`), not generated here. */
    id: uuid('id').primaryKey(),
    projectId: uuid('project_id')
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    commitSha: text('commit_sha').notNull(),
    commitShortSha: text('commit_short_sha').notNull(),
    commitSubject: text('commit_subject').notNull(),
    status: text('status').$type<RunStatus>().notNull(),
    docsBranch: text('docs_branch'),
    error: text('error'),
    priorSymbolCount: integer('prior_symbol_count').default(0).notNull(),
    newSymbolCount: integer('new_symbol_count').default(0).notNull(),
    pullRequestUrl: text('pull_request_url'),
    durationMs: integer('duration_ms'),
    /** Rolled up from the roles, so the run list needs no join to show totals. */
    inputTokens: integer('input_tokens').default(0).notNull(),
    outputTokens: integer('output_tokens').default(0).notNull(),
    cacheReadTokens: integer('cache_read_tokens').default(0).notNull(),
    /** Numeric as text. Never a float for money. */
    costUsd: text('cost_usd'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('runs_project_started').on(t.projectId, t.startedAt),
    index('runs_commit').on(t.commitSha),
    // `pending()` filters on this, and awaiting-approval runs are a small slice.
    index('runs_status').on(t.status),
  ],
);

/** Each role's structured output, exactly as returned. */
export const runOutputs = pgTable('run_outputs', {
  runId: uuid('run_id')
    .references(() => runs.id, { onDelete: 'cascade' })
    .primaryKey(),
  classification: jsonb('classification').$type<Classification>(),
  impact: jsonb('impact').$type<ImpactMap>(),
  docs: jsonb('docs').$type<DocsProposal>(),
  changelog: jsonb('changelog').$type<ChangelogProposal>(),
  validation: jsonb('validation').$type<ValidationReport>(),
});

export const runRoles = pgTable(
  'run_roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .references(() => runs.id, { onDelete: 'cascade' })
      .notNull(),
    /** Position in `RunRecord.traces`, so the timeline reloads in order. */
    ordinal: integer('ordinal').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull(),
    sessionId: text('session_id').notNull(),
    turnId: text('turn_id'),
    reusedSession: boolean('reused_session').default(false).notNull(),
    /** Which model actually ran; roles can be pointed at different ones. */
    model: text('model'),
    error: text('error'),
    /** harness-error | parse-error | timeout | aborted */
    failure: text('failure').$type<RoleFailure>(),
    durationMs: integer('duration_ms'),
    /** Token counts plus the harness's own input-side breakdown. */
    usage: jsonb('usage').$type<RoleUsage>(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [index('run_roles_run_ordinal').on(t.runId, t.ordinal)],
);

/**
 * The verbatim prompt and raw model output, split out deliberately.
 *
 * These are the two largest fields on a run and are read only when someone
 * opens a single role. Keeping them out of `run_roles` is what lets the run
 * list stay a cheap query, and what lets retention drop bodies past N days
 * while the run and role rows survive.
 */
export const runRoleBodies = pgTable('run_role_bodies', {
  roleId: uuid('role_id')
    .references(() => runRoles.id, { onDelete: 'cascade' })
    .primaryKey(),
  prompt: text('prompt'),
  rawOutput: text('raw_output'),
});

export const runEvents = pgTable(
  'run_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleId: uuid('role_id')
      .references(() => runRoles.id, { onDelete: 'cascade' })
      .notNull(),
    /** Events within a role can share a timestamp, so order is explicit. */
    ordinal: integer('ordinal').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
  },
  (t) => [index('run_events_role_ordinal').on(t.roleId, t.ordinal)],
);

/** Split out deliberately: large, and only read on the detail view. */
export const runFiles = pgTable(
  'run_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id')
      .references(() => runs.id, { onDelete: 'cascade' })
      .notNull(),
    ordinal: integer('ordinal').notNull(),
    path: text('path').notNull(),
    contentBefore: text('content_before').notNull(),
    contentAfter: text('content_after').notNull(),
    appliedEdits: integer('applied_edits').default(0).notNull(),
  },
  (t) => [index('run_files_run_ordinal').on(t.runId, t.ordinal)],
);

export const approvals = pgTable('approvals', {
  /** Supplied by the approval gate, not generated here. */
  id: uuid('id').primaryKey(),
  runId: uuid('run_id')
    .references(() => runs.id, { onDelete: 'cascade' })
    .notNull()
    .unique(),
  scope: text('scope').notNull(),
  scopeRationale: text('scope_rationale').notNull(),
  requiredSignoffs: integer('required_signoffs').notNull(),
  status: text('status').notNull(),
  deniedReason: text('denied_reason'),
  summary: text('summary').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

/**
 * One row per sign-off. The unique index on (approval, by) is what enforces
 * "two *different* people" in the database rather than only in application
 * code — the rule elevated scope exists for.
 */
export const approvalSignoffs = pgTable(
  'approval_signoffs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    approvalId: uuid('approval_id')
      .references(() => approvals.id, { onDelete: 'cascade' })
      .notNull(),
    by: text('by').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex('approval_signoffs_unique').on(t.approvalId, t.by)],
);

/** The accumulating symbol → doc-section map, per project. */
export const knowledgeSymbols = pgTable(
  'knowledge_symbols',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    projectId: uuid('project_id')
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    symbol: text('symbol').notNull(),
    docSections: jsonb('doc_sections').$type<string[]>().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('knowledge_project_symbol').on(t.projectId, t.symbol)],
);

/**
 * Commits already folded into the map. A table rather than an array column so
 * that recording one is an insert instead of a read-modify-write of the whole
 * list — which is what makes two workers on the same repo safe.
 */
export const knowledgeCommits = pgTable(
  'knowledge_commits',
  {
    projectId: uuid('project_id')
      .references(() => projects.id, { onDelete: 'cascade' })
      .notNull(),
    sha: text('sha').notNull(),
    seenAt: timestamp('seen_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.sha] }),
    index('knowledge_commits_seen').on(t.projectId, t.seenAt),
  ],
);

export const schema = {
  projects,
  agentSessions,
  runs,
  runOutputs,
  runRoles,
  runRoleBodies,
  runEvents,
  runFiles,
  approvals,
  approvalSignoffs,
  knowledgeSymbols,
  knowledgeCommits,
};
