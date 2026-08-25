import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CommitDiff, DiffFile } from '../types.js';

const exec = promisify(execFile);

/** Per-file patch budget, in characters. Keeps a huge commit inside the context window. */
const PATCH_BUDGET = 12_000;
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
      previousPath,
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

/** Render a diff as the prompt payload handed to the agents. */
export function renderDiffForPrompt(diff: CommitDiff): string {
  const header = [
    `commit ${diff.sha}`,
    `author: ${diff.author}`,
    `date:   ${diff.date}`,
    `subject: ${diff.subject}`,
    diff.body ? `\n${diff.body}\n` : '',
    `files changed: ${diff.files.length} (+${diff.totalAdditions} / -${diff.totalDeletions})`,
  ].join('\n');

  const body = diff.files
    .map((f) => {
      const rename = f.previousPath ? ` (renamed from ${f.previousPath})` : '';
      return [
        `--- ${f.path} [${f.status}${rename}] +${f.additions}/-${f.deletions}`,
        f.patch || '(no textual patch - binary or deleted)',
      ].join('\n');
    })
    .join('\n\n');

  return `${header}\n\n${body}`;
}
