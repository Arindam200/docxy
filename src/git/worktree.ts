import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../config.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function refExists(repoPath: string, ref: string): Promise<boolean> {
  try {
    await git(repoPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

async function hasOrigin(repoPath: string): Promise<boolean> {
  try {
    await git(repoPath, ['remote', 'get-url', 'origin']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The tree documentation is read from and written to.
 *
 * When docs live on their own branch this is a throwaway detached worktree at
 * that branch's tip; when they live alongside the code it is just the code
 * checkout. Either way the rest of the pipeline treats it as "the place docs
 * are", so no caller needs to know which case it is in.
 */
export interface DocsTree {
  /** Absolute path to read docs from and stage proposed edits into. */
  path: string;
  /** Branch the tree is checked out at, or null when it is the code checkout. */
  branch: string | null;
  /** Commit the tree is at, or null when it is the code checkout. */
  head: string | null;
  /** True when this is a throwaway worktree rather than the user's checkout. */
  disposable: boolean;
  dispose: () => Promise<void>;
}

/**
 * Materialize the documentation tree.
 *
 * The docs branch is checked out **detached** at its remote-tracking tip rather
 * than as a branch: a branch cannot be checked out in two worktrees at once, and
 * detaching means running this against a repo that already has the docs branch
 * checked out somewhere else still works.
 */
export async function openDocsTree(config: Config): Promise<DocsTree> {
  const branch = config.docs.branch.trim();

  if (!branch) {
    return {
      path: config.repoPath,
      branch: null,
      head: null,
      disposable: false,
      dispose: async () => {},
    };
  }

  const repo = config.repoPath;

  // Prefer the remote tip so a stale local branch never silently wins. Falls back
  // to the local branch when there is no origin (local-only repos, tests).
  let ref = `refs/heads/${branch}`;
  if (await hasOrigin(repo)) {
    try {
      await git(repo, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
      ref = `refs/remotes/origin/${branch}`;
    } catch {
      // Remote does not have it (or the network is down) — try the local branch.
    }
  }

  if (!(await refExists(repo, ref))) {
    throw new Error(
      `The documentation branch "${branch}" does not exist.\n` +
        `docxy reads docs from that branch and opens its pull requests against it, ` +
        `so it has to exist before a run.\n` +
        `Create it with:  git switch --orphan ${branch} && git commit --allow-empty -m "start docs" && git push -u origin ${branch}\n` +
        `Or unset DOCXY_DOCS_BRANCH to keep docs in the code checkout.`,
    );
  }

  // A worktree left behind by a killed run would block `worktree add`.
  await git(repo, ['worktree', 'prune']).catch(() => {});

  const path = await mkdtemp(join(tmpdir(), 'docxy-docs-'));
  try {
    await git(repo, ['worktree', 'add', '--detach', path, ref]);
  } catch (err) {
    await rm(path, { recursive: true, force: true }).catch(() => {});
    throw new Error(
      `Could not check out the documentation branch "${branch}" into a worktree.\n` +
        `Git said: ${err instanceof Error ? err.message.split('\n').slice(-3).join(' ') : String(err)}`,
    );
  }

  const head = await git(path, ['rev-parse', 'HEAD']);

  return {
    path,
    branch,
    head,
    disposable: true,
    dispose: async () => {
      await git(repo, ['worktree', 'remove', '--force', path]).catch(() => {});
      await rm(path, { recursive: true, force: true }).catch(() => {});
    },
  };
}

/**
 * Resolve the ref a pull request should branch from, preferring the remote tip.
 * Kept next to `openDocsTree` so both agree on where the docs branch actually is.
 */
export async function resolveBaseRef(repoPath: string, branch: string): Promise<string> {
  if (await hasOrigin(repoPath)) {
    try {
      await git(repoPath, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    } catch {
      // fall through to whatever exists locally
    }
    if (await refExists(repoPath, `refs/remotes/origin/${branch}`)) {
      return `refs/remotes/origin/${branch}`;
    }
  }
  if (await refExists(repoPath, `refs/heads/${branch}`)) return `refs/heads/${branch}`;
  throw new Error(
    `The base branch "${branch}" does not exist locally or on origin, so there is ` +
      `nothing to open a pull request against.`,
  );
}
