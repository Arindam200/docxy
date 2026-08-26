import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import {
  githubFetch,
  installationToken,
  readAppCredentials,
  scrubToken,
  type AppCredentials,
} from './app.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** The `name` half of `owner/name`, which is what the token endpoint wants. */
function repoName(repo: string): string {
  const name = repo.split('/')[1];
  if (!name) throw new Error(`Expected a repository as "owner/name", got "${repo}".`);
  return name;
}

export interface InstalledRepo {
  fullName: string;
  defaultBranch: string;
}

/**
 * The repositories this installation can see.
 *
 * This is the authority on what docxy documents. The alternative — a local path
 * in configuration — has to be kept in step with the install screen by hand,
 * and silently documents the wrong project when it drifts.
 */
export async function installationRepositories(
  credentials: AppCredentials,
): Promise<InstalledRepo[]> {
  const token = await installationToken(credentials, []);
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'user-agent': 'docxy',
  };

  const found: InstalledRepo[] = [];
  // Paginated, because the first page is not the answer. A hundred repositories
  // sounds like plenty until an installation is account-wide, and the ones past
  // it did not fail — they were absent, from `syncedRepoPaths`, from the
  // dashboard's list, and from the scope `docxy approve <short-id>` searches.
  // Bounded so a malformed `Link` header cannot loop forever.
  let url: string | null = 'https://api.github.com/installation/repositories?per_page=100';
  for (let page = 0; url && page < 50; page += 1) {
    const response: Response = await githubFetch(url, { headers });
    if (!response.ok) {
      throw new Error(
        `Could not list the installation's repositories (HTTP ${response.status}): ${await response.text()}`,
      );
    }
    // SAFETY: a 2xx from this endpoint is GitHub's published shape, and every
    // field below is declared optional and proven present by the filter.
    const body = (await response.json()) as {
      repositories?: Array<{ full_name?: string; default_branch?: string }>;
    };
    // SAFETY: the predicate below is the parse — an entry reaches `map` only
    // once both of the fields it reads have been proven present.
    for (const repo of body.repositories ?? []) {
      if (!repo.full_name || !repo.default_branch) continue;
      found.push({ fullName: repo.full_name, defaultBranch: repo.default_branch });
    }
    url = nextPage(response.headers.get('link'));
  }

  return found;
}

/**
 * The `rel="next"` URL from a `Link` header, or null at the last page.
 *
 * GitHub's own pagination contract: following the header is the documented way
 * to walk it, and computing page numbers instead drifts the moment the listing
 * changes underneath.
 */
export function nextPage(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
    if (match?.[1]) return match[1];
  }
  return null;
}

/**
 * Where a repository's managed checkout lives.
 *
 * Outside any repository and stable across runs: sessions and the symbol map
 * key on this path, so a fresh temp directory per run would silently start
 * every commit from cold memory.
 */
export function checkoutPathFor(repo: string): string {
  return join(homedir(), '.docxy', 'checkouts', repo.replace('/', '__'));
}

/**
 * Every repository path whose runs belong to this deployment.
 *
 * The configured path is always included — a developer pointing
 * `DOCXY_REPO_PATH` at a working tree is still using docxy — and so is the
 * managed checkout of each repository the App is installed on, because that is
 * where a webhook-driven run actually happened.
 *
 * Shared with the CLI rather than living in the server, because they were
 * drifting: the dashboard listed runs across every synced repository while
 * `docxy approve <short-id>` searched only the directory it was invoked from,
 * so a run the dashboard showed could not be found by the command the
 * dashboard told you to run.
 *
 * Degrades to the local path alone. An unreachable GitHub should narrow what
 * can be listed, never fail the listing.
 */
export async function syncedRepoPaths(repoPath: string): Promise<string[]> {
  try {
    const credentials = readAppCredentials();
    if (!credentials) return [repoPath];
    const installed = await installationRepositories(credentials);
    return [...new Set([repoPath, ...installed.map((repo) => checkoutPathFor(repo.fullName))])];
  } catch {
    return [repoPath];
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch(() => false);
}

/**
 * Make sure a checkout of `repo` exists locally and contains `sha`.
 *
 * A webhook carries a SHA, not the objects behind it, and nothing downstream
 * fetches: `resolveCommit` runs `git rev-parse` against whatever the checkout
 * already happens to have. A commit authored anywhere else — the GitHub web
 * editor, another clone, a colleague's machine — does not resolve, and the run
 * dies before the first role starts, invisibly, because the delivery was
 * already answered 200.
 *
 * Cloned and fetched with an installation token rather than the machine's
 * credential helper: a server documenting a repository it was installed on has
 * no personal credentials for it and should not need any. The token is never
 * written to disk — `origin` is set to the plain URL and the tokenized one is
 * passed per command.
 */
export async function ensureCheckout(
  repo: string,
  branch: string,
  sha?: string,
  targetPath?: string,
): Promise<string> {
  const credentials = readAppCredentials();
  if (!credentials) {
    throw new Error(
      'A push webhook arrived but the GitHub App is not configured, so there is no ' +
        'way to fetch the commit it refers to. Set GITHUB_APP_ID, ' +
        'GITHUB_APP_PRIVATE_KEY_PATH, and GITHUB_APP_INSTALLATION_ID.',
    );
  }

  const path = targetPath ?? checkoutPathFor(repo);

  // An operator-supplied checkout is never assumed to be the right project:
  // documenting the wrong repository is worse than refusing, because the diff
  // is read from one codebase and the docs edited in another.
  if (targetPath) {
    const origin = await git(targetPath, ['remote', 'get-url', 'origin']).catch(() => '');
    const originRepo = /github\.com[:/]([^/]+\/[^/.]+)/.exec(origin)?.[1];
    if (originRepo && originRepo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(
        `A push to ${repo} arrived, but DOCXY_REPO_PATH points at ${targetPath}, ` +
          `which is a checkout of ${originRepo}. Unset DOCXY_REPO_PATH to let docxy ` +
          `manage its own checkout, or point it at ${repo}.`,
      );
    }
  }

  const token = await installationToken(credentials, [repoName(repo)]);
  const authed = `https://x-access-token:${token}@github.com/${repo}.git`;
  const plain = `https://github.com/${repo}.git`;

  try {
    if (!(await exists(join(path, '.git')))) {
      await mkdir(join(homedir(), '.docxy', 'checkouts'), { recursive: true });
      await exec('git', ['clone', '--quiet', authed, path], { maxBuffer: 64 * 1024 * 1024 });
      // Never leave a credential on disk; the token is short-lived anyway.
      await git(path, ['remote', 'set-url', 'origin', plain]);
    }

    await git(path, [
      'fetch',
      '--no-tags',
      authed,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
  } catch (cause) {
    const detail =
      cause instanceof Error ? cause.message.split('\n').slice(-3).join(' ') : String(cause);
    throw new Error(scrubToken(`Could not sync ${repo}@${branch} into ${path}. Git said: ${detail}`));
  }

  // Keep the working tree on the branch tip so the pipeline reads the same
  // state a human would see when opening the repository.
  await git(path, ['checkout', '--quiet', '--force', '-B', branch, `refs/remotes/origin/${branch}`]);

  // Prove the object arrived, so a failure names the commit rather than
  // surfacing later as an opaque rev-parse error mid-pipeline. Skipped at
  // startup, where there is no particular commit in view yet.
  if (!sha) return path;
  try {
    await git(path, ['cat-file', '-e', `${sha}^{commit}`]);
  } catch {
    throw new Error(
      `Synced ${repo}@${branch}, but commit ${sha.slice(0, 7)} is still missing from ` +
        `${path}. It may have been force-pushed away before the run started.`,
    );
  }

  return path;
}
