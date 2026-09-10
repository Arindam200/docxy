import Link from "next/link";
import { LuArrowLeft, LuPlus } from "react-icons/lu";

import { fetchProjects, fetchRepositories, fetchRuns } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";
import { ApiOffline } from "@/components/dashboard/ApiOffline";
import { Page, PageHead } from "@/components/dashboard/Page";
import { RepositoryList } from "@/components/dashboard/RepositoryList";
import { GithubNotice } from "@/components/dashboard/GithubNotice";

export const dynamic = "force-dynamic";

/**
 * The repositories docxy documents, and nothing else.
 *
 * Installing the App is an access grant, and choosing *All repositories* is how
 * most people install one. It is not a request to document all of them: only
 * the repositories connected to a project are watched, and this page is where
 * the difference is visible.
 *
 * This page used to be "Synced", and carried the pipeline's machinery too - the
 * model per role, the storage backend, the platform services. None of that is a
 * repository, and none of it is what somebody opens this page to find: they
 * came to see which repositories are watched, or to find one among many. Those
 * panels moved to Integrations, which is where "what is docxy wired up to?"
 * already lives.
 */
export default async function RepositoriesPage({ searchParams }: {
  searchParams: Promise<{ error?: string; github?: string }>;
}) {
  const notice = await searchParams;
  const organizationId = await activeOrganizationId();
  const [runs, repositories, projects] = await Promise.all([
    fetchRuns(organizationId),
    fetchRepositories(organizationId),
    fetchProjects(organizationId),
  ]);
  const online = runs !== null;

  return (
    <Page>
      {/* Reached from Integrations and from the GitHub install callback rather
          than from the sidebar: this is the menu you connect a project from,
          not somewhere to end up. */}
      <Link
        href="/dashboard/integrations"
        className="focus-ring inline-flex items-center gap-2 text-xs text-muted hover:text-accent"
      >
        <LuArrowLeft aria-hidden /> Integrations
      </Link>
      <PageHead
        title="Repositories"
        lede="Every repository the GitHub App can see. Connect one to a project, and a push to its default branch starts a run."
      >
        {/* Installing the App grants access; connecting a repository is the
            separate, deliberate step that makes one a project. */}
        <Link
          href="/dashboard/projects/new"
          className="focus-ring inline-flex shrink-0 items-center gap-1.5 border border-accent-deep bg-accent-deep px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-deep/85"
        >
          <LuPlus size={13} aria-hidden />
          Connect a repository
        </Link>
      </PageHead>

      <GithubNotice error={notice.error} github={notice.github} />
      {!online && <ApiOffline />}

      <RepositoryList page={repositories} projects={projects?.projects ?? []} />
    </Page>
  );
}
