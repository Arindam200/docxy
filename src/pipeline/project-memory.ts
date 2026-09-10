import { z } from 'zod';
import type { RunRecord } from '../types.js';

/**
 * What docxy has learned about one repository, as facts rather than transcript.
 *
 * This is Mastra working memory, resource-scoped: the resource is the
 * repository, so the record persists across every thread, every role, and every
 * commit. It is stored and read through `Memory`, and it is deliberately
 * **not** agent-managed.
 *
 * That last part is the whole design. Mastra's default is to hand the model an
 * `updateWorkingMemory` tool and let it write its own memory, and this
 * repository already has the scar from model-authored memory reaching a role
 * that must quote exactly: the Docs Updater anchored on a README paragraph
 * deleted twenty minutes earlier, which was in no prompt it was given (see
 * `RoleDefinition.carriesMemory`). Working memory is a smaller surface than a
 * message history, but it is the same failure waiting: prose a model wrote
 * about a file, presented next run as fact about that file.
 *
 * So the model never writes this and never sees a tool for it. Every field
 * below is counted by `observeRun` from what a finished run already recorded,
 * which makes the memory reproducible, auditable, and cheap - the same
 * properties `src/evals/scorers.ts` insists on, for the same reason. What
 * reaches a role is `renderProjectMemory`, in the prompt, where the recorded
 * prompt shows exactly what it was told.
 */

/** Observations before a file's record is allowed to claim anything. */
const MIN_OBSERVATIONS = 4;

/**
 * Applied-to-proposed ratio below which a file is called out as fragile.
 *
 * Set just under the repository-wide `anchor-resolution` mean (~64%) so the
 * list names files that are worse than the pipeline's ordinary miss rate,
 * rather than restating that miss rate one file at a time.
 */
const FRAGILE_BELOW = 0.6;

/** Files that have accepted every edit are not interesting individually. */
const RELIABLE_AT_OR_ABOVE = 0.95;

/**
 * Tracked files, most recently seen first.
 *
 * A cap rather than unbounded growth because this string is loaded on every run
 * and rendered into two prompts: a repository with a thousand doc files would
 * otherwise spend its context budget on its own history.
 */
const MAX_FILES = 120;

/** Fragile files named in a prompt. The tail is summarised as a count. */
const MAX_RENDERED = 12;

const fileRecordSchema = z.object({
  path: z.string(),
  /** Edits the Docs Updater proposed against this file, across all runs. */
  proposed: z.number().int().nonnegative(),
  /** How many of those applied - the anchor matched the file byte for byte. */
  applied: z.number().int().nonnegative(),
  /** Runs that proposed at least one edit here. */
  runs: z.number().int().nonnegative(),
  lastSeenAt: z.string(),
});

export const projectMemorySchema = z.object({
  /**
   * Bumped when the shape changes. A record written under an older version is
   * discarded rather than migrated: it is counters, it costs one run to rebuild,
   * and a wrong count is worse than an absent one.
   */
  version: z.literal(1),
  /** Per doc file anchoring history - the signal TODO #1 is chasing. */
  files: z.array(fileRecordSchema),
  /**
   * Edits proposed against files the Impact Mapper never flagged.
   *
   * Kept as a repository-level count rather than per file because it is the
   * Impact Mapper being incomplete, not any one file being difficult.
   */
  outOfScopeEdits: z.number().int().nonnegative(),
  observed: z.object({
    runs: z.number().int().nonnegative(),
    lastCommit: z.string(),
    updatedAt: z.string(),
  }),
});

export type ProjectMemory = z.infer<typeof projectMemorySchema>;
export type ProjectFileRecord = z.infer<typeof fileRecordSchema>;

export function emptyProjectMemory(): ProjectMemory {
  return {
    version: 1,
    files: [],
    outOfScopeEdits: 0,
    observed: { runs: 0, lastCommit: '', updatedAt: '' },
  };
}

/**
 * Read a stored record, treating anything unrecognised as absent.
 *
 * Parsed rather than cast for the same reason `SessionStore` parses its file:
 * this is a row an earlier version of this program wrote and a person may have
 * edited. A memory that fails to parse costs one run of relearning; a memory
 * trusted while malformed puts invented numbers into a prompt.
 */
export function parseProjectMemory(raw: string | null | undefined): ProjectMemory {
  if (!raw) return emptyProjectMemory();
  try {
    const parsed = projectMemorySchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : emptyProjectMemory();
  } catch {
    return emptyProjectMemory();
  }
}

export function serializeProjectMemory(memory: ProjectMemory): string {
  return JSON.stringify(memory);
}

/**
 * Fold one finished run into the record.
 *
 * Pure, so the same run folds the same way every time and the merge can be
 * tested without a model, a database, or a clock.
 *
 * The run must be **fully hydrated** - `proposedFiles` populated, as
 * `RunStorage.load` returns it and as the live `RunRecord` in `runPipeline`
 * already is. `RunStorage.list` omits that field for speed, and folding a
 * listing would record that every file in the repository fails every anchor:
 * confident, precise, and completely wrong, which is the failure mode
 * `scoreRuns` documents at length.
 */
export function observeRun(memory: ProjectMemory, run: RunRecord): ProjectMemory {
  const edits = run.docs?.edits ?? [];

  // A run whose Docs Updater never returned, or which died before its proposal
  // was applied, has nothing to say about how well anchors match. Counting it
  // as zero-applied would blame the files for a role that never ran.
  if (edits.length === 0 || run.proposedFiles === undefined) return memory;

  const appliedByPath = new Map(run.proposedFiles.map((file) => [file.path, file.appliedEdits]));
  const flagged = new Set((run.impact?.docs ?? []).map((doc) => doc.path));

  const proposedByPath = new Map<string, number>();
  let outOfScope = 0;
  for (const edit of edits) {
    proposedByPath.set(edit.path, (proposedByPath.get(edit.path) ?? 0) + 1);
    if (!flagged.has(edit.path)) outOfScope += 1;
  }

  const at = run.finishedAt ?? run.startedAt ?? new Date().toISOString();
  const byPath = new Map(memory.files.map((file) => [file.path, file]));

  for (const [path, proposed] of proposedByPath) {
    const previous = byPath.get(path);
    // Clamped because `appliedEdits` counts applications, and a run that
    // repaired anchors can apply more than the first pass proposed - which
    // would otherwise score a file above 100%.
    const applied = Math.min(appliedByPath.get(path) ?? 0, proposed);
    byPath.set(path, {
      path,
      proposed: (previous?.proposed ?? 0) + proposed,
      applied: (previous?.applied ?? 0) + applied,
      runs: (previous?.runs ?? 0) + 1,
      lastSeenAt: at,
    });
  }

  const files = [...byPath.values()]
    .sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, MAX_FILES);

  return {
    version: 1,
    files,
    outOfScopeEdits: memory.outOfScopeEdits + outOfScope,
    observed: {
      runs: memory.observed.runs + 1,
      lastCommit: run.commit.sha,
      updatedAt: at,
    },
  };
}

/** Applied over proposed, with too-few observations reported as unknown. */
function reliability(file: ProjectFileRecord): number | null {
  if (file.proposed < MIN_OBSERVATIONS) return null;
  return file.applied / file.proposed;
}

function fragileFiles(memory: ProjectMemory): ProjectFileRecord[] {
  return memory.files
    .filter((file) => {
      const rate = reliability(file);
      return rate !== null && rate < FRAGILE_BELOW;
    })
    .sort((a, b) => (reliability(a) ?? 1) - (reliability(b) ?? 1));
}

function reliableFiles(memory: ProjectMemory): ProjectFileRecord[] {
  return memory.files.filter((file) => {
    const rate = reliability(file);
    return rate !== null && rate >= RELIABLE_AT_OR_ABOVE;
  });
}

function describe(file: ProjectFileRecord): string {
  return `${file.path} - ${file.applied} of ${file.proposed} proposed edits applied, over ${file.runs} run(s)`;
}

/**
 * The record as prompt text, addressed to the role that will read it.
 *
 * Two audiences because the same counters imply different work. A file whose
 * anchors keep missing is, to the Docs Updater, an instruction about how to
 * quote; to the Impact Mapper it is a question about whether that file should
 * have been flagged at all - which is the upstream fix TODO #1 proposes for the
 * transcript-heavy documents where the failures cluster.
 *
 * Numbers are given rather than adjectives. "This file is difficult" is
 * something a model can talk itself out of; "3 of 14 applied" is not.
 */
export function renderProjectMemory(
  memory: ProjectMemory,
  audience: 'impact-mapper' | 'docs-updater',
): string {
  if (memory.observed.runs === 0) {
    return '(empty - docxy has not yet completed a run against this repository)';
  }

  const fragile = fragileFiles(memory);
  const lines: string[] = [
    `Learned from ${memory.observed.runs} completed run(s) against this repository.`,
  ];

  if (fragile.length > 0) {
    const shown = fragile.slice(0, MAX_RENDERED);
    lines.push(
      '',
      audience === 'docs-updater'
        ? 'Edits to these files have repeatedly failed to apply, because the anchor did ' +
            'not match the file byte for byte. Copy your anchors from the text in this ' +
            'prompt character by character - never retype or reformat them - and prefer ' +
            'the shortest anchor that is still unique. If the section you would edit is ' +
            'sample terminal output or a transcript, list it under `skipped` rather than ' +
            'reproducing it from memory:'
        : 'Edits to these files have repeatedly failed to apply, so flagging them has ' +
            'tended to produce work that is thrown away. Flag a section here only when ' +
            'the commit genuinely falsifies its prose; do not flag sample output, ' +
            'transcripts, or recorded numbers, which cannot be rewritten from a diff:',
      ...shown.map((file) => `- ${describe(file)}`),
    );
    if (fragile.length > shown.length) {
      lines.push(`- ... and ${fragile.length - shown.length} more`);
    }
  }

  if (audience === 'docs-updater') {
    const reliable = reliableFiles(memory).slice(0, MAX_RENDERED);
    if (reliable.length > 0) {
      lines.push(
        '',
        'Edits to these files have applied cleanly before:',
        ...reliable.map((file) => `- ${file.path}`),
      );
    }
  }

  if (audience === 'impact-mapper' && memory.outOfScopeEdits > 0) {
    lines.push(
      '',
      `On earlier commits the Docs Updater proposed ${memory.outOfScopeEdits} edit(s) to ` +
        'files this map had not flagged. If a file is genuinely affected, flag it - an ' +
        'edit to an unflagged file is rejected downstream.',
    );
  }

  // Every file is either unremarkable or too new to judge. Saying so is worth a
  // line: it distinguishes "nothing learned yet" from "learned, nothing wrong".
  if (lines.length === 1) {
    lines.push('', 'No file has a notable anchoring record yet.');
  }

  return lines.join('\n');
}
