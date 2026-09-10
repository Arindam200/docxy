import Link from "next/link";
import { notFound } from "next/navigation";
import { LuArrowRight, LuBookOpen, LuGitBranch } from "react-icons/lu";
import { fetchObservability, fetchRepositories, fetchRuns } from "@/lib/docxy";
import { duration, timeAgo } from "@/lib/format";
import { ApiOffline } from "@/components/dashboard/ApiOffline";
import { StatCard } from "@/components/dashboard/StatCard";
import { RunTimeline } from "@/components/dashboard/RunTimeline";
import { LiveUpdates } from "@/components/dashboard/LiveUpdates";
import { currentProject } from "@/lib/project-scope";
import { projectHref, projectRunHref } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * What somebody wants to know within a second of opening a project: is it
 * working, and what happened last.
 *
 * Everything longer lives in the sections beside it. The documentation setup
 * that used to fill the bottom half of this page moved to Settings, because it
 * is what you configure once rather than what you check; the anchor links that
 * jumped between the two are real routes now.
 */
export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await currentProject(id);
  // The layout already rendered the offline state above these children, so
  // there is nothing left to say here.
  if (scope.kind === "offline") return null;
  if (scope.kind === "missing") notFound();

  const { project, organizationId } = scope;
  const [runs, report, repositories] = await Promise.all([
    fetchRuns(organizationId, project.id),
    fetchObservability(organizationId, { projectId: project.id }),
    fetchRepositories(organizationId),
  ]);

  const history = runs ?? [];
  const latest = history[0];
  const repository = repositories?.repositories.find(
    (repo) => repo.fullName.toLowerCase() === project.sourceRepo?.toLowerCase(),
  );

  // Runs that produced nothing anybody can act on: a failure, or an approval
  // that never became a pull request.
  const attention = history.filter(
    (run) =>
      run.status === "failed" ||
      (!run.pullRequestUrl && (run.status === "approved" || run.status === "awaiting-approval")),
  );

  return (
    <>
      <section aria-labelledby="project-health" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="project-health" className="text-lg font-semibold tracking-tight">
            Health
          </h2>
          <LiveUpdates />
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-rule border border-rule bg-surface md:grid-cols-4 md:divide-y-0">
          <StatCard
            label="Runs"
            value={runs === null ? "N/A" : history.length}
            hint={repository?.defaultBranch ? `on ${repository.defaultBranch}` : "in this window"}
          />
          <StatCard
            label="Success rate"
            value={
              report?.successRate === undefined
                ? "N/A"
                : `${Math.round(report.successRate * 100)}%`
            }
            hint={report ? `${report.outcomes.failed} failed of ${report.window.runs}` : "no report"}
            accent={report?.successRate !== undefined && report.successRate < 0.8}
          />
          <StatCard
            label="Typical run"
            value={duration(report?.totals.medianRunMs)}
            hint="median, start to finish"
          />
          <StatCard
            label="Last run"
            value={latest ? timeAgo(latest.startedAt) : "None yet"}
            hint={latest ? latest.status.replaceAll("-", " ") : "a push starts the first one"}
          />
        </div>
        {attention.length > 0 && (
          <p className="border border-danger/30 bg-surface px-4 py-3 text-xs text-muted">
            <span className="font-medium text-danger">
              {attention.length} {attention.length === 1 ? "run needs" : "runs need"} a closer look.
            </span>{" "}
            <Link
              href={projectHref(project.id, "activity")}
              className="focus-ring text-accent hover:underline"
            >
              Open activity
            </Link>{" "}
            to see what happened, or{" "}
            <Link
              href={projectHref(project.id, "logs")}
              className="focus-ring text-accent hover:underline"
            >
              read the role logs
            </Link>
            .
          </p>
        )}
      </section>

      <section aria-labelledby="project-recent" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="project-recent" className="text-lg font-semibold tracking-tight">
            Latest runs
          </h2>
          <Link
            href={projectHref(project.id, "activity")}
            className="focus-ring text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
          >
            View all
          </Link>
        </div>
        {runs === null ? (
          <ApiOffline />
        ) : (
          <RunTimeline
            runs={history.slice(0, 5)}
            runHref={(run) => projectRunHref(project.id, run.id)}
          />
        )}
      </section>

      <section aria-labelledby="project-setup" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="project-setup" className="text-lg font-semibold tracking-tight">
            Setup
          </h2>
          <Link
            href={projectHref(project.id, "settings")}
            className="focus-ring inline-flex items-center gap-1.5 text-xs text-muted hover:text-accent"
          >
            Change <LuArrowRight size={13} aria-hidden />
          </Link>
        </div>
        <dl className="grid gap-6 border border-rule bg-surface p-5 sm:grid-cols-2">
          <div>
            <dt className="flex items-center gap-2 text-xs text-muted">
              <LuGitBranch aria-hidden /> Watching
            </dt>
            <dd className="mt-2 break-all text-sm">{project.sourceRepo || "Not configured"}</dd>
          </div>
          <div>
            <dt className="flex items-center gap-2 text-xs text-muted">
              <LuBookOpen aria-hidden /> Writing docs to
            </dt>
            <dd className="mt-2 break-all text-sm">
              {project.docsRepo || project.sourceRepo || "Not configured"}
            </dd>
          </div>
        </dl>
      </section>
    </>
  );
}
