/**
 * Project helpers with no server dependencies.
 *
 * Deliberately separate from `project-scope.ts`, which resolves the project a
 * request is for and therefore reaches for `next/headers`. The sidebar, the
 * breadcrumb and the repository list are all client components that need to
 * *build* a link into a project, and importing them from the same module as the
 * resolver would pull server-only code into the browser bundle.
 */

import type { Project, RunSummary } from "./docxy";

/** Compare exact checkout keys; suffix matching can mix similarly named repos. */
export function projectRuns(project: Pick<Project, "key">, runs: RunSummary[]): RunSummary[] {
  return runs.filter((run) => run.repoPath === project.key)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** The sections a project has, in the order the sidebar lists them. */
export type ProjectSection = "overview" | "activity" | "logs" | "insights" | "settings";

const PATHS = {
  overview: "",
  activity: "/activity",
  logs: "/logs",
  insights: "/insights",
  settings: "/settings",
} satisfies Record<ProjectSection, string>;

/**
 * A link into a project, encoded once here so no caller has to remember to.
 *
 * Project ids come from the database rather than from anything typed, but they
 * still travel through a URL segment, and one call site forgetting
 * `encodeURIComponent` is the kind of bug that only shows up on the first id
 * with an awkward character in it.
 */
export function projectHref(id: string, section: ProjectSection = "overview"): string {
  return `/dashboard/projects/${encodeURIComponent(id)}${PATHS[section]}`;
}

/** Where a run opened from inside a project lives. */
export function projectRunHref(id: string, runId: string): string {
  return `${projectHref(id)}/runs/${encodeURIComponent(runId)}`;
}

/** What a project is called when it has no name of its own. */
export function projectTitle(project: Pick<Project, "name" | "sourceRepo">): string {
  return project.name || project.sourceRepo || "Project";
}

/**
 * The few numbers a project card shows, rolled up from a run listing.
 *
 * Computed here rather than fetched because the organization page already has
 * every project's runs in one listing, and asking the API for one report per
 * project would be N requests to render a grid.
 *
 * The definitions are copied from `buildReport` in
 * `src/server/observability.ts` on purpose, and have to stay copied: a card
 * saying 80% beside a project whose own Insights page says 60% is worse than
 * either number alone. `succeeded` and `settled` are that file's, verbatim.
 */
const SUCCEEDED: ReadonlyArray<RunSummary["status"]> = ["done", "approved", "awaiting-approval"];

export interface ProjectRollup {
  runs: number;
  /** Newest run, or undefined when the project has never run. */
  latest?: RunSummary;
  /** Undefined when nothing has finished yet, which is not the same as zero. */
  successRate?: number;
  /** Undefined when no run carried a price, rather than summing to a false zero. */
  costUsd?: number;
  /** Failures, and proposals that never became a pull request. */
  needsAttention: number;
}

export function rollUp(runs: RunSummary[]): ProjectRollup {
  const finished = runs.filter((run) => run.status !== "running");
  const priced = runs.filter((run) => run.totals?.costUsd !== undefined);

  return {
    runs: runs.length,
    latest: runs[0],
    successRate: finished.length
      ? finished.filter((run) => SUCCEEDED.includes(run.status)).length / finished.length
      : undefined,
    costUsd: priced.length
      ? priced.reduce((sum, run) => sum + (run.totals?.costUsd ?? 0), 0)
      : undefined,
    needsAttention: runs.filter(
      (run) =>
        run.status === "failed" ||
        (!run.pullRequestUrl &&
          (run.status === "approved" || run.status === "awaiting-approval")),
    ).length,
  };
}
