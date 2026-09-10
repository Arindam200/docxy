import type { DocsProposal } from '../types.js';
import type { ApplyResult } from './apply.js';
import { applyDocEdits } from './apply.js';
import { readRepoFile } from '../git/repo.js';
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
  const brokenPaths = new Set(broken.map((p) => p.path));
  const toRepair = docs.edits.filter((e) => brokenPaths.has(e.path) && e.mode !== 'append');
  if (toRepair.length === 0) return { docs, applied };

  const excerpts: string[] = [];
  for (const path of brokenPaths) {
    const text = await readRepoFile(docsPath, path);
    if (text === null) continue;
    excerpts.push(`===== FILE: ${path} (complete) =====\n${text}`);
  }
  // Nothing readable to re-anchor against. The originals stand.
  if (excerpts.length === 0) return { docs, applied };

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
    ...broken.map((p) => `- ${p.path}: ${p.detail}`),
    '',
    '## The files, in full, as they are now',
    '',
    ...excerpts,
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

  let repaired: DocsProposal;
  try {
    repaired = await ctx.invoke(DOCS_UPDATER, prompt);
  } catch {
    // The repair is a bonus pass. Its failure must not take down a run that
    // already has a proposal, however partial.
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
      ...(repaired.edits ?? []),
    ],
    skipped: [...(docs.skipped ?? []), ...(repaired.skipped ?? [])],
  };

  const reapplied = await applyDocEdits(docsPath, merged);
  const stillBroken = reapplied.problems.filter((p) => REPAIRABLE.has(p.kind)).length;

  // Only kept if it is actually better. A second pass that anchors fewer edits
  // than the first has made the proposal worse, and the run should publish the
  // one that worked.
  const before = applied.files.reduce((n, f) => n + f.appliedEdits, 0);
  const after = reapplied.files.reduce((n, f) => n + f.appliedEdits, 0);
  if (after <= before) {
    return { docs, applied, attempted: { broken: broken.length, fixed: 0 } };
  }

  return {
    docs: merged,
    applied: reapplied,
    attempted: { broken: broken.length, fixed: Math.max(0, broken.length - stillBroken) },
  };
}
