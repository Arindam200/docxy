import type { RoleTrace } from "@/lib/docxy";
import { duration, roleTitle } from "@/lib/format";

/**
 * The five roles as a waterfall rather than a list.
 *
 * Two of them — Docs Updater and Changelog Author — run at the same time, and a
 * flat list hides that. Offsetting each bar by when it actually started is what
 * explains why the wall-clock time is shorter than the sum of the parts.
 */

const BAR_CLASS: Record<RoleTrace["status"], string> = {
  running: "bg-accent",
  done: "bg-ok/70",
  failed: "bg-danger/70",
};

export function Waterfall({ traces }: { traces: RoleTrace[] }) {
  if (traces.length === 0) return null;

  const starts = traces.map((trace) => new Date(trace.startedAt).getTime());
  const ends = traces.map((trace) =>
    trace.finishedAt ? new Date(trace.finishedAt).getTime() : Date.now(),
  );

  const origin = Math.min(...starts);
  // Guard the divisor: a run whose roles all started and ended inside the same
  // millisecond would otherwise divide by zero and render nothing.
  const span = Math.max(1, Math.max(...ends) - origin);

  return (
    <div className="border border-rule bg-surface">
      <ol className="divide-y divide-rule">
        {traces.map((trace, index) => {
          const start = starts[index] ?? origin;
          const end = ends[index] ?? origin;
          const offset = ((start - origin) / span) * 100;
          // A role that finished almost instantly still needs a visible bar.
          const width = Math.max(1.5, ((end - start) / span) * 100);

          return (
            <li key={`${trace.role}-${trace.startedAt}`} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-36 shrink-0 truncate text-xs font-medium">
                {roleTitle(trace.role)}
              </span>

              <span className="relative h-2 flex-1 rounded-sm bg-surface-2">
                <span
                  className={`absolute inset-y-0 rounded-sm ${BAR_CLASS[trace.status]}`}
                  style={{ left: `${offset}%`, width: `${Math.min(width, 100 - offset)}%` }}
                />
              </span>

              <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted">
                {duration(trace.durationMs)}
              </span>
              <span
                className="w-16 shrink-0 text-right text-[11px] text-muted"
                title={trace.reusedSession ? "Reused an earlier session" : "New session"}
              >
                {trace.reusedSession ? "reused" : "new"}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="flex items-center justify-between border-t border-rule px-4 py-1.5 text-[10px] tabular-nums text-muted">
        <span>0:00</span>
        <span>{duration(span)}</span>
      </div>
    </div>
  );
}
