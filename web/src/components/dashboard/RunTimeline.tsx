import type { RunSummary } from "@/lib/docxy";

const STATUS_STYLES: Record<RunSummary["status"], string> = {
  running: "text-accent",
  "awaiting-approval": "text-amber-300",
  approved: "text-emerald-300",
  done: "text-emerald-300",
  denied: "text-red-300",
  failed: "text-red-300",
};

export function StatusChip({ status }: { status: RunSummary["status"] }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap text-xs font-medium ${STATUS_STYLES[status]}`}
    >
      <span
        aria-hidden
        className={`h-1.5 w-1.5 rounded-full ${STATUS_STYLES[status].replace("text-", "bg-")}`}
      />
      {status.replace("-", " ")}
    </span>
  );
}

export function RunTimeline({ runs }: { runs: RunSummary[] }) {
  if (runs.length === 0) {
    return (
      <div className="border border-dashed border-rule px-6 py-12 text-center">
        <p className="text-sm text-muted">
          No runs recorded yet. Push a commit or start one from the CLI with{" "}
          <code className="font-mono text-foreground">docxy run</code>.
        </p>
      </div>
    );
  }

  return (
    <ol className="border border-rule divide-y divide-rule bg-surface overflow-hidden">
      {runs.map((run) => (
        <li
          key={run.id}
          className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-surface-2 transition-colors"
        >
          <code className="font-mono text-xs text-accent">{run.commit.shortSha}</code>
          <span className="min-w-0 flex-1 truncate text-sm">{run.commit.subject}</span>
          <StatusChip status={run.status} />
          {run.pullRequestUrl && (
            <a
              href={run.pullRequestUrl}
              target="_blank"
              rel="noreferrer"
              className="text-xs text-muted underline decoration-rule underline-offset-4 hover:text-accent hover:decoration-accent"
            >
              PR ↗
            </a>
          )}
          <time className="text-xs tabular-nums text-muted whitespace-nowrap">
            {new Date(run.startedAt).toLocaleString(undefined, {
              month: "short",
              day: "numeric",
              hour: "numeric",
              minute: "2-digit",
            })}
          </time>
        </li>
      ))}
    </ol>
  );
}
