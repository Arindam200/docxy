/**
 * Server-side reads from the docxy API, typed loosely and failing soft: the
 * dashboard renders "offline" states instead of erroring when the pipeline
 * server is down. Consumed by server components; client mutations go through
 * the /api/docxy BFF.
 */

import { cache } from "react";

const BASE = process.env.DOCXY_API_URL || "http://localhost:4317";

/**
 * Headers for a direct call to the pipeline API, carrying the shared secret.
 *
 * These reads run on the server, so they reach the API directly rather than
 * through the /api/docxy proxy. Without the credential every read here fails
 * soft and the whole dashboard renders as "offline", which looks like the
 * pipeline is down rather than like a missing environment variable.
 *
 * Trimmed to match how the API loads the same variable: a value with stray
 * whitespace would otherwise be "configured" on one side and a different
 * string on the other, and every request a 401 that nothing explains.
 */
export function apiHeaders(base: Record<string, string> = {}) {
  const token = process.env.DOCXY_API_TOKEN?.trim();
  // Two returns rather than a conditional spread: the header is either present
  // or the object does not carry the key at all.
  if (!token) return { ...base };
  return { ...base, authorization: `Bearer ${token}` };
}

/**
 * One read, failing soft.
 *
 * The timeout signal is load-bearing - a pipeline that hangs would otherwise
 * hang the page with it - and it is also what opts this fetch out of Next's
 * per-render memoisation, which only dedupes a GET whose options match and
 * carry no signal. So nothing here is deduplicated for free. A read that more
 * than one place makes during the same render is wrapped in React's `cache`
 * where it is exported, as `fetchProjects` is below.
 */
async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      cache: "no-store",
      headers: apiHeaders(),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    // SAFETY: the caller names the shape it expects, and this read fails soft - a non-2xx or a parse error returns null instead.
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/**
 * The API's shapes, imported rather than restated.
 *
 * These used to be declared here by hand, which is a contract nobody checks:
 * removing a field from the server broke nothing at compile time and left a
 * card in this dashboard rendering a bare dash under a hint about a service
 * that no longer existed. They now come from `src/api/contract.ts`, which the
 * server is checked against on the way out - so a field that disappears there
 * fails this build.
 */
export type {
  DegradedRole,
  DocxyConfig,
  Instructions,
  Integration,
  IntegrationCategory,
  LogEntry,
  LogsPage,
  ObservabilityReport,
  ProjectRollup,
  ProjectRollupsPage,
  RepositoriesPage,
  RoleDot,
  RoleFailure,
  RoleName,
  RoleOutputs,
  RoleStats,
  RoleTrace,
  RoleUsage,
  RunDetail,
  RunPoint,
  RunStatus,
  RunSummary,
  RunTotals,
  SkipKind,
  SkippedCommit,
  SkippedCommitsPage,
  StartProjectRun,
  StartProjectRunRefusal,
  StartProjectRunResult,
  SyncedRepo,
  Tracking,
  ValidationCheck,
} from "@contract";

import type {
  DocxyConfig,
  Instructions,
  Integration,
  LogsPage,
  ObservabilityReport,
  ProjectRollupsPage,
  RepositoriesPage,
  RunDetail,
  RunSummary,
  SkippedCommitsPage,
  Tracking,
} from "@contract";

/**
 * A read scoped to one organization.
 *
 * These calls run in server components, which reach the pipeline API directly
 * and never pass through the /api/docxy proxy - so the proxy's tenant rule does
 * not cover them, and the scope has to travel from here.
 *
 * The id is a required argument rather than something read from the session
 * inside this module, so that a page which forgets it fails to compile instead
 * of quietly asking for everybody's data. That is the mistake this parameter
 * exists to make impossible; the API refuses a request without it either way.
 */
function scoped<T>(
  path: string,
  organizationId: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T | null> {
  const query = new URLSearchParams({ organizationId });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  return get<T>(`${path}?${query.toString()}`);
}

/**
 * Recent runs. Pass a project id to narrow to the one repository it watches.
 *
 * The narrowing is not cosmetic: the API returns the newest fifty runs across
 * whatever scope it is given, so filtering an organization-wide list in here
 * would silently lose a quiet project's runs once a busier one filled the
 * window.
 */
export function fetchRuns(
  organizationId: string,
  projectId?: string,
): Promise<RunSummary[] | null> {
  return scoped<RunSummary[]>("/api/runs", organizationId, { projectId });
}

/**
 * Deployment configuration: the model names, the provider, whether validation
 * is on. It describes the installation rather than any customer's work, so it
 * carries no organization.
 */
export function fetchConfig(): Promise<DocxyConfig | null> {
  return get<DocxyConfig>("/api/config");
}

/**
 * What the pipeline watches for one project: its documentation roots and the
 * symbol map learned for it. On a database deployment the server requires the
 * organization and project and answers with that project's map.
 */
export function fetchTracking(organizationId: string, projectId: string): Promise<Tracking | null> {
  return scoped<Tracking>("/api/tracking", organizationId, { projectId });
}

export function fetchInstructions(organizationId: string): Promise<Instructions | null> {
  return scoped<Instructions>("/api/instructions", organizationId);
}

export function fetchRun(id: string, organizationId: string): Promise<RunDetail | null> {
  return scoped<RunDetail>(`/api/runs/${encodeURIComponent(id)}`, organizationId);
}

export function fetchLogs(
  organizationId: string,
  params: {
    limit?: number;
    kind?: string;
    role?: string;
    run?: string;
    /** Narrows to the repository one project watches. */
    projectId?: string;
  } = {},
): Promise<LogsPage | null> {
  return scoped<LogsPage>("/api/logs", organizationId, params);
}

/** Which providers this deployment has credentials for. Not customer data. */
export function fetchIntegrations(): Promise<{ integrations: Integration[] } | null> {
  return get<{ integrations: Integration[] }>("/api/integrations");
}

export function fetchObservability(
  organizationId: string,
  { limit = 50, projectId }: { limit?: number; projectId?: string } = {},
): Promise<ObservabilityReport | null> {
  return scoped<ObservabilityReport>("/api/observability", organizationId, { limit, projectId });
}

export function fetchRepositories(organizationId: string): Promise<RepositoriesPage | null> {
  return scoped<RepositoriesPage>("/api/repositories", organizationId);
}

/** A connected repository. One project documents exactly one source repository. */
export interface Project {
  id: string;
  organizationId: string | null;
  name: string | null;
  sourceRepo: string | null;
  /** Null when the documentation lives in the source repository. */
  docsRepo: string | null;
  /** Comma-separated documentation paths, or null to use the built-in guesses. */
  docsRoots: string | null;
  key: string;
}

/**
 * The organization's projects, read once per render.
 *
 * Everything asks for this list: the dashboard layout to name the project the
 * chrome is inside, `currentProject` to resolve the one in the path, and most
 * pages for their own reasons. With the timeout signal opting `get` out of
 * Next's fetch memoisation, that was the same request two or three times per
 * page. `cache` lasts for exactly one request, so the list is never older than
 * the render showing it.
 */
export const fetchProjects = cache(
  (organizationId: string): Promise<{ projects: Project[] } | null> =>
    get<{ projects: Project[] }>(
      `/api/projects?organizationId=${encodeURIComponent(organizationId)}`,
    ),
);

/**
 * Each project's own figures, as the API rolls them up.
 *
 * The cards used to compute these here, from the one organization-wide listing
 * `fetchRuns` returns - and that listing is the newest fifty runs across every
 * repository. A quiet project fell out of it the moment a busy one filled it,
 * and its card said "never run" beside an Insights page that knew better. The
 * API counts each project over its own runs instead, by `buildReport`'s
 * definitions, so the card and the page agree.
 *
 * Null on an API that predates the endpoint as well as on one that is down. A
 * deploy does not swap both halves at the same instant, so for a while this
 * dashboard can be talking to the previous backend, which answers 404; the
 * caller falls back to rolling up the listing, which is what it did before -
 * see `projectStats` in lib/projects.ts.
 *
 * Not wrapped in `cache`: one page asks for it, once.
 */
export function fetchProjectRollups(organizationId: string): Promise<ProjectRollupsPage | null> {
  return scoped<ProjectRollupsPage>("/api/projects/rollups", organizationId);
}

/**
 * Pushes to one project that docxy chose not to document, and why.
 *
 * Null when there is nothing to say about them, which includes an API too old
 * to have the endpoint. The page hides the section either way: an empty list
 * and an unanswered question both mean there is nothing here to act on, and a
 * "could not load" notice for a section most people have never seen would be
 * a warning about something nobody was waiting for.
 */
export function fetchSkippedCommits(
  organizationId: string,
  projectId: string,
): Promise<SkippedCommitsPage | null> {
  return scoped<SkippedCommitsPage>(
    `/api/projects/${encodeURIComponent(projectId)}/skips`,
    organizationId,
  );
}

export interface NewProjectInput {
  organizationId: string;
  name: string;
  sourceRepo: string;
  /** Omitted when the docs live beside the code. */
  docsRepo?: string;
  /** Comma-separated documentation paths. Omitted to use the built-in guesses. */
  docsRoots?: string;
}

/**
 * Connect a repository. A write, so it reports its failure rather than failing
 * soft - the caller is a form, and the reasons are ones a person can act on:
 * the App is not installed there, or somebody already connected it.
 */
export async function createProject(input: NewProjectInput): Promise<Project> {
  // The organization travels in the query string, which is the only place the
  // API reads it from - see the proxy, which overwrites it from the session.
  const { organizationId, ...rest } = input;
  const res = await fetch(
    `${BASE}/api/projects?organizationId=${encodeURIComponent(organizationId)}`,
    {
    method: "POST",
    cache: "no-store",
    headers: apiHeaders({ "content-type": "application/json" }),
    body: JSON.stringify(rest),
    signal: AbortSignal.timeout(15_000),
  },
  );

  // SAFETY: only `error` and `project` are read, both optional, and a body that
  // is neither shape falls through to the thrown message below.
  const body = (await res.json().catch(() => null)) as
    | { error?: string; project?: Project }
    | null;

  if (!res.ok || !body?.project) {
    throw new Error(body?.error ?? `Could not connect the repository (${res.status}).`);
  }
  return body.project;
}

/**
 * Bind a GitHub App installation to an organization.
 *
 * A write, so unlike the reads above it does not fail soft: the caller is a
 * redirect handler, and an installation that silently failed to bind produces a
 * dashboard with no repositories and nothing saying why.
 */
export interface InstallationBinding {
  installationId: string;
  organizationId: string;
  /** The GitHub account the App was installed on, when the flow revealed it. */
  accountLogin?: string;
}

export async function bindInstallation(installation: InstallationBinding): Promise<void> {
  // The organization travels in the query string and the rest in the body,
  // matching how the API reads them. It is deliberately not in the body: the
  // proxy establishes a tenant by overwriting the query, so an endpoint that
  // took it from the body took it from whoever wrote the request.
  const { organizationId, ...rest } = installation;
  const res = await fetch(
    `${BASE}/api/installations?organizationId=${encodeURIComponent(organizationId)}`,
    {
      method: "POST",
      cache: "no-store",
      headers: apiHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(rest),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!res.ok) {
    // SAFETY: only `error` is read, as an optional string, and the `??` below
    // supplies the message when the body is not that shape or not JSON at all.
    const detail = (await res.json().catch(() => null)) as { error?: string } | null;
    // 409 is the one status callers branch on: the installation belongs to
    // another organization and no retry will change that.
    const fallback =
      res.status === 409
        ? "That installation is already bound to another organization."
        : `The pipeline refused the installation (${res.status}).`;
    throw new Error(detail?.error ?? fallback);
  }
}
