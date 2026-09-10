import Link from "next/link";
import { LuPlus } from "react-icons/lu";
import { fetchProjects, fetchRuns } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";
import { projectRuns, rollUp } from "@/lib/projects";
import { Page, PageHead } from "@/components/dashboard/Page";
import { ApiOffline } from "@/components/dashboard/ApiOffline";
import { ProjectList } from "@/components/projects/ProjectList";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const organizationId = await activeOrganizationId();
  const [result, runs] = await Promise.all([
    fetchProjects(organizationId),
    fetchRuns(organizationId),
  ]);
  const summaries = (result?.projects ?? []).map((project) => ({
    project: { id: project.id, name: project.name, sourceRepo: project.sourceRepo },
    stats: rollUp(projectRuns(project, runs ?? [])),
  }));

  return (
    <Page>
      <PageHead title="Projects" lede="All your documentation projects, in one place.">
        <Link href="/dashboard/projects/new" className="focus-ring inline-flex shrink-0 items-center gap-2 border border-accent-deep bg-accent-deep px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-deep/85">
          <LuPlus aria-hidden /> Connect a repository
        </Link>
      </PageHead>
      {!result ? <ApiOffline /> : (
        <>
          {runs === null && result.projects.length > 0 && <ApiOffline detail="project activity is unavailable" />}
          <ProjectList entries={summaries} online={runs !== null} key={organizationId} />
        </>
      )}
    </Page>
  );
}
