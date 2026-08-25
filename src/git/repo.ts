import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative, extname, sep } from 'node:path';

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.turbo', '.cache', 'vendor', '__pycache__', '.venv', 'target',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.txt', '.adoc']);

/** Cap on how much of a doc is inlined into a prompt. */
const DOC_EXCERPT_BUDGET = 20_000;

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

/** Full text of the docs the Impact Mapper flagged, for the Docs Updater to edit. */
export async function readDocExcerpts(
  repoPath: string,
  paths: string[],
): Promise<{ text: string; missing: string[] }> {
  const chunks: string[] = [];
  const missing: string[] = [];
  let budget = DOC_EXCERPT_BUDGET;

  for (const path of paths) {
    const content = await readRepoFile(repoPath, path);
    if (content === null) {
      missing.push(path);
      continue;
    }
    const slice = content.length > budget ? content.slice(0, Math.max(budget, 0)) : content;
    budget -= slice.length;
    chunks.push(
      `===== FILE: ${path} =====\n${slice}${
        slice.length < content.length ? '\n... [truncated]' : ''
      }`,
    );
    if (budget <= 0) break;
  }
  return { text: chunks.join('\n\n'), missing };
}
