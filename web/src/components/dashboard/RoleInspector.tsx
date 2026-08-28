"use client";

import { useState } from "react";
import type { RoleFailure, RoleTrace } from "@/lib/docxy";
import { clockTime, duration, roleTitle } from "@/lib/format";
import { lookup } from "@/lib/lookup";

/**
 * One role, in full: what it was asked, what came back, what the pipeline made
 * of it, and the event timeline.
 *
 * The failure rules from guides/OBSERVABILITY.md §5 live here. The important one
 * is that an error string is never shown on its own — `max_tokens breached` has
 * as often meant a repetition loop as a budget that was too small, and only the
 * raw output tells the two apart. So a failed role opens on Raw output, not on
 * the error.
 */

type Tab = "prompt" | "raw" | "parsed" | "events";

const FAILURE_HELP = {
  "harness-error":
    "The harness ended the turn in an error state. Read the raw output before the message — it usually explains what the message does not.",
  "parse-error":
    "The response was not the JSON the pipeline expected, almost always prose wrapped around it or a truncated reply. The raw output shows which.",
  timeout: "The role did not answer in time. Whatever it had produced is below.",
  aborted: "The run was cancelled while this role was working.",
  "max-tokens":
    "The model spent its whole output budget without finishing. Retried on a fresh session — a session carrying many commits is the usual cause — and still could not finish.",
  context:
    "The prompt no longer fits the model's context window. The session was retired and rebuilt, and it still did not fit.",
  "rate-limit": "The provider rate-limited every attempt. Nothing is wrong with the proposal; try again shortly.",
  cancelled: "The harness cancelled the turn before it finished, usually a server-side execution timeout.",
  stalled:
    "The turn kept pausing for approvals or questions without ever settling on an answer. Nobody is attached to a pipeline run, so it was answered automatically and still did not converge.",
} satisfies Record<RoleFailure, string>;

export function RoleInspector({
  traces,
  parsed,
}: {
  traces: RoleTrace[];
  parsed: Partial<Record<string, unknown>>;
}) {
  // Open on whatever failed; that is what someone came to look at.
  const initial = traces.findIndex((trace) => trace.status === "failed");
  const [selected, setSelected] = useState(initial === -1 ? 0 : initial);

  const trace = traces[selected];
  if (!trace) return null;

  return (
    <div className="border border-rule bg-surface">
      <div
        role="tablist"
        aria-label="Roles"
        className="flex flex-wrap gap-1 border-b border-rule p-2"
      >
        {traces.map((item, index) => (
          <button
            key={`${item.role}-${item.startedAt}`}
            role="tab"
            type="button"
            aria-selected={index === selected}
            onClick={() => setSelected(index)}
            className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
              index === selected
                ? "bg-surface-2 text-foreground"
                : "text-muted hover:text-foreground"
            }`}
          >
            <span
              aria-hidden
              className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                item.status === "failed"
                  ? "bg-danger"
                  : item.status === "running"
                    ? "bg-accent"
                    : "bg-ok"
              }`}
            />
            {roleTitle(item.role)}
          </button>
        ))}
      </div>

      <RolePanel trace={trace} parsed={parsed[trace.role]} />
    </div>
  );
}

function RolePanel({ trace, parsed }: { trace: RoleTrace; parsed: unknown }) {
  const [tab, setTab] = useState<Tab>(trace.status === "failed" ? "raw" : "parsed");

  return (
    <div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 border-b border-rule px-4 py-3 text-xs sm:grid-cols-4">
        <Field label="status">
          <span
            className={
              trace.status === "failed"
                ? "text-danger"
                : trace.status === "running"
                  ? "text-accent"
                  : "text-ok"
            }
          >
            {trace.status}
            {trace.failure ? ` · ${trace.failure}` : ""}
          </span>
        </Field>
        <Field label="duration">{duration(trace.durationMs)}</Field>
        <Field label="model">
          <span className="font-mono text-[11px]">{trace.model ?? "—"}</span>
        </Field>
        <Field label="session">
          <span className="font-mono text-[11px]" title={trace.sessionId}>
            {trace.sessionId.slice(0, 10)}…{trace.reusedSession ? " (reused)" : ""}
          </span>
        </Field>
      </dl>

      {trace.status === "failed" && (
        <div role="alert" className="border-b border-rule bg-danger/5 px-4 py-3">
          <p className="text-xs font-medium text-danger">
            {trace.error ?? "This role failed without a message."}
          </p>
          {trace.failure && (
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              {FAILURE_HELP[trace.failure]}
            </p>
          )}
        </div>
      )}

      <div role="tablist" aria-label="Role detail" className="flex gap-1 border-b border-rule p-2">
        {(
          [
            ["prompt", "Prompt"],
            ["raw", "Raw output"],
            ["parsed", "Parsed"],
            ["events", `Events (${trace.events.length})`],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              tab === value ? "bg-surface-2 text-foreground" : "text-muted hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="p-4">
        {tab === "prompt" && <Body text={trace.prompt} missing="No prompt was recorded for this role." />}
        {tab === "raw" && (
          <Body text={trace.rawOutput} missing="No raw output was recorded for this role." />
        )}
        {tab === "parsed" && (
          <Body
            text={parsed === undefined ? undefined : JSON.stringify(parsed, null, 2)}
            missing="Nothing was parsed — this role did not produce usable output."
          />
        )}
        {tab === "events" && <Events trace={trace} />}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] font-semibold uppercase tracking-[0.08em] text-muted">{label}</dt>
      <dd className="mt-0.5">{children}</dd>
    </div>
  );
}

function Body({ text, missing }: { text: string | undefined; missing: string }) {
  if (!text) return <p className="text-xs leading-relaxed text-muted">{missing}</p>;

  return (
    <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap break-words rounded bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
      {text}
    </pre>
  );
}

const KIND_CLASS = {
  error: "text-danger",
  session: "text-accent",
  tool: "text-muted",
  subagent: "text-warn",
  result: "text-ok",
} satisfies Record<string, string>;

function Events({ trace }: { trace: RoleTrace }) {
  if (trace.events.length === 0) {
    return <p className="text-xs text-muted">No events were recorded.</p>;
  }

  return (
    <ol className="max-h-[28rem] space-y-1.5 overflow-auto">
      {trace.events.map((event, index) => (
        <li key={`${event.at}-${index}`} className="flex gap-3 text-[11px]">
          <time className="w-20 shrink-0 tabular-nums text-muted">{clockTime(event.at)}</time>
          <span className={`w-20 shrink-0 font-mono ${lookup(KIND_CLASS, event.kind) ?? "text-muted"}`}>
            {event.kind}
          </span>
          <span className="min-w-0 flex-1 break-words leading-relaxed">{event.text}</span>
        </li>
      ))}
    </ol>
  );
}
