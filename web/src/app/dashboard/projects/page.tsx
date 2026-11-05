import Link from "next/link";
import { LuPlus } from "react-icons/lu";
import { fetchProjectRollups, fetchProjects, fetchRuns } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";
import { projectStats } from "@/lib/projects";
import { Page, PageHead } from "@/components/dashboard/Page";
import { ApiOffline } from "@/components/dashboard/ApiOffline";
import { ProjectList } from "@/components/projects/ProjectList";

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const organizationId = await activeOrganizationId();
  const [result, rollups] = await Promise.all([
    fetchProjects(organizationId),
    fetchProjectRollups(organizationId),
  ]);
  // The organization-wide listing, asked for only when the rollups did not
  // come back - a backend from before they existed, mid-deploy - because it is
  // then the only thing the cards can be drawn from. Not asked for when the
  // project list failed as well: that is the API down, and a second request
  // would wait out a second timeout to learn the same thing.
  const runs = rollups === null && result !== null ? await fetchRuns(organizationId) : null;
  const online = rollups !== null || runs !== null;
  // Trimmed to what a card shows before it crosses into the client component,
  // which has no use for checkout paths.
  const summaries = projectStats(result?.projects ?? [], rollups, runs ?? []).map(
    ({ project, stats }) => ({
      project: { id: project.id, name: project.name, sourceRepo: project.sourceRepo },
      stats,
    }),
  );

  return (
    <Page>
      <PageHead title="Projects" lede="All your documentation projects, in one place.">
        <Link href="/dashboard/projects/new" className="focus-ring inline-flex shrink-0 items-center gap-2 border border-accent-deep bg-accent-deep px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-deep/85">
          <LuPlus aria-hidden /> Connect a repository
        </Link>
      </PageHead>
      {!result ? <ApiOffline /> : (
        <>
          {!online && result.projects.length > 0 && <ApiOffline detail="project activity is unavailable" />}
          <ProjectList entries={summaries} online={online} key={organizationId} />
        </>
      )}
    </Page>
  );
}
