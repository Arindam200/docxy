import Link from "next/link";
import { fetchLogs } from "@/lib/docxy";
import { ROLE_ORDER, roleTitle } from "@/lib/format";
import { Page, PageHead } from "@/components/dashboard/Page";
import { LogStream } from "@/components/dashboard/LogStream";

export const dynamic = "force-dynamic";

/**
 * Every role event across recent runs, flattened into one stream.
 *
 * Filters are links rather than client state: the server already has to narrow
 * the query — shipping every event to the browser to filter there would defeat
 * the limit that keeps this page cheap — so the URL is the filter, which also
 * makes a filtered view shareable.
 */
export default async function LogsPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string; role?: string }>;
}) {
  const params = await searchParams;
  const logs = await fetchLogs({ kind: params.kind, role: params.role, limit: 300 });

  const online = logs !== null;
  const entries = logs?.entries ?? [];
  const errors = entries.filter((entry) => entry.level === "error").length;

  return (
    <Page>
      <PageHead
        title="Logs"
        lede="Every event the five agents emitted, newest first, across recent runs."
      >
        <p className="text-xs text-muted tabular-nums">
          {entries.length} shown
          {logs && logs.total > entries.length ? ` of ${logs.total}` : ""}
          {errors > 0 && <span className="ml-2 text-red-300">{errors} error</span>}
        </p>
      </PageHead>

      {!online && (
        <div
          role="alert"
          className="border border-rule bg-surface px-4 py-3 text-sm leading-relaxed text-muted"
        >
          The docxy API is unreachable right now. Start it with{" "}
          <code className="font-mono text-foreground">npm run serve</code> and refresh.
        </div>
      )}

      <div className="flex flex-wrap gap-x-6 gap-y-3">
        <FilterRow
          label="kind"
          active={params.kind}
          options={logs?.kinds ?? []}
          href={(value) => query({ role: params.role, kind: value })}
        />
        <FilterRow
          label="role"
          active={params.role}
          options={[...ROLE_ORDER]}
          format={roleTitle}
          href={(value) => query({ kind: params.kind, role: value })}
        />
      </div>

      <LogStream entries={entries} />
    </Page>
  );
}

function query(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  return search.size > 0 ? `/dashboard/logs?${search.toString()}` : "/dashboard/logs";
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
