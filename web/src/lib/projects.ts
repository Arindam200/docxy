/**
 * Project helpers with no server dependencies.
 *
 * Deliberately separate from `project-scope.ts`, which resolves the project a
 * request is for and therefore reaches for `next/headers`. The sidebar, the
 * breadcrumb and the repository list are all client components that need to
 * *build* a link into a project, and importing them from the same module as the
 * resolver would pull server-only code into the browser bundle.
 */

import type {
  Project,
  ProjectRollup as ApiRollup,
  ProjectRollupsPage,
  RunSummary,
} from "./docxy";

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
 * The few numbers a project card shows.
 *
 * The API's own rollup, less the id it is keyed by - a card already knows which
 * project it is. Derived rather than restated, so a field that changes in the
 * contract changes the cards with it instead of drifting from them.
 */
export type ProjectRollup = Omit<ApiRollup, "projectId">;

/**
 * The same figures, rolled up here from a run listing.
 *
 * This is how every card was drawn until the API learned to count each project
 * over its own runs, and it is now only the fallback for an API that has not -
 * the previous backend, during a deploy. It works from the organization-wide
 * listing, the newest fifty runs across every repository, so a quiet project
 * can be missing from it entirely; that is the bug the API's rollups fix, and
 * it is the reason this is a fallback rather than a second opinion.
 *
 * The definitions are copied from `buildReport` in
 * `src/server/observability.ts` on purpose, and have to stay copied for as long
 * as this exists: a card that changed its arithmetic during a deploy would say
 * 80% one minute and 60% the next about the same runs. `succeeded` and
 * `settled` are that file's, verbatim.
 */
const SUCCEEDED: ReadonlyArray<RunSummary["status"]> = ["done", "approved", "awaiting-approval"];

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

/**
 * Every project with the figures its card shows.
 *
 * The API's rollups when it sent them, and a roll-up of the organization-wide
 * listing when it did not - never a mix of the two. A project the rollups leave
 * out is counted as never having run rather than looked up in the listing,
 * because the two are different windows over different runs: a grid sorted by
 * "latest run" with half its cards from each would put them in an order
 * neither source agrees with, and a project with no rollup is a project the API
 * found no runs for.
 *
 * Generic over the project so a caller keeps whichever fields it passed in -
 * the projects page trims them before they cross into a client component.
 */
export function projectStats<P extends Pick<Project, "id" | "key">>(
  projects: P[],
  rollups: ProjectRollupsPage | null,
  runs: RunSummary[],
): Array<{ project: P; stats: ProjectRollup }> {
  if (!rollups) {
    return projects.map((project) => ({ project, stats: rollUp(projectRuns(project, runs)) }));
  }
  const own = new Map(rollups.rollups.map((rollup) => [rollup.projectId, rollup]));
  return projects.map((project) => ({ project, stats: own.get(project.id) ?? rollUp([]) }));
}
