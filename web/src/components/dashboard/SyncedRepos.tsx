import Link from "next/link";
import { LuArrowUpRight, LuCircleAlert, LuGitBranch, LuGitPullRequest } from "react-icons/lu";

import type { RepositoriesPage } from "@/lib/docxy";
import { timeAgo } from "@/lib/format";

/**
 * The repositories docxy is synced to.
 *
 * A repository is synced because the GitHub App is installed on it — that is
 * the thing a person did, and the thing that survives this server being
 * redeployed somewhere else. A checkout on the machine serving this page is
 * incidental: it is a cache of commits, created on the first webhook and
 * rebuilt whenever it is missing. Showing a local directory as the answer to
 * "what is synced?" was the older, wrong version of this panel — it named a
 * path nobody outside the process could act on, and it read as connected on a
 * machine where nothing was installed at all.
 */
export function SyncedRepos({ page }: { page: RepositoriesPage | null }) {
  if (!page) {
    return (
      <Empty
        title="The docxy API is unreachable"
        body="Start it with `npm run serve`, then refresh."
      />
    );
  }

  if (!page.configured) {
    return (
      <Empty
        title="No GitHub App configured"
        body={
          page.error ??
          "Docxy syncs a repository by being installed on it. Register the App and set its three variables to begin."
        }
        href="https://github.com/settings/apps"
        action="Register a GitHub App"
      />
    );
  }

  if (page.error) {
    return <Empty title="GitHub would not answer" body={page.error} />;
  }

  if (page.repositories.length === 0) {
    return (
      <Empty
        title="The App is not installed anywhere yet"
        body="Install it on a repository and it appears here — no path to configure, nothing to keep in step by hand."
        href="https://github.com/settings/installations"
        action="Install on a repository"
      />
    );
  }

  return (
    <section aria-labelledby="synced-repos" className="space-y-3">
      <div className="flex items-baseline justify-between gap-4">
        <h2
          id="synced-repos"
          className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
        >
          Synced repositories
        </h2>
        <p className="text-xs text-muted">
          {page.repositories.length} installed &middot; every push to the default branch starts a run
        </p>
      </div>

      <div className="grid grid-cols-1 gap-px border border-rule bg-rule lg:grid-cols-2">
        {page.repositories.map((repo) => {
          const [owner, name] = repo.fullName.split("/");
          return (
            <article key={repo.fullName} className="bg-surface p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold tracking-tight">
                    <span className="text-muted">{owner}/</span>
                    {name}
                  </h3>
                  <p className="mt-1 inline-flex items-center gap-1.5 text-xs text-muted">
                    <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
                      <LuGitBranch />
                    </span>
                    <span className="font-mono">{repo.defaultBranch}</span>
                  </p>
                </div>

                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-ok">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-ok" />
                  Synced
                </span>
              </div>

              <dl className="mt-4 flex flex-wrap items-baseline gap-x-6 gap-y-1.5 text-xs">
                <div className="flex items-baseline gap-2">
                  <dt className="text-muted">Runs</dt>
                  <dd className="tabular-nums">{repo.runCount}</dd>
                </div>
                <div className="flex items-baseline gap-2">
                  <dt className="text-muted">Last run</dt>
                  <dd className="tabular-nums">
                    {repo.lastRunAt ? timeAgo(repo.lastRunAt) : "Never"}
                  </dd>
                </div>
                {!repo.hasCheckout && (
                  <div className="flex items-baseline gap-1.5 text-muted">
                    <span aria-hidden className="translate-y-px [&>svg]:h-3 [&>svg]:w-3">
                      <LuCircleAlert />
                    </span>
                    <dd>Commits are fetched on the first push</dd>
                  </div>
                )}
              </dl>

              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-rule pt-3 text-xs">
                <a
                  href={repo.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
                >
                  Open on GitHub
                  <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
                    <LuArrowUpRight />
                  </span>
                </a>

                {repo.lastPullRequestUrl && (
                  <a
                    href={repo.lastPullRequestUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
                  >
                    <span aria-hidden className="[&>svg]:h-3 [&>svg]:w-3">
                      <LuGitPullRequest />
                    </span>
                    Latest pull request
                  </a>
                )}

                {repo.lastRunId && (
                  <Link
                    href={`/dashboard/runs/${repo.lastRunId}`}
                    className="ml-auto text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
                  >
                    Latest run
                  </Link>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {page.pinned && (
        <p className="text-xs leading-relaxed text-muted">
          <code className="font-mono text-foreground">DOCXY_REPO_PATH</code> is set, so runs read
          from <code className="font-mono text-foreground">{page.localRepoPath}</code> instead of
          the checkout docxy manages. Unset it to document whichever repository a push arrives from.
        </p>
      )}
    </section>
  );
}

function Empty({
  title,
  body,
  href,
  action,
}: {
  title: string;
  body: string;
  href?: string;
  action?: string;
}) {
  return (
    <section className="border border-rule bg-surface px-5 py-6">
      <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
      <p className="mt-2 max-w-prose text-sm leading-relaxed text-muted">{body}</p>
      {href && action && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-flex items-center gap-1.5 text-sm text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
        >
          {action}
          <span aria-hidden className="[&>svg]:h-3.5 [&>svg]:w-3.5">
            <LuArrowUpRight />
          </span>
        </a>
      )}
    </section>
  );
}
