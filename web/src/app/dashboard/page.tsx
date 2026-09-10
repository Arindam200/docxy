import Link from "next/link";
import { LuArrowRight, LuCircleAlert, LuPlus } from "react-icons/lu";
import {
  fetchIntegrations,
  fetchObservability,
  fetchProjects,
  fetchRepositories,
  fetchRuns,
  type Project,
  type RunSummary,
} from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";
import { duration, timeAgo, tokens } from "@/lib/format";
import { projectHref, projectRunHref, projectRuns, projectTitle, rollUp } from "@/lib/projects";
import { ApiOffline } from "@/components/dashboard/ApiOffline";
import { Page, PageHead } from "@/components/dashboard/Page";
import { StatCard } from "@/components/dashboard/StatCard";
import { RunTimeline } from "@/components/dashboard/RunTimeline";
import { QuickActions } from "@/components/dashboard/Capabilities";
import { GithubNotice } from "@/components/dashboard/GithubNotice";
import { ProjectCard } from "@/components/projects/ProjectCard";
import { LiveUpdates } from "@/components/dashboard/LiveUpdates";

export const dynamic = "force-dynamic";

function usd(value: number | undefined): string {
  if (value === undefined) return "N/A";
  return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

function percent(value: number | undefined): string {
  return value === undefined ? "N/A" : `${Math.round(value * 100)}%`;
}

/** Organization totals, a two-project preview, and recent activity. */
export default async function OrganizationPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; github?: string }>;
}) {
  const notice = await searchParams;
  const organizationId = await activeOrganizationId();
  const [result, runs, report, integrations, repositories] = await Promise.all([
    fetchProjects(organizationId),
    // One organization-wide listing rather than one request per project. It
    // feeds the activity list and, through `rollUp`, every project's own
    // figures - a report per project would be N requests to draw one grid.
    fetchRuns(organizationId),
    // No `projectId`, so this is the whole organization: the same aggregate a
    // project's Insights page shows, computed over every repository at once.
    fetchObservability(organizationId),
    fetchIntegrations(),
    fetchRepositories(organizationId),
  ]);

  const online = runs !== null;
  const projects = result?.projects ?? [];
  const list = [...(runs ?? [])].sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  const blocking = (integrations?.integrations ?? []).filter(
    (item) => item.required && !item.connected,
  );
  const reachable = repositories && !repositories.error
    ? repositories.repositories.length
    : undefined;

  // Each project's own numbers, from the one listing above, newest activity
  // first so a project that just ran is the one at the top.
  const summaries = projects
    .map((project) => ({ project, stats: rollUp(projectRuns(project, list)) }))
    .sort((a, b) =>
      (b.stats.latest?.startedAt ?? "").localeCompare(a.stats.latest?.startedAt ?? "") ||
      projectTitle(a.project).localeCompare(projectTitle(b.project)),
    );

  const troubled = summaries.filter((entry) => entry.stats.needsAttention > 0);
  const attentionTotal = troubled.reduce((sum, entry) => sum + entry.stats.needsAttention, 0);

  // Which project a run belongs to, for a list that spans all of them. Keyed by
  // the exact checkout path, the same key `projectRuns` narrows on.
  const byPath = new Map<string, Project>(projects.map((project) => [project.key, project]));
  const runProject = (run: RunSummary) => byPath.get(run.repoPath);

  const totalTokens = report ? report.totals.inputTokens + report.totals.outputTokens : undefined;

  const metrics = [
    {
      label: "Projects",
      value: result ? projects.length : "N/A",
      hint:
        reachable === undefined
          ? "repositories kept documented"
          : `of ${reachable} ${reachable === 1 ? "repository" : "repositories"} the App can reach`,
    },
    {
      label: "Runs",
      value: report?.window.runs ?? "N/A",
      hint: report?.window.from ? `since ${timeAgo(report.window.from)}` : "in this window",
    },
    {
      label: "Success rate",
      value: percent(report?.successRate),
      hint: report ? `${report.outcomes.failed ?? 0} failed` : "analytics unavailable",
      accent: report?.successRate !== undefined && report.successRate < 0.8,
    },
    {
      label: "Typical run",
      value: duration(report?.totals.medianRunMs),
      hint: "median, start to finish",
    },
    {
      label: "Doc edits drafted",
      value: report?.documentation?.edits ?? "N/A",
      hint: report?.documentation
        ? `across ${report.documentation.documents} document${report.documentation.documents === 1 ? "" : "s"}`
        : "draft counts unavailable",
    },
    {
      label: "Release notes",
      value: report?.documentation?.releaseNotes ?? "N/A",
      hint: "changelog entries prepared for review",
    },
    {
      label: "Spend",
      value: usd(report?.totals.costUsd),
      hint:
        report?.totals.costPerRunUsd === undefined
          ? "no model rates available"
          : `${usd(report.totals.costPerRunUsd)} per run`,
    },
    {
      label: "Tokens",
      value: totalTokens === undefined ? "N/A" : tokens(totalTokens),
      hint: report
        ? `${tokens(report.totals.cacheReadTokens)} read from cache`
        : "usage unavailable",
    },
  ];

  return (
    <Page>
      <PageHead
        title="Overview"
        lede="Documentation activity and results across your organization."
      >
        <div className="flex items-center gap-4">
          <LiveUpdates />
          <Link
            href="/dashboard/projects/new"
            className="focus-ring inline-flex shrink-0 items-center gap-2 border border-accent-deep bg-accent-deep px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-deep/85"
          >
            <LuPlus aria-hidden /> Connect a repository
          </Link>
        </div>
      </PageHead>

      <GithubNotice error={notice.error} github={notice.github} />

      {!online && <ApiOffline />}

      {/*
        The one organization-wide problem worth interrupting for: a service
        every project depends on has stopped answering, so none of them will
        finish a run.
      */}
      {blocking.length > 0 && (
        <div
          role="alert"
          className="flex flex-col gap-4 border border-danger/30 bg-surface p-5 sm:flex-row sm:items-center"
        >
          <span className="hidden h-9 w-9 shrink-0 items-center justify-center border border-rule bg-surface-2 text-danger sm:flex">
            <LuCircleAlert size={17} aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-medium">Restore your connections</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted">
              {blocking.map((item) => item.name).join(" and ")}{" "}
              {blocking.length === 1 ? "is" : "are"} disconnected. Documentation updates cannot
              complete until {blocking.length === 1 ? "it is" : "they are"} reconnected.
            </p>
          </div>
          <Link
            href="/dashboard/settings"
            className="focus-ring inline-flex shrink-0 items-center gap-2 self-start border border-rule bg-surface-2 px-3 py-2 text-xs font-medium transition-colors hover:border-accent hover:text-accent sm:self-auto"
          >
            View settings <LuArrowRight size={13} aria-hidden />
          </Link>
        </div>
      )}

      <section aria-labelledby="org-metrics" className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="org-metrics" className="text-lg font-semibold tracking-tight">
            Across all projects
          </h2>
          <span className="text-xs text-muted">
            {report ? `Latest ${report.window.runs} runs · up to 50` : "Analytics unavailable"}
          </span>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y divide-rule border border-rule bg-surface md:grid-cols-4">
          {metrics.map((card) => (
            <StatCard key={card.label} {...card} />
          ))}
        </div>
      </section>

      {/*
        Which projects the failures are in, named. The totals above can only say
        that something is wrong somewhere, and "somewhere" across a dozen
        repositories is not something anybody can act on.
      */}
      {troubled.length > 0 && (
        <p className="border border-danger/30 bg-surface px-4 py-3 text-xs leading-relaxed text-muted">
          <span className="font-medium text-danger">
            {attentionTotal} {attentionTotal === 1 ? "run needs" : "runs need"} a closer look
          </span>{" "}
          in{" "}
          {troubled.map((entry, index) => (
            <span key={entry.project.id}>
              {index > 0 && (index === troubled.length - 1 ? " and " : ", ")}
              <Link
                href={projectHref(entry.project.id, "activity")}
                className="focus-ring text-accent hover:underline"
              >
                {projectTitle(entry.project)}
              </Link>
            </span>
          ))}
          .
        </p>
      )}

      <section aria-labelledby="org-projects" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="org-projects" className="text-lg font-semibold tracking-tight">Recent projects</h2>
          <Link href="/dashboard/projects" className="focus-ring inline-flex items-center gap-1.5 text-xs font-medium text-accent hover:underline">
            View all projects{result ? ` (${projects.length})` : ""} <LuArrowRight size={13} aria-hidden />
          </Link>
        </div>

        {!result ? (
          <ApiOffline />
        ) : projects.length === 0 ? (
          <div className="border border-dashed border-rule p-10 text-center">
            <h3 className="font-semibold">Connect your first project</h3>
            <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">
              Installing the GitHub App grants access; connecting one repository as a project is
              what starts documentation updates on each push.
            </p>
            <Link
              href="/dashboard/projects/new"
              className="focus-ring mt-5 inline-flex items-center gap-2 text-sm font-medium text-accent"
            >
              Connect a repository <LuArrowRight aria-hidden />
            </Link>
          </div>
        ) : (
          <ul className="grid gap-4 lg:grid-cols-2">
            {summaries.slice(0, 2).map(({ project, stats }) => (
              <li key={project.id} className="flex">
                <ProjectCard project={project} stats={stats} online={online} />
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-muted">
          A project watches one repository, and only that one.{" "}
          <Link href="/dashboard/repositories" className="focus-ring text-accent hover:underline">
            See every repository the GitHub App can reach
          </Link>{" "}
          - the ones without a project are untouched.
        </p>
      </section>

      <QuickActions />

      <section aria-labelledby="org-activity" className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h2 id="org-activity" className="text-lg font-semibold tracking-tight">
            Latest activity
          </h2>
          <span className="text-xs text-muted tabular-nums">{list.length} runs</span>
        </div>
        {!online ? (
          <p className="border border-rule bg-surface px-5 py-6 text-sm text-muted">
            Activity will appear when the connection is restored.
          </p>
        ) : (
          <RunTimeline
            runs={list.slice(0, 8)}
            projectName={(run) => {
              const project = runProject(run);
              return project ? projectTitle(project) : undefined;
            }}
            // A run whose project has since been disconnected still has a page.
            // The old flat route resolves it and forwards, so the row stays a
            // working link rather than going inert.
            runHref={(run) => {
              const project = runProject(run);
              return project
                ? projectRunHref(project.id, run.id)
                : `/dashboard/runs/${encodeURIComponent(run.id)}`;
            }}
          />
        )}
        {list.length > 8 && (
          <p className="text-xs text-muted">
            Showing the 8 most recent. Open a project for its full history.
          </p>
        )}
      </section>
    </Page>
  );
}
