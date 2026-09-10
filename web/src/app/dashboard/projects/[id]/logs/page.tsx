import Link from "next/link";
import { notFound } from "next/navigation";

import { fetchLogs } from "@/lib/docxy";
import { ROLE_ORDER, roleTitle } from "@/lib/format";
import { ApiOffline } from "@/components/dashboard/ApiOffline";
import { LogStream } from "@/components/dashboard/LogStream";
import { currentProject } from "@/lib/project-scope";
import { projectHref } from "@/lib/projects";

export const dynamic = "force-dynamic";

/**
 * Every role event this project's runs emitted, flattened into one stream.
 *
 * Filters stay links rather than client state: the server already has to narrow
 * the query - shipping every event to the browser to filter there would defeat
 * the limit that keeps this page cheap - so the URL is the filter, which also
 * makes a filtered view shareable.
 *
 * The project is a third narrowing alongside kind and role, and unlike them it
 * is not optional: it comes from the path, and the API refuses to reach past
 * the organization that owns it.
 */
export default async function ProjectLogsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ kind?: string; role?: string }>;
}) {
  const [{ id }, filters] = await Promise.all([params, searchParams]);
  const scope = await currentProject(id);
  if (scope.kind === "offline") return null;
  if (scope.kind === "missing") notFound();

  const { project, organizationId } = scope;
  const logs = await fetchLogs(organizationId, {
    kind: filters.kind,
    role: filters.role,
    projectId: project.id,
    limit: 300,
  });

  const online = logs !== null;
  const entries = logs?.entries ?? [];
  const errors = entries.filter((entry) => entry.level === "error").length;
  const base = projectHref(project.id, "logs");

  return (
    <>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Logs</h2>
          <p className="mt-1 text-sm text-muted">
            Every event the five agents emitted for this repository, newest first.
          </p>
        </div>
        <p className="text-xs text-muted tabular-nums">
          {entries.length} shown
          {logs && logs.total > entries.length ? ` of ${logs.total}` : ""}
          {errors > 0 && <span className="ml-2 text-danger">{errors} error</span>}
        </p>
      </div>

      {!online && <ApiOffline />}

      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <FilterRow
          label="kind"
          active={filters.kind}
          options={logs?.kinds ?? []}
          href={(value) => query(base, { role: filters.role, kind: value })}
        />
        <FilterRow
          label="role"
          active={filters.role}
          options={[...ROLE_ORDER]}
          format={roleTitle}
          href={(value) => query(base, { kind: filters.kind, role: value })}
        />
      </div>

      <LogStream entries={entries} />
    </>
  );
}

function query(base: string, params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  return search.size > 0 ? `${base}?${search.toString()}` : base;
}

function FilterRow({
  label,
  active,
  options,
  href,
  format = (value: string) => value,
}: {
  label: string;
  active: string | undefined;
  options: string[];
  href: (value: string | undefined) => string;
  format?: (value: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">
        {label}
      </span>

      <Chip href={href(undefined)} selected={!active}>
        all
      </Chip>
      {options.map((option) => (
        <Chip key={option} href={href(option)} selected={active === option}>
          {format(option)}
        </Chip>
      ))}
    </div>
  );
}

function Chip({
  href,
  selected,
  children,
}: {
  href: string;
  selected: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? "true" : undefined}
      className={`rounded border px-2 py-0.5 text-xs transition-colors ${
        selected
          ? "border-accent bg-surface-2 text-foreground"
          : "border-rule text-muted hover:border-accent hover:text-foreground"
      }`}
    >
      {children}
    </Link>
  );
}
