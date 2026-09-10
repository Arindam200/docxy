import { notFound } from "next/navigation";
import { LuArrowUpRight } from "react-icons/lu";
import { Page, PageHead } from "@/components/dashboard/Page";
import { ApiOffline } from "@/components/dashboard/ApiOffline";
import { currentProject } from "@/lib/project-scope";
import { projectTitle } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * Everything a project's five sections have in common.
 *
 * The header lives here rather than on each page because it is the same header
 * on all of them - the project's name is not a fact about Activity or about
 * Logs - and because resolving the project is what decides whether any of them
 * should render at all. Doing that once means a 404 that cannot disagree with
 * itself between the layout and the page it wraps.
 *
 * `currentProject` is cached for the request, so the page below re-asking for
 * the same project costs nothing.
 */
export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await currentProject(id);

  // Unreachable is not the same as gone. Telling somebody their project does
  // not exist because the pipeline is restarting would be a lie they would act
  // on, so the offline state says what is actually true.
  if (scope.kind === "offline") {
    return (
      <Page>
        <PageHead title="Project unavailable" />
        <ApiOffline />
      </Page>
    );
  }
  if (scope.kind === "missing") notFound();

  const { project } = scope;
  const source = project.sourceRepo;

  return (
    <Page>
      <PageHead title={projectTitle(project)} lede={source || "Connected repository"}>
        {source && (
          <a
            href={`https://github.com/${source}`}
            target="_blank"
            rel="noreferrer"
            className="focus-ring inline-flex shrink-0 items-center gap-2 border border-accent-deep bg-accent-deep px-3 py-2 text-xs font-medium text-white transition-colors hover:bg-accent-deep/85"
          >
            View repository <LuArrowUpRight aria-hidden />
          </a>
        )}
      </PageHead>
      {children}
    </Page>
  );
}
