import type { RoleName } from '../config.js';
import type {
  ChangelogProposal,
  DegradedRole,
  RoleFailure,
  RoleTrace,
  RunStatus,
  RunTotals,
  ValidationCheck,
} from '../types.js';

/**
 * What the HTTP API returns, declared once.
 *
 * The dashboard is a separate application with its own `node_modules` and its
 * own build, so it used to restate every one of these shapes by hand. That is
 * a contract nobody checks: removing `trueforgeBaseUrl` from `/api/config`
 * broke nothing at compile time and left a card in the dashboard labelled
 * "Harness" rendering a bare dash, under a hint about a service that no longer
 * exists. A second drift was live at the same time - the integrations endpoint
 * had started emitting `category: 'sandbox'`, which was not in the union the
 * dashboard declared.
 *
 * This file is the shared contract. Nothing in it imports anything at runtime,
 * only types, so the dashboard can pull it in across the directory boundary
 * without dragging Hono or `node:fs` into a browser bundle. The server is
 * checked against it going out and the dashboard is checked against it coming
 * in, which is what makes a removed field a build failure in both.
 */

export type { RoleName } from '../config.js';
export type {
  DegradedRole,
  RoleFailure,
  RoleTrace,
  RoleUsage,
  RunStatus,
  RunTotals,
  ValidationCheck,
} from '../types.js';

/** Just enough of a role to draw one dot in the run list. */
export interface RoleDot {
  role: RoleName;
  status: RoleTrace['status'];
  failure?: RoleFailure;
  durationMs?: number;
  /** Attempts spent. Above 1 means the role failed and was retried. */
  attempts?: number;
}

/** `GET /api/runs` - one row per run, with no role bodies read. */
export interface RunSummary {
  id: string;
  repoPath: string;
  commit: { sha: string; shortSha: string; subject: string };
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  /** How much scrutiny the pipeline judged the change to need. */
  scope?: string;
  pullRequestUrl?: string;
  durationMs?: number;
  totals?: RunTotals;
  roles?: RoleDot[];
  /** Roles that failed without stopping the run. */
  degraded?: DegradedRole[];
  error?: string;
}

/** `GET /api/runs/:id` - the whole record, bodies included. */
export interface RunDetail extends RunSummary {
  traces: RoleTrace[];
  classification?: {
    kind: string;
    surface: string;
    summary: string;
    changedSymbols: string[];
    breakingRationale: string;
    confidence: number;
  };
  impact?: {
    docs: Array<{ path: string; section: string; reason: string; confidence: number }>;
    code: Array<{ path: string; reason: string }>;
    notes: string;
  };
  docs?: {
    edits: Array<{ path: string; section: string; mode: string; rationale: string }>;
    skipped: Array<{ path: string; reason: string }>;
  };
  changelog?: ChangelogProposal;
  validation?: {
    ok: boolean;
    checks: ValidationCheck[];
    /** What the sandbox did, when a check ran in one. */
    events?: Array<{ at: string; kind: string; text: string }>;
  };
  approval?: {
    id: string;
    scope: string;
    scopeRationale: string;
    requiredSignoffs: number;
    signoffs: Array<{ by: string; at: string }>;
    status: string;
    deniedReason?: string;
    summary: string;
  };
  priorSymbolCount: number;
  newSymbolCount: number;
}

/**
 * A repository docxy is synced to.
 *
 * "Synced" means the GitHub App is installed on it - not that a checkout exists
 * on whichever machine is serving this dashboard. `hasCheckout` reports the
 * latter as the incidental detail it is.
 */
export interface SyncedRepo {
  fullName: string;
  defaultBranch: string;
  url: string;
  checkoutPath: string;
  hasCheckout: boolean;
  /**
   * Whether a push here starts a run: the repository is connected to a project,
   * and `DOCXY_ALLOWED_REPOS` does not exclude it.
   */
  allowed: boolean;
  /**
   * Whether a project connects this repository at all. The App being installed
   * on a repository is access, not intent - `connected` is the intent.
   */
  connected: boolean;
  runCount: number;
  lastRunAt?: string;
  lastRunId?: string;
  lastRunStatus?: RunStatus;
  lastPullRequestUrl?: string;
}

export interface RepositoriesPage {
  /** Whether the App is configured at all. Nothing can be synced without it. */
  configured: boolean;
  repositories: SyncedRepo[];
  localRepoPath: string;
  /** True when DOCXY_REPO_PATH pins runs to one directory. */
  pinned: boolean;
  /**
   * `DOCXY_ALLOWED_REPOS`, when a deployment narrows the installation further.
   * Empty - the normal case - means every repository the App can see.
   * Absent on the error responses, which carry no repositories at all.
   */
  envAllowlist?: string[];
  error: string | null;
}

export interface LogEntry {
  at: string;
  kind: string;
  text: string;
  role: RoleName;
  runId: string;
  commit: string;
  subject: string;
  level: 'error' | 'info';
}

export interface LogsPage {
  entries: LogEntry[];
  total: number;
  kinds: string[];
}

export interface RoleStats {
  role: RoleName;
  runs: number;
  failed: number;
  failures: Partial<Record<RoleFailure, number>>;
  reuseRate?: number;
  medianMs?: number;
  p95Ms?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface RunPoint {
  id: string;
  startedAt: string;
  status: RunStatus;
  shortSha: string;
  subject: string;
  durationMs?: number;
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
  confidence?: number;
}

/** `GET /api/observability` - cross-run aggregates, derived on read. */
export interface ObservabilityReport {
  window: { runs: number; from?: string; to?: string };
  /** Draft output counts, not merged changes. Absent on older servers. */
  documentation?: { edits: number; documents: number; releaseNotes: number };
  outcomes: Partial<Record<RunStatus, number>>;
  successRate?: number;
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd?: number;
    costPerRunUsd?: number;
    medianRunMs?: number;
  };
  inputBreakdown: Record<string, number>;
  roles: RoleStats[];
  staleDocs: Array<{ path: string; edits: number; runs: number }>;
  series: RunPoint[];
}

/**
 * What a service is for, as the dashboard groups them.
 *
 * `sandbox` replaced `harness` when the agents moved in-process: there is no
 * separate service running them any more, and the only thing docxy still
 * reaches out to for execution is the workspace the docs build runs in.
 */
export type IntegrationCategory = 'sandbox' | 'models' | 'storage' | 'source';

export interface Integration {
  id: string;
  name: string;
  category: IntegrationCategory;
  summary: string;
  connected: boolean;
  required: boolean;
  detail: string;
  missing: string[];
  docs: string;
}

/**
 * What each role produced, keyed by role.
 *
 * Derived from `RunDetail` rather than restated, so a field whose shape changes
 * there changes here too. The Coordinator is the odd one out: it has no field of
 * its own, because its verdict survives only as the approval summary.
 *
 * The values differ per role and are rendered as formatted JSON rather than
 * read field by field - but they are still each a known shape, which is what
 * keeps this a contract instead of an open bag.
 */
export interface RoleOutputs {
  'change-analyst'?: RunDetail['classification'];
  'impact-mapper'?: RunDetail['impact'];
  'docs-updater'?: RunDetail['docs'];
  'changelog-author'?: RunDetail['changelog'];
  coordinator?: Pick<NonNullable<RunDetail['approval']>, 'summary' | 'scope'>;
}

export interface IntegrationsPage {
  integrations: Integration[];
}

export interface DocxyConfig {
  repoPath: string;
  provider: string;
  models: Record<string, string>;
  validationEnabled: boolean;
  storage?: 'postgres' | 'files';
}

export interface Tracking {
  repoPath: string;
  docsBranch: string;
  docsRoots: string[];
  changelogPath: string;
  trackedDocs: string[];
  symbolCount: number;
  symbols: Record<string, string[]>;
  processedCommits: number;
  knowledgeUpdatedAt: string;
}

export interface Instructions {
  instructions: string;
  updatedAt: string | null;
}
