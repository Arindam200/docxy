import { existsSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import type { ProposedFile } from '../pipeline/apply.js';

export interface BrokenLink {
  file: string;
  target: string;
  reason: string;
}

/** Slugify a heading the way GitHub does, so in-page anchors can be checked. */
function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of markdown.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m?.[1]) slugs.add(slug(m[1]));
  }
  return slugs;
}

/**
 * Check every markdown link in the proposed text. Relative file links must
 * resolve on disk (or against another proposed file); in-page anchors must match
 * a heading. External URLs are not fetched — this runs on every commit and must
 * not depend on the network.
 */
export function checkLinks(docsPath: string, files: ProposedFile[]): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const proposedByPath = new Map(files.map((f) => [f.path, f.after]));

  for (const file of files) {
    const slugs = headingSlugs(file.after);
    const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

    for (const match of file.after.matchAll(linkPattern)) {
      const target = match[1];
      if (!target) continue;
      if (/^(https?:|mailto:|tel:|#\/)/i.test(target)) continue;

      if (target.startsWith('#')) {
        const anchor = target.slice(1).toLowerCase();
        if (anchor && !slugs.has(anchor)) {
          broken.push({
            file: file.path,
            target,
            reason: 'in-page anchor does not match any heading in the proposed text',
          });
        }
        continue;
      }

      const [pathPart = '', anchorPart] = target.split('#');
      if (!pathPart) continue;

      const resolved = normalize(join(dirname(file.path), pathPart)).split('\\').join('/');
      const proposed = proposedByPath.get(resolved);

      if (proposed === undefined && !existsSync(join(docsPath, resolved))) {
        broken.push({ file: file.path, target, reason: `relative link target does not exist (${resolved})` });
        continue;
      }

      if (anchorPart && proposed !== undefined) {
        if (!headingSlugs(proposed).has(anchorPart.toLowerCase())) {
          broken.push({
            file: file.path,
            target,
            reason: `anchor "#${anchorPart}" does not match a heading in ${resolved}`,
          });
        }
      }
    }
  }

  return broken;
}
