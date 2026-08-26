import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitDiff, DiffFile } from '../types.js';

const exec = promisify(execFile);

/** Per-file patch budget, in characters. Keeps a huge commit inside the context window. */
const PATCH_BUDGET = 12_000;
/**
 * Whole-diff budget, in characters.
 *
 * The per-file budget alone bounds nothing: a commit touching two hundred files
 * stays under it on every single one and still renders two million characters.
 * A vendored dependency bump, a generated-client refresh, or a formatter run
 * across the tree all look exactly like that, and each one pushed the prompt
 * past the context window — where the failure arrives as an opaque provider
 * error rather than as "this commit is too big".
 *
 * Files are kept whole, largest dropped first, so what survives is the small
 * hand-written change inside a mechanical one — which is the part that has
 * documentation consequences.
 */
const DIFF_BUDGET = 180_000;
/** ASCII unit separator — safe against any character a commit message may contain. */
const SEP = '\x1f';

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd: repoPath,
    maxBuffer: 64 * 1024 * 1024,
  });
  return stdout;
}

export async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommit(repoPath: string, ref: string): Promise<string> {
  return (await git(repoPath, ['rev-parse', ref])).trim();
}

/** Most recent commits, newest first — used by the demo replay and `docxy log`. */
export async function recentCommits(
  repoPath: string,
  count: number,
): Promise<Array<{ sha: string; subject: string }>> {
  const out = await git(repoPath, ['log', `-n${count}`, `--format=%H${SEP}%s`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha = '', subject = ''] = line.split(SEP);
      return { sha, subject };
    });
}

function parseStatus(code: string): DiffFile['status'] {
  if (code.startsWith('A')) return 'added';
  if (code.startsWith('D')) return 'deleted';
  if (code.startsWith('R')) return 'renamed';
  return 'modified';
}

/** The empty tree, used to diff a root commit that has no parent. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * Read one commit as a structured diff. Diffs against the first parent so a merge
 * commit reports what actually landed on the branch, not the whole other side.
 */
export async function readCommitDiff(repoPath: string, ref: string): Promise<CommitDiff> {
  const sha = await resolveCommit(repoPath, ref);

  const meta = await git(repoPath, [
    'show',
    '-s',
    `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI${SEP}%b`,
    sha,
  ]);
  const [
    fullSha = sha,
    shortSha = sha.slice(0, 7),
    subject = '',
    author = '',
    date = '',
    ...bodyParts
  ] = meta.trim().split(SEP);

  const parentCount =
    (await git(repoPath, ['rev-list', '--parents', '-n1', sha])).trim().split(/\s+/).length - 1;
  const range = parentCount > 0 ? [`${sha}^1`, sha] : [EMPTY_TREE, sha];

  const nameStatus = await git(repoPath, ['diff', '--name-status', '-M', ...range]);
  const numstat = await git(repoPath, ['diff', '--numstat', '-M', ...range]);

  const counts = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split('\n').filter(Boolean)) {
    const [add = '0', del = '0', ...pathParts] = line.split('\t');
    const path = pathParts[pathParts.length - 1] ?? '';
    counts.set(path, {
      additions: Number.parseInt(add, 10) || 0,
      deletions: Number.parseInt(del, 10) || 0,
    });
  }

  const files: DiffFile[] = [];
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const parts = line.split('\t');
    const status = parseStatus(parts[0] ?? '');
    const previousPath = status === 'renamed' ? parts[1] : undefined;
    const path = (status === 'renamed' ? parts[2] : parts[1]) ?? '';
    if (!path) continue;

    let patch = '';
    if (status !== 'deleted') {
      try {
        patch = await git(repoPath, ['diff', ...range, '--', path]);
      } catch {
        patch = '';
      }
    }
    const truncated = patch.length > PATCH_BUDGET;
    if (truncated) {
      const dropped = patch.length - PATCH_BUDGET;
      patch = `${patch.slice(0, PATCH_BUDGET)}\n... [patch truncated: ${dropped} more characters]`;
    }

    const count = counts.get(path) ?? { additions: 0, deletions: 0 };
    files.push({
      path,
      status,
      ...(previousPath ? { previousPath } : {}),
      additions: count.additions,
      deletions: count.deletions,
      patch,
      truncated,
    });
  }

  return {
    sha: fullSha,
    shortSha,
    subject,
    body: bodyParts.join(SEP).trim(),
    author,
    date,
    files,
    totalAdditions: files.reduce((n, f) => n + f.additions, 0),
    totalDeletions: files.reduce((n, f) => n + f.deletions, 0),
  };
}

function renderFile(file: DiffFile): string {
  const rename = file.previousPath ? ` (renamed from ${file.previousPath})` : '';
  return [
    `--- ${file.path} [${file.status}${rename}] +${file.additions}/-${file.deletions}`,
    file.patch || '(no textual patch - binary or deleted)',
  ].join('\n');
}

/**
 * Choose which files fit in the budget.
 *
 * Smallest first, so a commit that mixes one hand-edited file with a hundred
 * generated ones keeps the hand-edited one. The originally-listed order is
 * restored afterwards: a diff should read in the order git reported it.
 */
function withinBudget(files: DiffFile[]) {
  const rendered = files.map((file) => ({ file, size: renderFile(file).length + 2 }));
  const bySize = [...rendered].sort((a, b) => a.size - b.size);

  const keep = new Set<DiffFile>();
  let spent = 0;
  for (const { file, size } of bySize) {
    if (spent + size > DIFF_BUDGET) continue;
    spent += size;
    keep.add(file);
  }

  return {
    kept: files.filter((file) => keep.has(file)),
    dropped: files.filter((file) => !keep.has(file)),
  };
}

/** Render a diff as the prompt payload handed to the agents. */
export function renderDiffForPrompt(diff: CommitDiff): string {
  const { kept, dropped } = withinBudget(diff.files);

  const header = [
    `commit ${diff.sha}`,
    `author: ${diff.author}`,
    `date:   ${diff.date}`,
    `subject: ${diff.subject}`,
    diff.body ? `\n${diff.body}\n` : '',
    `files changed: ${diff.files.length} (+${diff.totalAdditions} / -${diff.totalDeletions})`,
    // Named, never silent. A role that cannot see a file must not conclude the
    // file was unchanged, and a reader looking at a thin classification needs
    // to know the diff was thinned before the model ever saw it.
    ...(dropped.length > 0
      ? [
          '',
          `NOTE: ${dropped.length} of these files were too large to include and are ` +
            `listed below by name only. Treat them as changed but unread, and say so ` +
            `in your output rather than assuming they are unaffected:`,
          ...dropped.map((f) => `  - ${f.path} [${f.status}] +${f.additions}/-${f.deletions}`),
        ]
      : []),
  ].join('\n');

  return `${header}\n\n${kept.map(renderFile).join('\n\n')}`;
}
