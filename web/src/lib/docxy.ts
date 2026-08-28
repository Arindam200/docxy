/**
 * Server-side reads from the docxy API, typed loosely and failing soft: the
 * dashboard renders "offline" states instead of erroring when the pipeline
 * server is down. Consumed by server components; client mutations go through
 * the /api/docxy BFF.
 */

const BASE = process.env.DOCXY_API_URL || "http://localhost:4317";

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    // SAFETY: the caller names the shape it expects, and this read fails soft — a non-2xx or a parse error returns null instead.
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export type RunStatus =
  | "running"
  | "awaiting-approval"
  | "approved"
  | "denied"
  | "failed"
  | "done";

export type RoleName =
  | "coordinator"
  | "change-analyst"
  | "impact-mapper"
  | "docs-updater"
  | "changelog-author";

export type RoleFailure =
  | "harness-error"
  | "parse-error"
  | "timeout"
  | "aborted"
  | "max-tokens"
  | "context"
  | "rate-limit"
  | "cancelled"
  | "stalled";

export interface RunTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  costUsd?: number;
}

/** Just enough of a role to draw one dot in the run list. */
export interface RoleDot {
  role: RoleName;
  status: "running" | "done" | "failed";
  failure?: RoleFailure;
  durationMs?: number;
  /** Attempts spent. Above 1 means the role failed and was retried. */
  attempts?: number;
}

/** A role that failed without stopping the run. */
export interface DegradedRole {
  role: RoleName;
  reason: string;
}

export interface RunSummary {
  id: string;
  commit: { sha: string; shortSha: string; subject: string };
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  scope?: string;
  pullRequestUrl?: string;
  durationMs?: number;
  totals?: RunTotals;
  roles?: RoleDot[];
  degraded?: DegradedRole[];
  error?: string;
}

export interface RoleUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputBreakdown?: Record<string, number>;
}

export interface RoleTrace {
  role: RoleName;
  sessionId: string;
  turnId?: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "done" | "failed";
  events: Array<{ at: string; kind: string; text: string }>;
  error?: string;
  reusedSession: boolean;
  prompt?: string;
  rawOutput?: string;
  model?: string;
  durationMs?: number;
  usage?: RoleUsage;
  failure?: RoleFailure;
  attempts?: number;
}

export interface ValidationCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
  /**
   * Where the check ran. Absent on checks that execute nothing, and on runs
   * recorded before validation could run anywhere but the pipeline's own host.
   */
  where?: "sandbox" | "local";
}

/** The whole run record, as `GET /api/runs/:id` returns it. */
export interface RunDetail extends RunSummary {
  repoPath: string;
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
  changelog?: { entry: string; section: string; semverBump: string; bumpRationale: string };
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
  error?: string;
  /** Roles that failed without stopping the run. */
  degraded?: DegradedRole[];
  priorSymbolCount: number;
  newSymbolCount: number;
}

/**
 * A repository docxy is synced to.
 *
 * "Synced" means the GitHub App is installed on it — not that a checkout exists
 * on whichever machine is serving this dashboard. `hasCheckout` reports the
 * latter as the incidental detail it is.
 */
export interface SyncedRepo {
  fullName: string;
  defaultBranch: string;
  url: string;
  checkoutPath: string;
  hasCheckout: boolean;
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
  level: "error" | "info";
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

/** `GET /api/observability` — cross-run aggregates, derived on read. */
export interface ObservabilityReport {
  window: { runs: number; from?: string; to?: string };
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

export interface Integration {
  id: string;
  name: string;
  category: "harness" | "models" | "storage" | "source";
  summary: string;
  connected: boolean;
  required: boolean;
  detail: string;
  missing: string[];
  docs: string;
}

export interface DocxyConfig {
  repoPath: string;
  trueforgeBaseUrl: string;
  provider: string;
  models: Record<string, string>;
  validationEnabled: boolean;
  storage?: "postgres" | "files";
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

export function fetchRuns(): Promise<RunSummary[] | null> {
  return get<RunSummary[]>("/api/runs");
}

export function fetchConfig(): Promise<DocxyConfig | null> {
  return get<DocxyConfig>("/api/config");
}

export function fetchTracking(): Promise<Tracking | null> {
  return get<Tracking>("/api/tracking");
}

export function fetchInstructions(): Promise<Instructions | null> {
  return get<Instructions>("/api/instructions");
}

export function fetchRun(id: string): Promise<RunDetail | null> {
  return get<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
}

export function fetchLogs(params: {
  limit?: number;
  kind?: string;
  role?: string;
  run?: string;
} = {}): Promise<LogsPage | null> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : "";
  return get<LogsPage>(`/api/logs${suffix}`);
}

export function fetchIntegrations(): Promise<{ integrations: Integration[] } | null> {
  return get<{ integrations: Integration[] }>("/api/integrations");
}

export function fetchObservability(limit = 50): Promise<ObservabilityReport | null> {
  return get<ObservabilityReport>(`/api/observability?limit=${limit}`);
}

export function fetchRepositories(): Promise<RepositoriesPage | null> {
  return get<RepositoriesPage>("/api/repositories");
}
