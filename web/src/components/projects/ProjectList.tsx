"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { LuArrowRight, LuFolderOpen, LuSearch } from "react-icons/lu";
import { Select } from "@/components/dashboard/Select";
import { projectTitle } from "@/lib/projects";
import { ProjectCard, type ProjectSummary } from "./ProjectCard";

export function ProjectList({ entries, online }: { entries: ProjectSummary[]; online: boolean }) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("activity");
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter(({ project }) =>
      !needle || [project.name, project.sourceRepo].some((value) => value?.toLowerCase().includes(needle)),
    ).sort((a, b) => {
      const byName = projectTitle(a.project).localeCompare(projectTitle(b.project));
      if (sort === "name") return byName;
      if (sort === "name-desc") return -byName;
      return (b.stats.latest?.startedAt ?? "").localeCompare(a.stats.latest?.startedAt ?? "") || byName;
    });
  }, [entries, query, sort]);

  if (entries.length === 0) {
    return (
      <div className="border border-dashed border-rule bg-surface px-6 py-12 text-center">
        <LuFolderOpen size={24} aria-hidden className="mx-auto mb-4 text-accent" />
        <h2 className="font-semibold">Connect your first project</h2>
        <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-muted">Choose a repository to start keeping its documentation up to date.</p>
        <Link href="/dashboard/projects/new" className="focus-ring mt-5 inline-flex items-center gap-2 text-sm font-medium text-accent hover:underline">
          Connect a repository <LuArrowRight size={15} aria-hidden />
        </Link>
      </div>
    );
  }

  return (
    <section aria-label="All projects" className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative min-w-0 flex-1 basis-64">
          <span className="sr-only">Search projects</span>
          <LuSearch size={14} aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects or repositories…" spellCheck={false}
            className="focus-ring w-full border border-rule bg-surface py-2 pl-9 pr-3 text-sm text-foreground placeholder:text-muted" />
        </label>
        <Select label="Sort projects" value={sort} onChange={setSort} options={[
          { value: "activity", label: "Recent activity" },
          { value: "name", label: "Name: A to Z" },
          { value: "name-desc", label: "Name: Z to A" },
        ]} />
      </div>
      <p role="status" className="text-xs text-muted">
        {query.trim() ? `${matches.length} of ${entries.length} projects` : `${entries.length} ${entries.length === 1 ? "project" : "projects"}`}
      </p>
      {matches.length > 0 ? (
        <ul className="grid gap-4 lg:grid-cols-2">
          {matches.map(({ project, stats }) => (
            <li key={project.id} className="flex"><ProjectCard project={project} stats={stats} online={online} /></li>
          ))}
        </ul>
      ) : (
        <div className="border border-dashed border-rule px-6 py-12 text-center">
          <h2 className="font-semibold">No matching projects</h2>
          <p className="mt-2 text-sm text-muted">Try another project or repository name.</p>
          <button type="button" onClick={() => setQuery("")} className="focus-ring mt-4 text-sm font-medium text-accent hover:underline">Clear search</button>
        </div>
      )}
    </section>
  );
}
