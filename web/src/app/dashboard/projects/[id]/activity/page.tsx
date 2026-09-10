import { notFound } from "next/navigation";
import { fetchRuns } from "@/lib/docxy";
import { RunTimeline } from "@/components/dashboard/RunTimeline";
import { LiveUpdates } from "@/components/dashboard/LiveUpdates";
import { currentProject } from "@/lib/project-scope";
import { projectRunHref } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * Every run for this repository, newest first.
 *
 * It was an organization-wide page until this scope existed, which meant one
 * list of every project's runs mixed together and a repository column to read
 * past. Narrowing happens in the API rather than here: the listing is capped,
 * so filtering a shared list in the browser would drop a quiet project's runs
 * as soon as a busier one filled the cap.
 */
export default async function ProjectActivityPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await currentProject(id);
  if (scope.kind === "offline") return null;
  if (scope.kind === "missing") notFound();

  const { project, organizationId } = scope;
  const runs = await fetchRuns(organizationId, project.id);
  const list = runs ?? [];

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
          <LiveUpdates />
          <span className="text-xs text-muted tabular-nums">{list.length} runs</span>
        </div>
      </div>
      <RunTimeline runs={list} runHref={(run) => projectRunHref(project.id, run.id)} />
    </>
  );
}
