"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  LuArrowUpRight,
  LuGitBranch,
  LuGitPullRequest,
  LuChevronLeft,
  LuChevronRight,
  LuSearch,
} from "react-icons/lu";

import type { RepositoriesPage, SyncedRepo } from "@contract";
import type { Project } from "@/lib/docxy";
import { projectHref, projectRunHref } from "@/lib/projects";
import { timeAgo } from "@/lib/format";
import { repositoryStatus, type RepositoryStatus } from "@/lib/repositories";
import { localDev } from "@/lib/runtime";
import { Select } from "./Select";

const LABEL = {
  monitored: "Monitored",
  available: "Not connected",
  excluded: "Excluded",
} satisfies Record<RepositoryStatus, string>;

const TONE = {
  monitored: "border-ok/30 bg-ok/10 text-ok",
  available: "border-rule bg-surface-2 text-muted",
  excluded: "border-danger/30 bg-danger/10 text-danger",
} satisfies Record<RepositoryStatus, string>;

/** The status filter, with "all" as its off position. */
const FILTERS = ["all", "monitored", "available", "excluded"] as const;
type Filter = (typeof FILTERS)[number];

/**
 * `Select` hands back a plain string, so the value is narrowed rather than
 * asserted: a filter option that is renamed here becomes "all" instead of a
 * state nothing in the table matches.
 */
function asFilter(value: string): Filter {
  return FILTERS.find((filter) => filter === value) ?? "all";
}

/**
 * Every repository the App can see, and which of them docxy actually watches.
 *
 * The unwatched ones are listed rather than hidden. Installing the App is
 * usually an "All repositories" grant, so most rows here are repositories
 * nobody asked to have documented - and a list that quietly dropped them would
 * leave somebody looking for a repository they know they granted access to,
 * with nothing on the page saying why it is missing or what to do about it.
 */
export function RepositoryList({ page, projects = [] }: { page: RepositoriesPage | null; projects?: Project[] }) {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Filter>("all");
  const [sort, setSort] = useState("watched");
  const [pageSize, setPageSize] = useState(10);
  const [pageIndex, setPageIndex] = useState(0);

  const repositories = useMemo(() => page?.repositories ?? [], [page]);
  const monitored = repositories.filter((repo) => repo.allowed).length;
  const excluded = repositories.filter((repo) => repositoryStatus(repo) === "excluded").length;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const found = repositories.filter(
      (repo) =>
        (!needle || repo.fullName.toLowerCase().includes(needle)) &&
        (status === "all" || repositoryStatus(repo) === status),
    );
    return [...found].sort((a, b) => {
      const byName = a.fullName.localeCompare(b.fullName);
      if (sort === "name-desc") return -byName;
      if (sort === "recent") return (b.lastRunAt ?? "").localeCompare(a.lastRunAt ?? "") || byName;
      if (sort === "runs") return b.runCount - a.runCount || byName;
      // The default. What docxy is doing comes before what it could do.
      if (sort === "watched") return Number(b.allowed) - Number(a.allowed) || byName;
      return byName;
    });
  }, [repositories, query, sort, status]);

  if (!page) {
    return (
      <Empty
        title="The docxy API is unreachable"
        body={
          localDev
            ? "Start it with `npm run serve`, then refresh."
            : "The list of installed repositories comes from the pipeline API, which did not answer. It fills in as soon as it does."
        }
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

  if (repositories.length === 0) {
    return (
      <Empty
        title="The App is not installed anywhere yet"
        body="Install the App on a repository to see it here."
        href="/api/github/install"
        action="Install on a repository"
      />
    );
  }

  const pageCount = Math.max(1, Math.ceil(matches.length / pageSize));
  const currentPage = Math.min(pageIndex, pageCount - 1);
  const start = currentPage * pageSize;
  const shown = matches.slice(start, start + pageSize);

  return (
    <section aria-label="Watched repositories" className="space-y-3">
      {/* The headline fact of this page. Access is not intent, and somebody who
          granted access to thirty repositories should be able to read off how
          many docxy is actually acting on. */}
      <p className="text-sm text-muted" aria-live="polite">
        <span className="font-medium text-foreground">
          {monitored} of {repositories.length}
        </span>{" "}
        {repositories.length === 1 ? "repository is" : "repositories are"} monitored. A push starts a
        run only where a project connects one.
      </p>

      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 w-full sm:w-72">
          <span className="sr-only">Search repositories</span>
          <LuSearch size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={query}
            onChange={(event) => { setQuery(event.target.value); setPageIndex(0); }}
            placeholder="Search repositories…"
            spellCheck={false}
            className="focus-ring w-full border border-rule bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted/60"
          />
        </label>
        <Select
          label="Filter by status"
          value={status}
          onChange={(value) => { setStatus(asFilter(value)); setPageIndex(0); }}
          options={[
            { value: "all", label: `All (${repositories.length})` },
            { value: "monitored", label: `Monitored (${monitored})` },
            { value: "available", label: `Not connected (${repositories.length - monitored - excluded})` },
            ...(excluded > 0 ? [{ value: "excluded", label: `Excluded (${excluded})` }] : []),
          ]}
        />
        <Select
          label="Sort repositories"
          value={sort}
          onChange={(value) => { setSort(value); setPageIndex(0); }}
          options={[
            { value: "watched", label: "Monitored first" },
            { value: "name-asc", label: "Name: A to Z" },
            { value: "name-desc", label: "Name: Z to A" },
            { value: "recent", label: "Last run" },
            { value: "runs", label: "Most runs" },
          ]}
        />
      </div>

      <div className="overflow-x-auto border border-rule bg-surface focus-ring" role="region" aria-label="Repository list" tabIndex={0}>
        <table className="w-full min-w-[720px] text-left text-sm">
          <caption className="sr-only">Repositories the GitHub App can see, and which of them docxy monitors</caption>
          <thead className="border-b border-rule bg-surface-2 text-xs text-muted">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">Repository</th>
              <th scope="col" className="px-4 py-3 font-medium">Status</th>
              <th scope="col" className="px-4 py-3 font-medium">Branch</th>
              <th scope="col" className="px-4 py-3 font-medium text-right">Runs</th>
              <th scope="col" className="px-4 py-3 font-medium">Last run</th>
              <th scope="col" className="px-4 py-3 font-medium text-right">Links</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {shown.map((repo) => <RepoRow key={repo.fullName} repo={repo} project={projects.find((project) => project.sourceRepo?.toLowerCase() === repo.fullName.toLowerCase())} />)}
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="px-4 py-10 text-center text-sm text-muted">
                  No repositories match this search.{" "}
                  <button type="button" onClick={() => { setQuery(""); setStatus("all"); setPageIndex(0); }} className="focus-ring text-accent underline underline-offset-4">Clear filters</button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-3 text-xs text-muted">
        <div className="flex items-center gap-2">
          Rows per page
          <Select
            label="Rows per page"
            value={String(pageSize)}
            onChange={(value) => { setPageSize(Number(value)); setPageIndex(0); }}
            options={[10, 25, 50].map((size) => ({ value: String(size), label: String(size) }))}
            compact
          />
        </div>
        <span className="tabular-nums" aria-live="polite">
          {matches.length === 0 ? 0 : start + 1}–{Math.min(start + pageSize, matches.length)} / {matches.length}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="Previous page"
            disabled={currentPage === 0}
            onClick={() => setPageIndex(currentPage - 1)}
            className="focus-ring border border-rule bg-surface p-1.5 transition-colors hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          ><LuChevronLeft size={14} aria-hidden /></button>
          <button
            type="button"
            aria-label="Next page"
            disabled={currentPage >= pageCount - 1}
            onClick={() => setPageIndex(currentPage + 1)}
            className="focus-ring border border-rule bg-surface p-1.5 transition-colors hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed"
          ><LuChevronRight size={14} aria-hidden /></button>
        </div>
      </div>

      {excluded > 0 && (
        <p className="text-xs leading-relaxed text-muted">
          {excluded} connected {excluded === 1 ? "repository is" : "repositories are"} excluded by{" "}
          <code className="font-mono text-foreground">DOCXY_ALLOWED_REPOS</code>, which lists{" "}
          {(page.envAllowlist ?? []).join(", ")}. Unset it to document every connected project.
        </p>
      )}

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

function RepoRow({ repo, project }: { repo: SyncedRepo; project?: Project }) {
  const [owner, name] = repo.fullName.split("/");
  const status = repositoryStatus(repo);

  return (
    <tr className="transition-colors hover:bg-surface-2">
      <th scope="row" className="px-4 py-3 font-medium">
        {project ? <Link href={projectHref(project.id)} className="focus-ring inline-flex items-center gap-2 hover:text-accent">
          <span className="break-all"><span className="text-muted">{owner}/</span>{name}</span>
        </Link> : <a href={repo.url} target="_blank" rel="noreferrer" className="focus-ring inline-flex items-center gap-2 hover:text-accent">
          <span className="break-all"><span className="text-muted">{owner}/</span>{name}</span>
          <LuArrowUpRight size={13} className="shrink-0 text-muted" aria-hidden />
          <span className="sr-only"> on GitHub</span>
        </a>}
      </th>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center whitespace-nowrap border px-2 py-0.5 text-xs ${TONE[status]}`}>
          {LABEL[status]}
        </span>
      </td>
      <td className="px-4 py-3 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><LuGitBranch size={13} aria-hidden /><span className="font-mono">{repo.defaultBranch}</span></span>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">{repo.runCount}</td>
      <td className="px-4 py-3 text-xs text-muted whitespace-nowrap">{repo.lastRunAt ? timeAgo(repo.lastRunAt) : "Never"}</td>
      <td className="px-4 py-3 text-right text-xs">
        <div className="flex items-center justify-end gap-4 whitespace-nowrap">
          <Link href={project ? projectHref(project.id) : `/dashboard/projects/new?repo=${encodeURIComponent(repo.fullName)}`} className="focus-ring font-medium text-accent hover:underline underline-offset-4">{project ? "Open project" : "Connect project"}</Link>
          {repo.lastPullRequestUrl && (
            <a href={repo.lastPullRequestUrl} target="_blank" rel="noreferrer" aria-label={`Latest pull request for ${repo.fullName}`} className="focus-ring inline-flex items-center gap-1.5 text-muted hover:text-accent">
              <LuGitPullRequest size={13} aria-hidden /> Pull request
            </a>
          )}
          {repo.lastRunId ? (
            <Link href={project ? projectRunHref(project.id, repo.lastRunId) : `/dashboard/runs/${repo.lastRunId}`} aria-label={`Latest run for ${repo.fullName}`} className="focus-ring inline-flex items-center border border-accent/25 bg-accent/10 px-2.5 py-1.5 font-medium text-accent transition-colors hover:border-accent/50 hover:bg-accent/20">Latest run</Link>
          ) : !repo.lastPullRequestUrl ? <span className="text-muted">No activity yet</span> : null}
        </div>
      </td>
    </tr>
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
