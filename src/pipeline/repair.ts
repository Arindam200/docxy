import type { DocsProposal } from '../types.js';
import type { ApplyResult } from './apply.js';
import { applyDocEdits } from './apply.js';
import { readDocExcerpts } from '../git/repo.js';
import { DOCS_UPDATER } from '../agents/roles.js';
import type { RunContext } from './context.js';

/**
 * Ask the Docs Updater to re-anchor the edits that did not apply.
 *
 * An anchor that does not match the file byte for byte is thrown away, and a
 * proposal whose edits do not apply is rejected - so a single mis-quoted `find`
 * can cost the whole run. Three causes have been found and fixed upstream of
 * here: an excerpt budget too small to show the model the files it was asked to
 * quote, a diff whose deleted lines looked like quotable anchors, and a thread
 * holding older copies of those same files.
 *
 * What is left is the model paraphrasing. Measured across this repository's
 * runs, none of it is whitespace drift - a normalising re-anchor in code would
 * fix nothing - and it clusters in documents full of sample terminal output,
 * where a model will regenerate a transcript with plausible different numbers
 * rather than copy the one in front of it.
 *
 * That has to be answered by asking again, so this is one extra model call. It
 * is bounded to be worth making: only the edits that failed, only the files
 * those edits touch, and only once. A repair that fails leaves the proposal
 * exactly as it was.
 */

export interface RepairOutcome {
  /** The proposal to use, repaired or original. */
  docs: DocsProposal;
  /** The result of applying it. */
  applied: ApplyResult;
  /** Absent when nothing needed repairing. */
  attempted?: {
    /** Edits that failed to anchor on the first pass. */
    broken: number;
    /** How many of them the second pass fixed. */
    fixed: number;
  };
}

/** Problems a second look can actually do something about. */
const REPAIRABLE = new Set(['anchor-not-found', 'anchor-ambiguous']);

export async function repairAnchors(
  ctx: RunContext,
  docsPath: string,
  docs: DocsProposal,
  applied: ApplyResult,
  /** The same scope the first pass was applied under; see `applyDocEdits`. */
  editable?: ReadonlySet<string>,
): Promise<RepairOutcome> {
  const broken = applied.problems.filter((p) => REPAIRABLE.has(p.kind));
  if (broken.length === 0) return { docs, applied };

  /**
   * Which edits to ask about again.
   *
   * A problem names a file, not an edit, so every edit targeting a file that
   * had an anchor problem is re-asked. That over-asks slightly when one of two
   * edits to a file applied cleanly - and re-asking about an edit that worked
   * is far cheaper than leaving one that did not.
   */
  /*
   * The files are shown under the same budget the first pass used.
   *
   * They used to go in whole, which is exactly what the first pass's budget
   * exists to prevent: an anchor that failed in a generated reference page of
   * a few megabytes sent all of it, and a context-length retry sent it again.
   * A file the budget leaves out entirely is not asked about - an anchor cannot
   * be copied from text the model is not shown.
   */
  const shown = await readDocExcerpts(docsPath, [...new Set(broken.map((p) => p.path))]);
  const unseen = new Set([...shown.missing, ...shown.omitted]);
  const brokenPaths = new Set(broken.map((p) => p.path).filter((path) => !unseen.has(path)));
  const toRepair = docs.edits.filter((e) => brokenPaths.has(e.path) && e.mode !== 'append');
  // Nothing readable to re-anchor against, or nothing to re-anchor. The originals stand.
  if (toRepair.length === 0 || !shown.text) return { docs, applied };

  const prompt = [
    'Your previous edits did not apply. Re-anchor them.',
    '',
    '## What went wrong',
    '',
    'Each `find` below was searched for in the file and not found exactly once.',
    'This is not a judgement about whether the edit was a good idea - the change',
    'you proposed may well be right. The text you quoted to locate it was not in',
    'the file.',
    '',
    ...broken.filter((p) => brokenPaths.has(p.path)).map((p) => `- ${p.path}: ${p.detail}`),
    '',
    '## The files as they are now (whole unless marked as cut)',
    '',
    shown.text,
    '',
    '## The edits to re-anchor',
    '',
    JSON.stringify(toRepair, null, 2),
    '',
    '## What to do',
    '',
    'Return the same edits with `find` replaced by text copied from the files',
    'above. Copy it - do not retype it, and do not regenerate sample output with',
    'different values. Most failures here are transcripts and command examples',
    'where a plausible-looking substitution was made for the literal text.',
    '',
    'Keep `replace` as it was unless the corrected anchor forces a change. If an',
    'edit cannot be anchored in the text above, drop it and list the file under',
    '`skipped` with the reason - a proposal that applies is worth more than one',
    'that is complete.',
  ].join('\n');

  /**
   * The repair runs in the Docs Updater's own trace - one trace per role per
   * run - so it replaces what that trace says the role was asked and answered,
   * and a repair that fails marks the role failed. That is only true when the
   * repair is what the run keeps. When it is not, the proposal that stands came
   * from the first pass, and the trace is put back to say so. Usage and events
   * stay: the repair was really spent and really happened.
   */
  const trace = ctx.run.traces.find((t) => t.role === DOCS_UPDATER.name);
  const firstPass = trace ? { ...trace } : null;
  const keepFirstPass = async (): Promise<void> => {
    if (!trace || !firstPass) return;
    for (const key of ['status', 'error', 'failure', 'finishedAt', 'prompt', 'rawOutput'] as const) {
      if (firstPass[key] === undefined) delete trace[key];
      else Object.assign(trace, { [key]: firstPass[key] });
    }
    await ctx.persist();
  };

  let repaired: DocsProposal;
  try {
    repaired = await ctx.invoke(DOCS_UPDATER, prompt);
  } catch {
    // The repair is a bonus pass. Its failure must not take down a run that
    // already has a proposal, however partial.
    await keepFirstPass();
    return { docs, applied, attempted: { broken: broken.length, fixed: 0 } };
  }

  /**
   * The repaired edits, plus the ones that were never in question.
   *
   * Edits to untouched files are kept as they were: they applied, and re-asking
   * produced no opinion about them.
   */
  const merged: DocsProposal = {
    edits: [
      ...docs.edits.filter((e) => !brokenPaths.has(e.path)),
      // Only for the files it was asked about. An edit to any other file would
      // sit beside that file's original edits and apply twice.
      ...(repaired.edits ?? []).filter((e) => brokenPaths.has(e.path)),
    ],
    skipped: [...(docs.skipped ?? []), ...(repaired.skipped ?? [])],
  };

  // Under the first pass's scope: the repaired edits are a second model answer,
  // and nothing about being a repair makes its paths more trustworthy.
  const reapplied = await applyDocEdits(docsPath, merged, editable);
  const stillBroken = reapplied.problems.filter((p) => REPAIRABLE.has(p.kind)).length;

  // Only kept if it is actually better. A second pass that anchors fewer edits
  // than the first has made the proposal worse, and the run should publish the
  // one that worked.
  const before = applied.files.reduce((n, f) => n + f.appliedEdits, 0);
  const after = reapplied.files.reduce((n, f) => n + f.appliedEdits, 0);
  if (after <= before) {
    await keepFirstPass();
    return { docs, applied, attempted: { broken: broken.length, fixed: 0 } };
  }

  return {
    docs: merged,
    applied: reapplied,
    attempted: { broken: broken.length, fixed: Math.max(0, broken.length - stillBroken) },
  };
}
