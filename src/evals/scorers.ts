import { createScorer } from '@mastra/core/evals';
import { z } from 'zod';
import type { RunRecord } from '../types.js';

/**
 * What "good" means for this pipeline, as numbers.
 *
 * These replace the confidence gate rather than postponing it. The gate was to
 * be a score the model assigned itself at run time, and the phase 0 spike
 * showed why that does not work: asked the same question twice about the same
 * diff, the model answered `public-api` and then `config`, reporting 0.92 and
 * 0.98 confidence - most confident on the run it got wrong. A number a model
 * grades itself on measures how the model feels, not whether the documentation
 * is right.
 *
 * Every scorer below is deterministic and reads only what a run already
 * recorded. No model is asked anything, so a score is reproducible, free, and
 * means the same thing in June as it did in March - which is the whole point of
 * having one. They answer the question the confidence gate was reaching for,
 * offline and honestly: did editing that prompt make the output worse?
 */

const runSchema = z.custom<RunRecord>();
const scorerType = { input: runSchema, output: runSchema } as const;

/** Proportion, with an empty set scoring 1 - nothing proposed is nothing wrong. */
function ratio(good: number, total: number): number {
  return total === 0 ? 1 : good / total;
}

/**
 * Did the edits the Docs Updater proposed actually apply?
 *
 * The metric this repository has spent the most on. An anchor that does not
 * match the file byte for byte is thrown away and the whole proposal is
 * rejected, and two separate causes have been found and fixed by watching this
 * number: an excerpt budget too small to show the model the files it was asked
 * to quote, and a diff whose deleted lines looked like quotable anchors.
 */
export const anchorResolution = createScorer({
  id: 'anchor-resolution',
  description: 'Fraction of proposed documentation edits that applied cleanly.',
  type: scorerType,
}).generateScore(({ run }) => {
  const edits = run.output.docs?.edits ?? [];
  if (edits.length === 0) return 1;

  // Only the files the Docs Updater proposed edits to. A run's proposed files
  // also include the changelog, which is spliced in rather than anchored and
  // would otherwise count a successful edit against a role that never made one.
  const targeted = new Set(edits.map((e) => e.path));
  const applied = (run.output.proposedFiles ?? [])
    .filter((f) => targeted.has(f.path))
    .reduce((sum, f) => sum + f.appliedEdits, 0);

  return ratio(Math.min(applied, edits.length), edits.length);
});

/**
 * Did the Docs Updater stay inside the map it was given?
 *
 * An edit to a file the Impact Mapper never flagged is the Coordinator's first
 * listed reason to reject a proposal. It is also the shape a prompt-injection
 * success would take - a file nobody asked to be touched, being touched.
 */
export const stayedInScope = createScorer({
  id: 'stayed-in-scope',
  description: 'Fraction of proposed edits whose file the impact map actually flagged.',
  type: scorerType,
}).generateScore(({ run }) => {
  const flagged = new Set((run.output.impact?.docs ?? []).map((d) => d.path));
  const edits = run.output.docs?.edits ?? [];
  return ratio(edits.filter((e) => flagged.has(e.path)).length, edits.length);
});

/**
 * Does the release the pipeline proposes match the change it classified?
 *
 * Binary, and the one inconsistency that reaches users as a broken upgrade
 * rather than as a bad sentence: a breaking change published under a patch bump.
 */
export const semverAgreement = createScorer({
  id: 'semver-agreement',
  description: 'Whether a breaking classification produced a major version bump.',
  type: scorerType,
}).generateScore(({ run }) => {
  const kind = run.output.classification?.kind;
  const bump = run.output.changelog?.semverBump;
  // Not applicable is not a failure. A run with no changelog has nothing to
  // disagree with, and scoring it zero would drag the average on the strength
  // of a role that was never asked.
  if (kind !== 'breaking' || !bump) return 1;
  return bump === 'major' ? 1 : 0;
});

/**
 * How much of validation passed.
 *
 * Skipped checks count as neither. A docs build nobody configured is not a
 * failure, and treating it as one would make every unconfigured deployment
 * look broken; a docs build that could not run *is* reported as a failure by
 * validation itself, and lands here as one.
 */
export const validationClean = createScorer({
  id: 'validation-clean',
  description: 'Fraction of validation checks that ran and passed.',
  type: scorerType,
}).generateScore(({ run }) => {
  const checks = (run.output.validation?.checks ?? []).filter((c) => c.status !== 'skipped');
  return ratio(checks.filter((c) => c.status === 'pass').length, checks.length);
});

/**
 * Did the run produce anything at all?
 *
 * A pipeline that reliably proposes nothing is cheap and useless, and every
 * other score here reads perfectly while it does. This is the one that catches
 * that: it is the denominator the others are quietly dividing by.
 */
export const producedAProposal = createScorer({
  id: 'produced-a-proposal',
  description: 'Whether the run proposed at least one file change.',
  type: scorerType,
}).generateScore(({ run }) => ((run.output.proposedFiles ?? []).length > 0 ? 1 : 0));

export const SCORERS = [
  anchorResolution,
  stayedInScope,
  semverAgreement,
  validationClean,
  producedAProposal,
];
