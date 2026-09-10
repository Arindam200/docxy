import Link from "next/link";
import { notFound } from "next/navigation";
import { LuBookOpen, LuGitBranch } from "react-icons/lu";
import { fetchRepositories } from "@/lib/docxy";
import { currentProject } from "@/lib/project-scope";

export const dynamic = "force-dynamic";

/**
 * How this project is wired: what it watches, where it writes, and what starts
 * a run.
 *
 * This is the block that used to sit under the project's activity behind an
 * anchor link. It is a section of its own now because it answers a different
 * question from the rest of the project - what did I configure, rather than
 * what happened - and because an anchor is not a place you can navigate back
 * to.
 */
export default async function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const scope = await currentProject(id);
  if (scope.kind === "offline") return null;
  if (scope.kind === "missing") notFound();

  const { project, organizationId } = scope;
  const repositories = await fetchRepositories(organizationId);
  const repository = repositories?.repositories.find(
    (repo) => repo.fullName.toLowerCase() === project.sourceRepo?.toLowerCase(),
  );
  const source = project.sourceRepo;
  const docs = project.docsRepo || source;

  return (
    <>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Documentation setup</h2>
        <p className="mt-1 text-sm text-muted">
          What this project watches, where its documentation lives, and what starts a run.
        </p>
      </div>

      <dl className="grid gap-6 border border-rule bg-surface p-5 sm:grid-cols-2">
        <div>
          <dt className="flex items-center gap-2 text-xs text-muted">
            <LuGitBranch aria-hidden /> Source repository
          </dt>
          <dd className="mt-2 break-all text-sm">{source || "Not configured"}</dd>
        </div>
        <div>
          <dt className="flex items-center gap-2 text-xs text-muted">
            <LuBookOpen aria-hidden /> Documentation repository
          </dt>
          <dd className="mt-2 break-all text-sm">
            {docs ? (
              <a
                href={`https://github.com/${docs}`}
                target="_blank"
                rel="noreferrer"
                className="focus-ring text-accent hover:underline"
              >
                {docs} ↗
              </a>
            ) : (
              "Not configured"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Documentation paths</dt>
          <dd className="mt-2 break-all font-mono text-sm">
            {project.docsRoots || "Automatically detected"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Run trigger</dt>
          <dd className="mt-2 text-sm">
            {repository?.allowed === false ? (
              <span className="text-danger">
                Paused. The GitHub App can see {source}, but this deployment excludes it.
              </span>
            ) : (
              <>Push to {repository?.defaultBranch || "the default branch"}</>
            )}
          </dd>
        </div>
      </dl>

      <p className="text-xs text-muted">
        This project watches one repository, and only this repository. Other repositories the
        GitHub App can reach are untouched until somebody connects them too.{" "}
        <Link href="/dashboard/repositories" className="focus-ring text-accent hover:underline">
          See every repository the App can reach
        </Link>
        .
      </p>
      <p className="text-xs text-muted">
        Writing instructions currently apply to every project in your organization.{" "}
        <Link href="/dashboard/settings#instructions" className="focus-ring text-accent hover:underline">
          Manage organization instructions
        </Link>
      </p>
    </>
  );
}
