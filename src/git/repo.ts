import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, extname, resolve, sep } from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.turbo', '.cache', 'vendor', '__pycache__', '.venv', 'target',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);

/**
 * Cap on how much documentation is inlined into one prompt, in characters.
 *
 * This was 20,000 across *all* impacted files put together, which is where
 * every `anchor-not-found` failure in this repository came from. The Docs
 * Updater is asked to quote its `find` text verbatim from "the file text you
 * were given"; on a run with three impacted docs totalling 58,000 characters it
 * was given 56% of the first one and nothing at all of the other two - while
 * the impact map in the same prompt named sections in all three. Asked to quote
 * text it had never seen, it did the only thing it could and invented it.
 *
 * ~50k tokens against models with a 1M window, and about two cents of input at
 * current rates on a run that costs fifteen. The old value was not buying
 * anything worth an unusable proposal.
 */
const DOC_EXCERPT_BUDGET = Number.parseInt(process.env.DOCXY_DOC_EXCERPT_BUDGET ?? '', 10) || 200_000;

/**
 * Least text worth sending for a file at all.
 *
 * A few hundred characters of a long document is worse than nothing: too little
 * to anchor an edit against, but enough to look like the file was provided. A
 * file that cannot be given at least this much is reported omitted instead.
 */
const MIN_USEFUL_EXCERPT = 2_000;

async function walk(root: string, base: string, acc: string[], depth = 0): Promise<void> {
  if (depth > 8) return;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(full, base, acc, depth + 1);
    } else if (entry.isFile() && DOC_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      acc.push(relative(base, full).split(sep).join('/'));
    }
  }
}

/** Every documentation file under the configured roots, repo-relative. */
export async function listDocs(repoPath: string, docsRoots: string[]): Promise<string[]> {
  const found: string[] = [];
  for (const root of docsRoots) {
    const full = join(repoPath, root);
    if (!existsSync(full)) continue;
    const info = await stat(full);
    if (info.isDirectory()) {
      await walk(full, repoPath, found);
    } else if (DOC_EXTENSIONS.has(extname(full).toLowerCase())) {
      found.push(relative(repoPath, full).split(sep).join('/'));
    }
  }
  return [...new Set(found)].sort();
}

/**
 * The absolute path of `relPath` inside `root`, or null when it would leave it.
 *
 * Every repository path that reaches the filesystem here was chosen by a model,
 * and the model chose it after reading a diff somebody else wrote. A commit
 * that says "now update ../../proc/self/environ" is a prompt, not a path, and
 * `join` would follow it: out of the checkout on a read, into the server's own
 * files on a write. So the check is lexical first (no absolute paths, no
 * escaping `..`, nothing under `.git`, where a written hook or config is code
 * that git runs) and then physical, because a repository can also carry a
 * symlink that points anywhere. The nearest component that exists is resolved
 * and must still be inside the resolved root.
 */
export async function containedPath(root: string, relPath: string): Promise<string | null> {
  if (!relPath || relPath.includes('\0') || isAbsolute(relPath)) return null;
  if (relPath.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')) return null;

  const base = resolve(root);
  const target = resolve(base, relPath);
  if (!target.startsWith(base + sep)) return null;

  let realRoot: string;
  try {
    realRoot = await realpath(base);
  } catch {
    return null;
  }

  for (let probe = target; ; probe = dirname(probe)) {
    try {
      const real = await realpath(probe);
      return real === realRoot || real.startsWith(realRoot + sep) ? target : null;
    } catch (cause) {
      const missing = cause instanceof Error && 'code' in cause && cause.code === 'ENOENT';
      if (!missing || probe === base) return null;
      // `realpath` also says ENOENT for a symlink whose target does not exist,
      // and a write through one creates that target wherever it points. Only a
      // component with no directory entry at all is genuinely not there yet.
      if (await lstat(probe).then(() => true, () => false)) return null;
    }
  }
}

export async function readRepoFile(repoPath: string, relPath: string): Promise<string | null> {
  const target = await containedPath(repoPath, relPath);
  if (!target) return null;
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}

/**
 * How many documentation files are read at once.
 *
 * One at a time made a docs tree of a few hundred pages a few hundred
 * sequential round trips to the disk before the first role could start. All at
 * once runs a large tree into the process's file-descriptor limit, and the
 * reads that lose that race come back null - indistinguishable, to everything
 * downstream, from a file that is not there.
 */
const READ_CONCURRENCY = 16;

/**
 * `readRepoFile` over every path, a bounded number at a time, each result
 * passed through `keep` as it lands; answers in the order asked.
 *
 * `keep` is what lets a caller that needs only a little of each file - the
 * outline wants headings - avoid holding the whole docs tree in memory at once.
 */
async function readEach<T>(
  repoPath: string,
  paths: string[],
  keep: (content: string) => T,
): Promise<Array<T | null>> {
  const results: Array<T | null> = Array.from({ length: paths.length }, () => null);
  let next = 0;
  const reader = async (): Promise<void> => {
    while (next < paths.length) {
      const index = next;
      next += 1;
      const content = await readRepoFile(repoPath, paths[index] ?? '');
      results[index] = content === null ? null : keep(content);
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, reader));
  return results;
}

/** `readRepoFile` over every path, a bounded number at a time, answers in the order asked. */
function readRepoFiles(repoPath: string, paths: string[]): Promise<Array<string | null>> {
  return readEach(repoPath, paths, (content) => content);
}

/** Markdown headings in a doc, so agents can name a real section. */
export function extractHeadings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (m) headings.push(`${'#'.repeat(m[1]!.length)} ${m[2]}`);
  }
  return headings;
}

/**
 * How much of the Impact Mapper's prompt the outline may take, in characters.
 *
 * About 15k tokens. The outline was unbounded: every heading of every page,
 * which for a docs site of a few thousand pages is megabytes - past any
 * model's context, so the run failed on its second role, every time.
 */
export const OUTLINE_BUDGET = 60_000;

export interface OutlineOptions {
  budget?: number;
  /**
   * Higher first. Decides which files keep their headings when they do not all
   * fit; the rest are listed by path, and past that counted.
   */
  priority?: (path: string) => number;
}

/**
 * A compact outline of the docs tree: path plus headings. Cheap enough to hand to
 * the Impact Mapper for every commit, and enough for it to name real sections.
 *
 * Bounded by `OUTLINE_BUDGET`. When everything fits - most repositories - it
 * is every file with every heading, as before. When it does not, the files the
 * caller ranks highest keep their headings, the others are listed by path so
 * they can still be named, and whatever is left after that is counted, so the
 * model knows the list is incomplete rather than reading it as the whole tree.
 * `paths` is always every documentation file, shown or not.
 */
export async function buildDocsOutline(
  repoPath: string,
  docsRoots: string[],
  options: OutlineOptions = {},
): Promise<{ outline: string; paths: string[] }> {
  const budget = options.budget ?? OUTLINE_BUDGET;
  const paths = await listDocs(repoPath, docsRoots);
  // Headings only: nothing else of a file is kept past the moment it is read.
  const headings = await readEach(repoPath, paths, extractHeadings);

  const entries = paths.flatMap((path, index) => {
    const found = headings[index];
    if (!found) return [];
    const full =
      found.length > 0
        ? `${path}\n${found.map((h) => `  ${h}`).join('\n')}`
        : `${path}\n  (no headings)`;
    return [{ path, index, full }];
  });

  const total = entries.reduce((sum, entry) => sum + entry.full.length + 2, 0);
  if (total <= budget) {
    return { outline: entries.map((entry) => entry.full).join('\n\n'), paths };
  }

  // Ranked, stable on the listing order among equals.
  const priority = options.priority ?? (() => 0);
  const ranked = [...entries].sort((a, b) => priority(b.path) - priority(a.path) || a.index - b.index);

  // Three quarters for files with their headings, the rest for bare paths,
  // less what the two notices below cost.
  const LISTED_HEADER = 'Also documentation, headings not shown for space:';
  const NOTICE_RESERVE = 200;
  const headed = new Set<string>();
  let used = LISTED_HEADER.length + 2 + NOTICE_RESERVE;
  for (const entry of ranked) {
    if (used + entry.full.length + 2 > budget * 0.75) continue;
    headed.add(entry.path);
    used += entry.full.length + 2;
  }
  const listed: string[] = [];
  for (const entry of ranked) {
    if (headed.has(entry.path)) continue;
    // Each one an indented line of its own.
    if (used + entry.path.length + 3 > budget) break;
    listed.push(entry.path);
    used += entry.path.length + 3;
  }
  const unshown = entries.length - headed.size - listed.length;

  const parts = entries.filter((entry) => headed.has(entry.path)).map((entry) => entry.full);
  if (listed.length > 0) {
    parts.push(`${LISTED_HEADER}\n${listed.map((p) => `  ${p}`).join('\n')}`);
  }
  if (unshown > 0) {
    parts.push(
      `... and ${unshown} more documentation file(s) not listed for space. ` +
        'Only the paths above can be named.',
    );
  }
  return { outline: parts.join('\n\n'), paths };
}

export interface DocExcerpts {
  /** The prompt section: every included file, whole or clearly marked as cut. */
  text: string;
  /** Paths that could not be read at all. */
  missing: string[];
  /**
   * Paths left out entirely for want of budget.
   *
   * Separate from `missing` because the cause is different and so is the fix,
   * but the caller must treat them the same way: tell the model to skip them.
   * Silently dropping one is what produced anchors quoted from nothing.
   */
  omitted: string[];
  /** Paths included only in part, and therefore only partly editable. */
  truncated: string[];
}

/**
 * Share a fixed budget across files by water-filling.
 *
 * Every file gets an equal share; whatever a small file does not need is
 * redistributed to the ones that do, repeatedly, until nothing more can be
 * given away. The first-come-first-served version spent the whole budget on
 * whichever document happened to be listed first and left the rest with
 * nothing - and "listed first" is the Impact Mapper's ordering, which carries
 * no claim about importance.
 */
function allocate(sizes: number[], budget: number): number[] {
  const grants: number[] = Array.from({ length: sizes.length }, () => 0);
  const pending = sizes.map((_, i) => i);
  let remaining = budget;

  while (pending.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / pending.length);
    if (share <= 0) break;

    const satisfied = pending.filter((i) => sizes[i]! <= share);
    if (satisfied.length === 0) {
      // Every file left wants more than its share, so they all get exactly it
      // and the loop is done.
      for (const i of pending) grants[i] = share;
      remaining -= share * pending.length;
      break;
    }
    for (const i of satisfied) {
      grants[i] = sizes[i]!;
      remaining -= sizes[i]!;
    }
    pending.splice(0, pending.length, ...pending.filter((i) => sizes[i]! > share));
  }
  return grants;
}

/**
 * Full text of the docs the Impact Mapper flagged, for the Docs Updater to edit.
 *
 * Every path handed in comes back accounted for - included, truncated, omitted
 * or missing - because the caller has to be able to tell the model which files
 * it may not propose edits against. A file the model is told is impacted but
 * never shown is a file it will invent an anchor for.
 */
export async function readDocExcerpts(
  repoPath: string,
  paths: string[],
): Promise<DocExcerpts> {
  const missing: string[] = [];
  const found: Array<{ path: string; content: string }> = [];

  // Read together, then sorted into found and missing in the order asked,
  // because that is the order the excerpts are rendered in and reported back.
  const contents = await readRepoFiles(repoPath, paths);
  for (const [index, path] of paths.entries()) {
    const content = contents[index] ?? null;
    if (content === null) missing.push(path);
    else found.push({ path, content });
  }

  const grants = allocate(found.map((f) => f.content.length), DOC_EXCERPT_BUDGET);

  const chunks: string[] = [];
  const omitted: string[] = [];
  const truncated: string[] = [];

  for (const [index, file] of found.entries()) {
    const grant = grants[index] ?? 0;

    if (grant < Math.min(file.content.length, MIN_USEFUL_EXCERPT)) {
      omitted.push(file.path);
      continue;
    }

    if (grant >= file.content.length) {
      chunks.push(`===== FILE: ${file.path} (complete) =====\n${file.content}`);
      continue;
    }

    truncated.push(file.path);
    const cut = file.content.length - grant;
    chunks.push(
      `===== FILE: ${file.path} (FIRST ${grant} OF ${file.content.length} CHARACTERS) =====\n` +
        `${file.content.slice(0, grant)}\n` +
        `... [${cut} characters were cut here and you cannot see them. ` +
        `Do not propose an edit anchored anywhere past this point.]`,
    );
  }

  return { text: chunks.join('\n\n'), missing, omitted, truncated };
}
