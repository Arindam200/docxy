import { clockTime } from "@/lib/format";
import type { ValidationCheck } from "@/lib/docxy";

interface Props {
  checks: ValidationCheck[];
  events: Array<{ at: string; kind: string; text: string }> | undefined;
}

/**
 * What ran away from this machine, and what it did.
 *
 * The validation list already says a check ran in a sandbox. This says what the
 * sandbox was asked to do and what it answered, because "docs-build passed" is
 * a claim and the trail underneath it is the evidence — the difference between
 * a reviewer trusting the badge and a reviewer being able to check it.
 *
 * Renders nothing when every check ran locally: an empty panel headed "Sandbox"
 * on a run that never used one reads as a broken feature rather than an unused
 * one.
 */
export function SandboxTrail({ checks, events }: Props) {
  const sandboxed = checks.filter((check) => check.where === "sandbox");
  if (sandboxed.length === 0) return null;

  return (
    <section aria-labelledby="run-sandbox" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id="run-sandbox" className="text-lg font-semibold tracking-tight">
          Sandbox
        </h2>
        <p className="text-xs text-muted">
          {sandboxed.length === 1 ? "One check" : `${sandboxed.length} checks`} executed
          away from this machine
        </p>
      </div>

      <div className="border border-ok/30 bg-ok/5 px-4 py-3">
        <p className="text-xs leading-relaxed text-muted">
          {sandboxed.map((check) => check.name).join(", ")} ran over model-authored
          text inside an isolated sandbox, never against the repository checkout.
          A run with no sandbox falls back to local execution and says so on the
          check itself.
        </p>
      </div>

      {events && events.length > 0 ? (
        <ol className="border border-rule divide-y divide-rule bg-surface font-mono text-[11px]">
          {events.map((event, index) => (
            <li
              key={`${event.at}-${index}`}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2"
            >
              <time className="shrink-0 text-muted tabular-nums" dateTime={event.at}>
                {clockTime(event.at)}
              </time>
              <span
                className={`w-20 shrink-0 ${
                  event.kind === "sandbox" ? "text-ok" : "text-muted"
                }`}
              >
                {event.kind}
              </span>
              <span className="min-w-0 flex-1 break-words">{event.text}</span>
            </li>
          ))}
        </ol>
      ) : (
        // Runs recorded before the trail was persisted still show the badge, so
        // say why there is nothing under it rather than showing a bare gap.
        <p className="text-xs text-muted">
          No trail recorded for this run — validation events were not persisted
          when it ran.
        </p>
      )}
    </section>
  );
}
