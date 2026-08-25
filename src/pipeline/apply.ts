import { readRepoFile } from '../git/repo.js';
import type { DocEdit, DocsProposal, ChangelogProposal, ProposedFile } from '../types.js';

export type { ProposedFile };

export interface ApplyProblem {
  path: string;
  kind: 'missing-file' | 'anchor-not-found' | 'anchor-ambiguous' | 'no-op';
  detail: string;
}

export interface ApplyResult {
  files: ProposedFile[];
  problems: ApplyProblem[];
}

function occurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * Apply the proposed edits in memory. Nothing is written to disk here — the
 * result feeds validation, the diff shown to the reviewer, and (only after
 * approval) the branch that becomes a pull request.
 */
export async function applyDocEdits(
  docsPath: string,
  proposal: DocsProposal,
): Promise<ApplyResult> {
  const byPath = new Map<string, DocEdit[]>();
  for (const edit of proposal.edits ?? []) {
    if (!edit?.path) continue;
    byPath.set(edit.path, [...(byPath.get(edit.path) ?? []), edit]);
  }

  const files: ProposedFile[] = [];
  const problems: ApplyProblem[] = [];

  for (const [path, edits] of byPath) {
    const before = await readRepoFile(docsPath, path);
    if (before === null) {
      problems.push({
        path,
        kind: 'missing-file',
        detail: 'The proposed edit targets a file that does not exist in the repository.',
      });
      continue;
    }

    let after = before;
    let applied = 0;

    for (const edit of edits) {
      if (edit.mode === 'append') {
        const addition = edit.replace ?? '';
        if (!addition.trim()) continue;
        after = `${after.replace(/\s*$/, '')}\n\n${addition.trim()}\n`;
        applied += 1;
        continue;
      }

      const find = edit.find ?? '';
      if (!find) {
        problems.push({
          path,
          kind: 'anchor-not-found',
          detail: 'A replace edit was proposed with an empty find anchor.',
        });
        continue;
      }

      const count = occurrences(after, find);
      if (count === 0) {
        problems.push({
          path,
          kind: 'anchor-not-found',
          detail:
            `The anchor text was not found in the file. This usually means the ` +
            `model paraphrased instead of copying. Anchor began: ` +
            JSON.stringify(find.slice(0, 120)),
        });
        continue;
      }
      if (count > 1) {
        problems.push({
          path,
          kind: 'anchor-ambiguous',
          detail:
            `The anchor text appears ${count} times, so the edit is ambiguous. ` +
            `Anchor began: ${JSON.stringify(find.slice(0, 120))}`,
        });
        continue;
      }

      after = after.replace(find, () => edit.replace ?? '');
      applied += 1;
    }

    if (applied === 0) {
      problems.push({ path, kind: 'no-op', detail: 'No edit could be applied to this file.' });
      continue;
    }
    if (after === before) {
      problems.push({ path, kind: 'no-op', detail: 'The edit produced no textual change.' });
      continue;
    }

    files.push({ path, before, after, appliedEdits: applied });
  }

  return { files, problems };
}

/** Splice a new entry into a Keep a Changelog file under an Unreleased heading. */
export async function applyChangelogEntry(
  docsPath: string,
  changelogPath: string,
  proposal: ChangelogProposal,
): Promise<ProposedFile> {
  const existing = (await readRepoFile(docsPath, changelogPath)) ?? '# Changelog\n';
  const line = `- ${proposal.entry.replace(/^[-*]\s*/, '')}`;
  const lines = existing.split('\n');

  const unreleasedIndex = lines.findIndex((l) => /^##\s+\[?unreleased\]?/i.test(l.trim()));

  if (unreleasedIndex === -1) {
    // No Unreleased block yet — open one directly under the title.
    const titleIndex = lines.findIndex((l) => /^#\s+/.test(l));
    const insertAt = titleIndex === -1 ? 0 : titleIndex + 1;
    const block = ['', '## [Unreleased]', '', `### ${proposal.section}`, '', line];
    lines.splice(insertAt, 0, ...block);
    return {
      path: changelogPath,
      before: existing,
      after: `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`.replace(/\n+$/, '\n'),
      appliedEdits: 1,
    };
  }

  // Find the matching `### Section` inside the Unreleased block, if present.
  let sectionIndex = -1;
  for (let i = unreleasedIndex + 1; i < lines.length; i += 1) {
    const line_ = lines[i]!;
    if (/^##\s+/.test(line_)) break; // next release block
    if (new RegExp(`^###\\s+${proposal.section}\\s*$`, 'i').test(line_.trim())) {
      sectionIndex = i;
      break;
    }
  }

  if (sectionIndex === -1) {
    lines.splice(unreleasedIndex + 1, 0, '', `### ${proposal.section}`, '', line);
  } else {
    let insertAt = sectionIndex + 1;
    while (insertAt < lines.length && lines[insertAt]!.trim() === '') insertAt += 1;
    while (insertAt < lines.length && /^[-*]\s+/.test(lines[insertAt]!.trim())) insertAt += 1;
    lines.splice(insertAt, 0, line);
  }

  return {
    path: changelogPath,
    before: existing,
    after: `${lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n+$/, '')}\n`,
    appliedEdits: 1,
  };
}
