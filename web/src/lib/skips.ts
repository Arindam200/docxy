/**
 * Pushes docxy chose not to document, as the Activity page lists them.
 *
 * A push that starts no run used to leave no trace a reader could find: the
 * reason went to the server's log and to a live event nobody was watching at
 * push time. The API now keeps them, and this is the part of showing them that
 * involves no React - which kind of skip a row is, what triage said, and which
 * rows a run has since made out of date.
 *
 * No server imports, so the client button that starts a run can use it too.
 */

import type { RunSummary, SkipKind, SkippedCommit, StartProjectRunResult } from "./docxy";
import { lookup } from "./lookup";

/**
 * What each kind of skip is called on its badge.
 *
 * Short on purpose: the reason sentence beside it says the rest, in the API's
 * own words. The badge is for scanning a list for the ones that are not
 * triage, which are the ones somebody can do something about.
 */
const SKIP_LABELS = {
  triage: "Triage",
  allowance: "Allowance",
  "automatic-runs": "Automatic runs",
  access: "Access",
} satisfies Record<SkipKind, string>;

/**
 * A kind's badge text, including for a kind this dashboard has not heard of.
 *
 * Typed as a string rather than the union because the two halves deploy
 * separately, and a server that learns a fifth reason will send it to a
 * dashboard that still knows four - the `category: 'sandbox'` drift the
 * contract describes. The raw value is a better badge than a blank one.
 */
export function skipLabel(kind: string): string {
  return lookup(SKIP_LABELS, kind) ?? kind;
}

/**
 * How likely triage thought the commit was to need documentation, as the page
 * prints it. Undefined for every other kind, which triage never saw.
 *
 * Rounded the way `src/triage.ts` rounds it into the reason sentence, so the
 * figure on the row and the figure in the sentence beside it cannot differ.
 */
export function needsDocsPercent(skip: Pick<SkippedCommit, "kind" | "triage">): string | undefined {
  if (skip.kind !== "triage" || !skip.triage) return undefined;
  return `${Math.round(skip.triage.needsDocs * 100)}%`;
}

/**
 * The skips still worth showing, newest first, one per commit.
 *
 * A skip stops being news once the commit has a run - somebody pressed
 * "Document anyway", or ran it from the CLI - and that run is in the list above
 * this one, which is where its outcome is. Leaving the row up would be a
 * section headed "Not documented" listing a commit that is, beside a button
 * inviting a second run of it.
 *
 * One row per commit because the same push can be skipped twice: GitHub
 * redelivers a webhook it thinks failed, and triage answers it again. The
 * newest decision is the one that stands.
 */
export function undocumented(skipped: SkippedCommit[], runs: RunSummary[]): SkippedCommit[] {
  const ran = new Set(runs.map((run) => run.commit.sha));
  const seen = new Set<string>();
  return [...skipped]
    .sort((a, b) => b.at.localeCompare(a.at))
    .filter((skip) => {
      if (ran.has(skip.commit.sha) || seen.has(skip.commit.sha)) return false;
      seen.add(skip.commit.sha);
      return true;
    });
}

/**
 * What the toast says once a run has been asked for.
 *
 * "Queued" either way, because either way it is in hand. The position is
 * mentioned only when the run is actually waiting behind another: a run that
 * starts at once has no place in a queue to report, and one the API already
 * had in hand - the same commit asked for twice, while it runs - can come back
 * queued with nothing waiting, where "position 0" would be nonsense.
 */
export function queuedNotice(
  shortSha: string,
  result: Pick<StartProjectRunResult, "queued" | "depth">,
): string {
  if (!result.queued) return `Queued ${shortSha}. Its run is starting now.`;
  if (result.depth > 0) return `Queued ${shortSha}, position ${result.depth} in the queue.`;
  return `Queued ${shortSha}.`;
}
