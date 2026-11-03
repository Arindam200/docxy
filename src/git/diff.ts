import { execFile, spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
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
 * past the context window - where the failure arrives as an opaque provider
 * error rather than as "this commit is too big".
 *
 * Files are kept whole, largest dropped first, so what survives is the small
 * hand-written change inside a mechanical one - which is the part that has
 * documentation consequences.
 */
const DIFF_BUDGET = 180_000;
/**
 * How much patch text a whole commit may hold in memory, in characters.
 *
 * `PATCH_BUDGET` bounds each file, which bounds nothing about a commit of
 * forty thousand vendored files: a head for every one of them was kept, a few
 * hundred megabytes to build a prompt that shows 180k - enough to run the
 * container out of memory and take every lane down with it. The prompt keeps
 * the smallest files first, so when this is exceeded the largest heads are the
 * ones let go: they are the files the prompt would have dropped anyway. Kept
 * at several times `DIFF_BUDGET` so that is true with room to spare.
 */
const RETAINED_PATCH_BUDGET = 2_000_000;
/**
 * The share of the whole-diff budget the notice about dropped files may spend.
 *
 * Naming every dropped file costs a line each, and the commits that drop files
 * are exactly the ones that drop thousands - so the notice explaining why the
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
/** ASCII unit separator - safe against any character a commit message may contain. */
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

/** Most recent commits, newest first - used by the demo replay and `docxy log`. */
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
 * The options the whole-commit `git diff` runs with.
 *
 * Pinned, because its output is parsed and a user's configuration can reshape
 * it: a colour setting adds escapes, an external diff tool replaces the patch
 * with whatever it prints, and `diff.submodule=log` swaps a submodule's
 * `diff --git` header for a summary line. `-M` is the rename detection the
 * file list has always used.
 */
const DIFF_OPTIONS = ['-M', '--no-color', '--no-ext-diff', '--submodule=short'];

/** One file's patch as it streams past: the part worth keeping, and how long it really was. */
interface PatchText {
  head: string;
  length: number;
  /** The head was let go to keep the commit within `RETAINED_PATCH_BUDGET`. */
  evicted?: boolean;
}

/**
 * A copy of a string that shares no memory with the one it came from.
 *
 * A head is built from slices of the stream's chunks, and V8 keeps a sliced
 * string's whole parent alive: a 300-character patch pinned the 64 KB chunk it
 * was cut from, for as long as the diff was held.
 */
function detached(text: string): string {
  return Buffer.from(text, 'utf8').toString('utf8');
}

function appendPatch(patch: PatchText, text: string): void {
  if (patch.head.length < PATCH_BUDGET) {
    patch.head += text.slice(0, PATCH_BUDGET - patch.head.length);
  }
  patch.length += text.length;
}

/** Sections of one file, in order, as though they had streamed past as one. */
function joinPatches(parts: PatchText[]): PatchText {
  const joined: PatchText = { head: '', length: 0 };
  for (const part of parts) {
    appendPatch(joined, part.head);
    joined.length += part.length - part.head.length;
    if (part.evicted) joined.evicted = true;
  }
  if (joined.evicted) joined.head = '';
  return joined;
}

/**
 * How many `diff --git` sections a file's patch is printed as.
 *
 * Two for a type change - a file that became a symlink or a submodule, or the
 * reverse - because git prints that as the old thing's deletion followed by
 * the new thing's creation, under one entry in the file list. Asking for that
 * one path on its own printed both, so both belong to it here too.
 */
function sectionsFor(code: string): number {
  return code.startsWith('T') ? 2 : 1;
}

/**
 * Splits `git diff --raw --numstat -p -z` output as it arrives.
 *
 * The output comes in two parts. First the file list, NUL-separated: a raw
 * entry per file, then a numstat entry per file in the same order, and an
 * empty field closing the list. No field in it is ever empty, so the first
 * pair of NULs is that end. Then the patch text, a section per file, each
 * opening with a `diff --git ` line. That opening is unambiguous: inside a
 * hunk every line starts with a space, `+`, `-` or a backslash, so a file
 * whose *content* contains a diff header arrives as `+diff --git ...` and
 * splits nothing.
 *
 * Streamed rather than buffered because the commits this has to survive are
 * the vendored dependency bump and the regenerated client - hundreds of
 * megabytes of patch, of which no file keeps more than `PATCH_BUDGET`. The
 * rest is counted and dropped as it passes.
 */
class DiffSplitter {
  /** The file list, once the patch text has begun; everything so far before then. */
  listing = '';
  readonly sections: PatchText[] = [];
  private inPatch = false;
  private carry = '';
  /** Head characters held by finished sections. */
  private retained = 0;

  /**
   * Close the section that just ended: copy its head out of the chunks it was
   * sliced from and, if the commit is now holding too much, let the largest
   * heads go - down to half the budget, so this runs rarely rather than on
   * every section once a commit is large.
   */
  private finish(section: PatchText | undefined): void {
    if (!section || section.evicted) return;
    section.head = detached(section.head);
    this.retained += section.head.length;
    if (this.retained <= RETAINED_PATCH_BUDGET) return;
    const largest = this.sections
      .filter((candidate) => !candidate.evicted && candidate.head.length > 0)
      .sort((a, b) => b.head.length - a.head.length);
    for (const candidate of largest) {
      if (this.retained <= RETAINED_PATCH_BUDGET / 2) break;
      this.retained -= candidate.head.length;
      candidate.head = '';
      candidate.evicted = true;
    }
  }

  push(text: string): void {
    if (this.inPatch) {
      this.patchText(text);
      return;
    }
    const searchFrom = Math.max(0, this.listing.length - 1);
    this.listing += text;
    const close = this.listing.indexOf('\0\0', searchFrom);
    if (close === -1) return;
    const rest = this.listing.slice(close + 2);
    this.listing = this.listing.slice(0, close + 1);
    this.inPatch = true;
    this.patchText(rest);
  }

  /** Flush the final line, which git ends with a newline but a truncated stream may not. */
  end(): void {
    const tail = this.carry;
    this.carry = '';
    if (tail) this.lines(tail, tail.length);
    this.finish(this.sections.at(-1));
  }

  private patchText(text: string): void {
    const pending = this.carry + text;
    // A trailing partial line waits for the next chunk: a header split across
    // two chunks would otherwise be read as more of the file before it.
    const complete = pending.lastIndexOf('\n') + 1;
    this.carry = pending.slice(complete);
    this.lines(pending, complete);
  }

  private lines(text: string, end: number): void {
    let at = 0;
    while (at < end) {
      if (text.startsWith('diff --git ', at)) {
        this.finish(this.sections.at(-1));
        this.sections.push({ head: '', length: 0 });
      }
      const next = text.indexOf('\ndiff --git ', at);
      const stop = next === -1 ? end : Math.min(next + 1, end);
      const current = this.sections.at(-1);
      if (current) appendPatch(current, text.slice(at, stop));
      at = stop;
    }
  }
}

/** One file from the list: its raw status code, its names, and its line counts. */
interface ListedFile {
  code: string;
  /** One name, or the old and new names for a rename or copy. */
  paths: string[];
  additions: number;
  deletions: number;
}

/**
 * The file list half of the output.
 *
 * Read with `-z`, so names arrive verbatim. Without it git quotes any name
 * outside plain ASCII and writes a rename's line counts against
 * `old => new`, which matched no file - every renamed file reported +0/-0.
 */
function parseListing(listing: string): ListedFile[] {
  const fields = listing.split('\0');
  let at = 0;

  const raw: Array<{ code: string; paths: string[] }> = [];
  while ((fields[at] ?? '').startsWith(':')) {
    const code = fields[at]?.split(' ').at(-1) ?? '';
    const width = code.startsWith('R') || code.startsWith('C') ? 2 : 1;
    raw.push({ code, paths: fields.slice(at + 1, at + 1 + width) });
    at += 1 + width;
  }

  const listed: ListedFile[] = [];
  for (const entry of raw) {
    // `added<TAB>deleted<TAB>name`, or for a rename an empty name followed by
    // both names as fields of their own. Binary files count as `-`.
    const [added = '', deleted = '', ...name] = (fields[at] ?? '').split('\t');
    at += name.join('\t') === '' ? 3 : 1;
    listed.push({
      ...entry,
      additions: Number.parseInt(added, 10) || 0,
      deletions: Number.parseInt(deleted, 10) || 0,
    });
  }
  return listed;
}

/** Run the whole-commit diff once and split it as it streams. */
async function streamDiff(repoPath: string, range: string[]): Promise<DiffSplitter> {
  const splitter = new DiffSplitter();
  const child = spawn('git', ['diff', '--raw', '--numstat', '-p', '-z', ...DIFF_OPTIONS, ...range], {
    cwd: repoPath,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const decoder = new StringDecoder('utf8');
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => splitter.push(decoder.write(chunk)));
  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < 8_192) stderr += chunk.toString('utf8');
  });

  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git diff exited with ${code ?? 'a signal'}: ${stderr.trim()}`));
    });
  });

  splitter.push(decoder.end());
  splitter.end();
  return splitter;
}

/**
 * Read one commit as a structured diff. Diffs against the first parent so a merge
 * commit reports what actually landed on the branch, not the whole other side.
 *
 * One `git diff` for the whole commit, split per file as it streams. It used
 * to be a process per changed file, run one after another, so a formatter run
 * across three hundred files was three hundred sequential spawns before the
 * first role saw anything.
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

  const { listing, sections } = await streamDiff(repoPath, range);
  const listed = parseListing(listing);

  // Sections are matched to files by position, which holds only while there
  // is exactly the number the list predicts. Should some configuration ever
  // print one more or one fewer, every patch after it would land on the wrong
  // file - so instead each file is asked for on its own, the slow way, which
  // cannot be misattributed.
  const aligned = sections.length === listed.reduce((n, file) => n + sectionsFor(file.code), 0);

  const files: DiffFile[] = [];
  let cursor = 0;
  // The slow path asks per file, so it is held to the same total here.
  let fetched = 0;
  for (const entry of listed) {
    const own = sections.slice(cursor, cursor + sectionsFor(entry.code));
    cursor += sectionsFor(entry.code);

    const status = parseStatus(entry.code);
    const previousPath = status === 'renamed' ? entry.paths[0] : undefined;
    const path = entry.paths.at(-1) ?? '';
    if (!path) continue;

    let text: PatchText = { head: '', length: 0 };
    if (status !== 'deleted') {
      if (aligned) {
        text = joinPatches(own);
      } else if (fetched > RETAINED_PATCH_BUDGET) {
        text = { head: '', length: 0, evicted: true };
      } else {
        appendPatch(text, await git(repoPath, ['diff', ...range, '--', path]).catch(() => ''));
        text.head = detached(text.head);
        fetched += text.head.length;
      }
    }

    const truncated = text.length > PATCH_BUDGET;
    const patch = text.evicted
      ? ''
      : truncated
        ? `${text.head}\n... [patch truncated: ${text.length - PATCH_BUDGET} more characters]`
        : text.head;

    const file: DiffFile = {
      path,
      status,
      additions: entry.additions,
      deletions: entry.deletions,
      patch,
      truncated: truncated || Boolean(text.evicted),
    };
    if (text.evicted) file.omitted = true;
    // A rename carries the name it had before; everything else has no such
    // field at all, rather than one holding `undefined`.
    files.push(previousPath ? { ...file, previousPath } : file);
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
  // A file whose patch was not kept cannot be shown, so it never fits: it is
  // named among the dropped files instead of rendered as an empty patch.
  const rendered = files.map((file) => ({
    file,
    size: file.omitted ? Number.POSITIVE_INFINITY : renderFile(file).length + 2,
  }));
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
 * Every dropped file that can be named is named - a role that cannot see a file
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
