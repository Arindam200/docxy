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
/**
 * The share of the whole-diff budget the notice about dropped files may spend.
 *
 * Naming every dropped file costs a line each, and the commits that drop files
 * are exactly the ones that drop thousands — so the notice explaining why the
 * diff was trimmed could blow the context window the trim exists to protect.
 * Reserved up front rather than added afterwards, and the list inside it is
 * capped with a count, so the rendering has a real upper bound.
 */
const MANIFEST_BUDGET = 6_000;
/**
 * How much of a commit message body is worth carrying into the prompt.
 *
 * Bounded for the same reason as everything else here: a release commit can
 * paste an entire changelog into its body, and a header is not the place to
 * spend the budget the diff needs.
 */
const BODY_BUDGET = 4_000;
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
function withinBudget(files: DiffFile[], budget: number) {
  const rendered = files.map((file) => ({ file, size: renderFile(file).length + 2 }));
  const bySize = [...rendered].sort((a, b) => a.size - b.size);

  const keep = new Set<DiffFile>();
  let spent = 0;
  for (const { file, size } of bySize) {
    if (spent + size > budget) continue;
    spent += size;
    keep.add(file);
  }

  return {
    kept: files.filter((file) => keep.has(file)),
    dropped: files.filter((file) => !keep.has(file)),
  };
}

/**
 * Name the files that did not fit, within a budget of its own.
 *
 * Every dropped file that can be named is named — a role that cannot see a file
 * must not conclude the file was unchanged. But a commit that drops ten
 * thousand files cannot have ten thousand lines about it either, so the list
 * stops at the reserve and the remainder is reported as a count. A number is a
 * worse answer than a name and a far better one than an overflowed prompt.
 */
function droppedManifest(dropped: DiffFile[]): string[] {
  if (dropped.length === 0) return [];

  const lines: string[] = [];
  let spent = 0;
  for (const file of dropped) {
    const line = `  - ${file.path} [${file.status}] +${file.additions}/-${file.deletions}`;
    if (spent + line.length + 1 > MANIFEST_BUDGET) break;
    spent += line.length + 1;
    lines.push(line);
  }

  const unnamed = dropped.length - lines.length;
  if (unnamed > 0) lines.push(`  - … and ${unnamed} more, too many to list by name.`);

  return [
    '',
    `NOTE: ${dropped.length} of these files were too large to include and are ` +
      `listed below by name only. Treat them as changed but unread, and say so ` +
      `in your output rather than assuming they are unaffected:`,
    ...lines,
  ];
}

/** Render a diff as the prompt payload handed to the agents. */
export function renderDiffForPrompt(diff: CommitDiff): string {
  // Chosen twice. The first pass asks what fits when nothing has to be
  // explained; if that drops files, the explanation costs budget of its own,
  // so the second pass chooses against what is actually left. Reserving the
  // notice unconditionally would shrink every ordinary diff to pay for a notice
  // it never prints.
  const first = withinBudget(diff.files, DIFF_BUDGET);
  const { kept, dropped } =
    first.dropped.length === 0 ? first : withinBudget(diff.files, DIFF_BUDGET - MANIFEST_BUDGET);

  const body = diff.body.slice(0, BODY_BUDGET);
  const truncatedBody = body.length < diff.body.length ? `${body}\n… message truncated.` : body;

  const header = [
    `commit ${diff.sha}`,
    `author: ${diff.author}`,
    `date:   ${diff.date}`,
    `subject: ${diff.subject}`,
    diff.body ? `\n${truncatedBody}\n` : '',
    `files changed: ${diff.files.length} (+${diff.totalAdditions} / -${diff.totalDeletions})`,
    ...droppedManifest(dropped),
  ].join('\n');

  return `${header}\n\n${kept.map(renderFile).join('\n\n')}`;
}
