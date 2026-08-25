import Link from "next/link";
import type { LogEntry } from "@/lib/docxy";
import { clockTime, roleTitle } from "@/lib/format";

const KIND_CLASS: Record<string, string> = {
  error: "text-red-300",
  session: "text-accent",
  subagent: "text-amber-300",
  result: "text-emerald-300",
  approval: "text-amber-300",
  sandbox: "text-muted",
  resume: "text-muted",
  tool: "text-muted",
  mcp: "text-muted",
};

export function LogStream({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="border border-dashed border-rule px-6 py-12 text-center">
        <p className="text-sm text-muted">
          Nothing matches. Events are recorded per role as a run executes, so the
          stream fills once a run starts.
        </p>
      </div>
    );
  }

  return (
    <ol className="border border-rule divide-y divide-rule bg-surface font-mono text-[11px]">
      {entries.map((entry, index) => (
        <li
          key={`${entry.runId}-${entry.at}-${index}`}
          className={`flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 ${
            entry.level === "error" ? "bg-red-500/5" : ""
          }`}
        >
          <time className="w-20 shrink-0 tabular-nums text-muted">{clockTime(entry.at)}</time>

          <span className={`w-20 shrink-0 ${KIND_CLASS[entry.kind] ?? "text-muted"}`}>
            {entry.kind}
          </span>

          <span className="w-32 shrink-0 truncate text-muted" title={roleTitle(entry.role)}>
            {roleTitle(entry.role)}
          </span>

          <Link
            href={`/dashboard/runs/${entry.runId}`}
            className="w-16 shrink-0 text-accent hover:underline"
            title={entry.subject}
          >
            {entry.commit}
          </Link>

          <span className="min-w-0 flex-1 break-words leading-relaxed">{entry.text}</span>
        </li>
      ))}
    </ol>
  );
}
