import type { SkipKind, SkippedCommit } from "@/lib/docxy";
import { dateTime } from "@/lib/format";
import { lookup } from "@/lib/lookup";
import { needsDocsPercent, skipLabel } from "@/lib/skips";
import { DocumentAnyway } from "./DocumentAnyway";

/**
 * Badge colours by kind, quietest first.
 *
 * Triage is docxy working as intended and reads as neutral. The plan not
 * including runs on push is a fact about the plan rather than a fault. A spent
 * allowance is a warning, because it lifts on its own at the next period; a
 * billing hold is the one that will not, and reads as one.
 */
const NEUTRAL = "border-rule bg-surface-2 text-muted";
const TONES = {
  triage: NEUTRAL,
  "automatic-runs": "border-accent/30 bg-accent/10 text-accent",
  allowance: "border-warn/30 bg-warn/10 text-warn",
  access: "border-danger/30 bg-danger/10 text-danger",
} satisfies Record<SkipKind, string>;

/**
 * Pushes this project received and did not document, each with a way to.
 *
 * Renders nothing when there are none, and the caller passes none when the API
 * could not say - see `fetchSkippedCommits`. Most projects most of the time
 * have nothing here, and a heading over an empty list would be a section about
 * nothing.
 *
 * The rows are not links, unlike the run list above them: there is no record
 * to open, only the decision and its reason, and the row's one action is its
 * button.
 */
export function SkippedCommits({
  skipped,
  organizationId,
  projectId,
}: {
  skipped: SkippedCommit[];
  /** The organization this page was rendered for, for the writes it offers. */
  organizationId: string;
  projectId: string;
}) {
  if (skipped.length === 0) return null;

  return (
    <section aria-labelledby="not-documented" className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <div>
          <h2 id="not-documented" className="text-lg font-semibold tracking-tight">
            Not documented
          </h2>
          <p className="mt-1 text-sm text-muted">
            Pushes that did not start a run, and why. Document one anyway to run it now.
          </p>
        </div>
        <span className="text-xs text-muted tabular-nums">
          {skipped.length} {skipped.length === 1 ? "push" : "pushes"}
        </span>
      </div>

      <ol className="border border-rule divide-y divide-rule bg-surface">
        {skipped.map((skip) => {
          const percent = needsDocsPercent(skip);
          return (
            <li key={skip.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
              <code className="font-mono text-xs text-accent">{skip.commit.shortSha}</code>

              <div className="min-w-0 flex-1 basis-60">
                <p className="truncate text-sm" title={skip.commit.subject}>
                  {skip.commit.subject}
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">{skip.reason}</p>
              </div>

              <span
                className={`inline-flex shrink-0 items-center border px-1.5 py-0.5 text-[10px] font-semibold ${
                  lookup(TONES, skip.kind) ?? NEUTRAL
                }`}
              >
                {skipLabel(skip.kind)}
              </span>

              {/* Repeats the number in the reason sentence, but in a column, so
                  a list of triage skips can be read down for the near misses. */}
              {percent && (
                <span className="whitespace-nowrap text-xs tabular-nums text-muted">
                  needs docs {percent}
                </span>
              )}

              <time
                dateTime={skip.at}
                className="w-28 text-right text-xs tabular-nums text-muted whitespace-nowrap"
              >
                {dateTime(skip.at)}
              </time>

              <DocumentAnyway
                organizationId={organizationId}
                projectId={projectId}
                commit={skip.commit.sha}
                shortSha={skip.commit.shortSha}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
