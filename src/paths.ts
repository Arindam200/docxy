import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Walk up from this module to the package root, so `src/` and `dist/` both work. */
function findPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

export const PACKAGE_ROOT = findPackageRoot();
export const SKILLS_DIR = join(PACKAGE_ROOT, 'skills');

/** Read a skill pack, stripping YAML frontmatter — the body is the instruction text. */
export function readSkillPack(name: string): string {
  const file = join(SKILLS_DIR, name, 'SKILL.md');
  if (!existsSync(file)) {
    throw new Error(`Skill pack "${name}" not found at ${file}`);
  }
  const raw = readFileSync(file, 'utf8');
  const match = /^---\n[\s\S]*?\n---\n?/.exec(raw);
  return (match ? raw.slice(match[0].length) : raw).trim();
}
