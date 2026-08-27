import Link from "next/link";
import type { RunPoint } from "@/lib/docxy";
import { duration, timeAgo, tokens } from "@/lib/format";

/**
 * One bar per run, oldest to newest — the shape of the history rather than a
 * number for it. A role getting slower, or a week of failures, is visible here
 * and nowhere else.
 *
 * Deliberately not a charting library: the series is bounded by the window and
 * a div per run renders the same story at a fraction of the weight.
 */

const METRICS = {
  duration: { label: "Duration", value: (run: RunPoint) => run.durationMs ?? 0, format: duration },
  tokens: {
    label: "Tokens",
    value: (run: RunPoint) => run.inputTokens + run.outputTokens,
    format: tokens,
  },
} as const;

export function RunTrend({
  series,
  metric = "duration",
}: {
  series: RunPoint[];
  metric?: keyof typeof METRICS;
}) {
  const { label, value, format } = METRICS[metric];
  const peak = Math.max(1, ...series.map(value));

  return (
    <section aria-labelledby="run-trend" className="border border-rule bg-surface">
      <div className="flex items-baseline justify-between border-b border-rule px-4 py-3">
        <h2
          id="run-trend"
          className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted"
        >
          {label} per run
        </h2>
        <span className="text-xs text-muted">oldest → newest</span>
      </div>

      {series.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted">No runs in this window yet.</p>
      ) : (
        <div className="flex items-end gap-1 overflow-x-auto px-4 py-4" style={{ height: 148 }}>
          {series.map((run) => {
            const height = Math.max(2, (value(run) / peak) * 104);
            const failed = run.status === "failed" || run.status === "denied";
            return (
              <Link
                key={run.id}
                href={`/dashboard/runs/${run.id}`}
                title={`${run.shortSha} · ${run.subject}\n${format(value(run))} · ${timeAgo(run.startedAt)}`}
                className="group flex w-6 shrink-0 flex-col items-center justify-end gap-1"
              >
                <span
                  aria-hidden
                  style={{ height }}
                  className={`w-full transition-colors ${
                    failed ? "bg-danger/70 group-hover:bg-danger" : "bg-accent/60 group-hover:bg-accent"
                  }`}
                />
                <span className="font-mono text-[9px] text-muted">{run.shortSha.slice(0, 4)}</span>
                <span className="sr-only">
                  {run.subject}: {format(value(run))}, {run.status}
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </section>
  );
}
