import { notFound } from "next/navigation";
import { fetchRuns, fetchSkippedCommits } from "@/lib/docxy";
import { RunTimeline } from "@/components/dashboard/RunTimeline";
import { LiveUpdates } from "@/components/dashboard/LiveUpdates";
import { SkippedCommits } from "@/components/projects/SkippedCommits";
import { activeOrganizationId } from "@/lib/organization";
import { currentProject } from "@/lib/project-scope";
import { projectRunHref } from "@/lib/projects";
import { undocumented } from "@/lib/skips";

export const dynamic = "force-dynamic";

/**
 * Every run for this repository, newest first, and the pushes that got none.
 *
 * It was an organization-wide page until this scope existed, which meant one
 * list of every project's runs mixed together and a repository column to read
 * past. Narrowing happens in the API rather than here: the listing is capped,
 * so filtering a shared list in the browser would drop a quiet project's runs
 * as soon as a busier one filled the cap.
 *
 * The skipped pushes are the other half of "what happened to my commit". A
 * push that triage judged not worth a run, or that the plan did not cover,
 * used to simply not appear here, which reads exactly like a push docxy never
 * heard about.
 */
export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // Started beside the project lookup rather than after it - see "Reads beside
  // the lookup" in lib/project-scope.ts for why that leaves nothing exposed.
  const organizationId = await activeOrganizationId();
  const [scope, runs, skips] = await Promise.all([
    currentProject(id),
    fetchRuns(organizationId, id),
    fetchSkippedCommits(organizationId, id),
  ]);
  if (scope.kind === "offline") return null;
  if (scope.kind === "missing") notFound();

  const { project } = scope;
  const list = runs ?? [];
  const skipped = undocumented(skips?.skipped ?? [], list);

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Activity</h2>
          <p className="mt-1 text-sm text-muted">
            Every run for this repository. Open one to inspect its agents, validation, and pull
            request.
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Scoped to this project: another repository's run changes nothing here. */}
          <LiveUpdates
            repoPath={project.key}
            repository={project.sourceRepo ?? undefined}
            running={list.some((run) => run.status === "running")}
          />
          <span className="text-xs text-muted tabular-nums">{list.length} runs</span>
        </div>
      </div>
      <RunTimeline runs={list} runHref={(run) => projectRunHref(project.id, run.id)} />
      <SkippedCommits skipped={skipped} organizationId={organizationId} projectId={project.id} />
    </>
  );
}
