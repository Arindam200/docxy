import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

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

export async function readRepoFile(repoPath: string, relPath: string): Promise<string | null> {
  try {
    return await readFile(join(repoPath, relPath), 'utf8');
  } catch {
    return null;
  }
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
 * A compact outline of the docs tree: path plus headings. Cheap enough to hand to
 * the Impact Mapper for every commit, and enough for it to name real sections.
 */
export async function buildDocsOutline(
  repoPath: string,
  docsRoots: string[],
): Promise<{ outline: string; paths: string[] }> {
  const paths = await listDocs(repoPath, docsRoots);
  const parts: string[] = [];
  for (const path of paths) {
    const content = await readRepoFile(repoPath, path);
    if (content === null) continue;
    const headings = extractHeadings(content);
    parts.push(
      headings.length > 0
        ? `${path}\n${headings.map((h) => `  ${h}`).join('\n')}`
        : `${path}\n  (no headings)`,
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

  for (const path of paths) {
    const content = await readRepoFile(repoPath, path);
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
