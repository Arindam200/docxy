import Link from "next/link";
import type { RunSummary } from "@/lib/docxy";
import { dateTime, duration, roleTitle, tokens } from "@/lib/format";
import { RoleDots } from "@/components/dashboard/RoleDots";

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
      {runs.map((run) => {
        const failed = run.roles?.find((role) => role.status === "failed");

        return (
          <li key={run.id}>
            <Link
              href={`/dashboard/runs/${run.id}`}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 hover:bg-surface-2 transition-colors"
            >
              <code className="font-mono text-xs text-accent">{run.commit.shortSha}</code>

              <span className="min-w-0 flex-1 truncate text-sm">
                {run.commit.subject}
                {/* The role that stopped the run is the first thing worth
                    reading on a failure, so it sits with the subject rather
                    than being buried in the detail view. */}
                {failed && (
                  <span className="ml-2 text-xs text-red-300">{roleTitle(failed.role)} failed</span>
                )}
              </span>

              <RoleDots roles={run.roles} />
              <StatusChip status={run.status} />

              <span className="w-14 text-right text-xs tabular-nums text-muted">
                {duration(run.durationMs)}
              </span>
              <span
                className="w-14 text-right text-xs tabular-nums text-muted"
                title={
                  run.totals
                    ? `${run.totals.inputTokens} in / ${run.totals.outputTokens} out`
                    : "No usage recorded"
                }
              >
                {tokens((run.totals?.inputTokens ?? 0) + (run.totals?.outputTokens ?? 0))}
              </span>

              <span className="w-10 text-right text-xs text-muted">
                {run.pullRequestUrl ? "PR" : "—"}
              </span>

              <time className="w-28 text-right text-xs tabular-nums text-muted whitespace-nowrap">
                {dateTime(run.startedAt)}
              </time>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
