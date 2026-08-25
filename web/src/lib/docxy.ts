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

export interface RunSummary {
  id: string;
  commit: { sha: string; shortSha: string; subject: string };
  status: "running" | "awaiting-approval" | "approved" | "denied" | "failed" | "done";
  startedAt: string;
  finishedAt?: string;
  scope?: string;
  gate?: unknown;
  pullRequestUrl?: string;
}

export interface DocxyConfig {
  repoPath: string;
  trueforgeBaseUrl: string;
  provider: string;
  models: Record<string, string>;
  validationEnabled: boolean;
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
