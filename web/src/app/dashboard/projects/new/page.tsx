import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { Page, PageHead } from "@/components/dashboard/Page";
import { ConnectRepository } from "@/components/projects/ConnectRepository";
import { getActiveOrganizationId } from "@/lib/auth";
import { fetchProjects, fetchRepositories } from "@/lib/docxy";

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
  const organizationId = await getActiveOrganizationId(await headers());
  if (!organizationId) redirect("/onboarding");

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
      <PageHead
        title="Connect a repository"
        lede="One project documents one repository. Choose which, and say where its documentation lives."
      />
      {/* No organization passed down: the proxy establishes it from the
          session on every organization-scoped call, so a component prop would
          be a second source of truth that cannot be trusted anyway. */}
      <ConnectRepository repositories={available} connected={connected} initialSource={repo} />
    </Page>
  );
}
