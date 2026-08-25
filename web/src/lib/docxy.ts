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

export type RoleFailure = "harness-error" | "parse-error" | "timeout" | "aborted";

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
}

export interface RunSummary {
  id: string;
  commit: { sha: string; shortSha: string; subject: string };
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  scope?: string;
  gate?: unknown;
  pullRequestUrl?: string;
  durationMs?: number;
  totals?: RunTotals;
  roles?: RoleDot[];
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
}

export interface ValidationCheck {
  name: string;
  status: "pass" | "fail" | "skipped";
  detail: string;
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
  validation?: { ok: boolean; checks: ValidationCheck[] };
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
  priorSymbolCount: number;
  newSymbolCount: number;
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
