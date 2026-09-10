import { redirect } from "next/navigation";
import { fetchProjects, fetchRun } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";
import { projectRunHref } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * Moved under the project that produced the run.
 *
 * A run id used to be enough to address a run, which made the URL say nothing
 * about which repository it belonged to and left the sidebar with no project to
 * light up. The id still is enough to *find* one, though, so this resolves the
 * run's repository to a project and forwards - pull request comments, chat
 * links and browser history all still point here.
 *
 * Anything that cannot be resolved lands on the project list rather than on a
 * 404: the run may simply belong to another organization, and that is a fact
 * this page should not confirm.
 */
export default async function MovedRunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const organizationId = await activeOrganizationId();
  const [run, projects] = await Promise.all([
    fetchRun(id, organizationId),
    fetchProjects(organizationId),
  ]);

  const project = run
    ? projects?.projects.find((candidate) => candidate.key === run.repoPath)
    : undefined;

  redirect(project ? projectRunHref(project.id, id) : "/dashboard");
}
