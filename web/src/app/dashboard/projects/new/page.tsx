import Link from "next/link";
import { LuArrowLeft } from "react-icons/lu";

import { Page, PageHead } from "@/components/dashboard/Page";
import { ConnectRepository } from "@/components/projects/ConnectRepository";
import { fetchProjects, fetchRepositories } from "@/lib/docxy";
import { activeOrganizationId } from "@/lib/organization";

export const dynamic = "force-dynamic";

/**
 * Connecting a repository is its own page because it is its own decision.
 *
 * Installing the GitHub App grants access to a set of repositories; it does not
 * say which of them anybody wants documented. Creating a project is where that
 * is answered, one repository at a time.
 */
export default async function NewProjectPage({ searchParams }: { searchParams: Promise<{ repo?: string }> }) {
  const { repo } = await searchParams;
  // Membership-checked, and a redirect to onboarding when there is none - the
  // same answer this page used to reach by hand from the session alone.
  const organizationId = await activeOrganizationId();

  const [repositories, projects] = await Promise.all([
    fetchRepositories(organizationId),
    fetchProjects(organizationId),
  ]);

  const available = (repositories?.repositories ?? []).map((repo) => repo.fullName);
  // Sources only. A documentation repository can serve several projects, so it
  // is never "taken".
  const connected = (projects?.projects ?? [])
    .map((project) => project.sourceRepo)
    .filter((repo): repo is string => Boolean(repo));

  return (
    <Page>
      <Link href="/dashboard/repositories" className="focus-ring inline-flex items-center gap-2 text-xs text-muted hover:text-accent"><LuArrowLeft aria-hidden /> Repositories</Link>
      <PageHead
        title="Connect a repository"
        lede="One project documents one repository. Choose which, and say where its documentation lives."
      />
      {/* The organization passed down is not the tenant - the proxy still takes
          that from the session on every organization-scoped call. It is what
          this page was rendered for, sent back so that a tab left open across
          an organization switch is refused instead of connecting the
          repository somewhere it was never listed. */}
      <ConnectRepository
        organizationId={organizationId}
        repositories={available}
        connected={connected}
        initialSource={repo}
      />
    </Page>
  );
}
