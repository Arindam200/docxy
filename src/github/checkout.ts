import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, stat } from 'node:fs/promises';
import {
  githubRepoFromUrl,
  forgetInstallationToken,
  githubFetch,
  installationToken,
  readAppCredentials,
  scrubToken,
  type AppCredentials,
} from './app.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  // Hooks off: checking out a branch runs `post-checkout`, and in a repository
  // whose hooks are tracked files that is anyone's code. See `github/pr.ts`.
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** The git commands that leave the machine. */
export type NetworkOp = 'clone' | 'fetch' | 'push' | 'ls-remote';

/**
 * How long each of them may take before it is stopped.
 *
 * Generous, because a first clone of a large repository is honestly slow, and
 * finite, because none of these ran under any deadline at all. Syncing a
 * checkout happens before a run's budget starts, inside the queue that keeps
 * one repository's runs in order - so one fetch stalled on a half-open socket
 * held that repository's queue shut until the process restarted, and every
 * push after it waited behind a run that was never going to begin.
 */
const NETWORK_TIMEOUT_MS = {
  clone: 10 * 60 * 1000,
  fetch: 5 * 60 * 1000,
  push: 3 * 60 * 1000,
  'ls-remote': 60 * 1000,
} satisfies Record<NetworkOp, number>;

/**
 * The environment a network git command runs in.
 *
 * The low-speed pair is curl's own stall detector: a transfer that moves
 * nothing for a minute is abandoned by git itself, long before the overall
 * timeout would kill it, and with an error that says why. The floor is one
 * byte a second rather than anything higher on purpose - a large repository's
 * first clone can sit for minutes while GitHub prepares the pack, trickling
 * only progress lines, and that is slow, not stalled. The per-operation
 * timeout above is what bounds slow. An operator
 * who has set either one already keeps their value. The terminal prompt is
 * switched off unconditionally, because a credential git cannot find is
 * otherwise asked for on whatever terminal the process inherited - which on a
 * laptop is a wait nobody is watching, and is not a stall curl can see.
 */
function networkEnv(): NodeJS.ProcessEnv {
  return {
    GIT_HTTP_LOW_SPEED_LIMIT: '1',
    GIT_HTTP_LOW_SPEED_TIME: '60',
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
  };
}

/**
 * Run a git command that talks to a remote, bounded in time.
 *
 * Every error leaves here with any tokenized URL scrubbed out of it, and with
 * its stderr otherwise intact: callers read git's own words to tell a rejected
 * push from an unreachable remote. A timeout says it was one on its last line,
 * which is the line every caller quotes. And an authentication failure evicts
 * the token it was made with, because a cached token GitHub has stopped
 * accepting would otherwise be handed straight back to the next attempt.
 */
export async function networkGit(cwd: string, op: NetworkOp, args: string[]): Promise<string> {
  const timeout = NETWORK_TIMEOUT_MS[op];
  const started = Date.now();
  const { args: plainArgs, tokens } = withoutUrlTokens(args);
  try {
    const { stdout } = await exec('git', [op, ...plainArgs], {
      cwd,
      timeout,
      env: withAuthHeader(networkEnv(), tokens[0]),
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (cause) {
    const message = (cause instanceof Error ? cause.message : String(cause)).trimEnd();

    if (/Authentication failed|returned error: 401|Invalid username or (?:password|token)/i.test(message)) {
      for (const token of tokens) forgetInstallationToken(token);
    }

    // `execFile` reports a command it killed for overrunning as a plain
    // failure; `killed` plus the clock is the only sign it was the timeout.
    const killed = cause instanceof Error && 'killed' in cause && cause.killed === true;
    const seconds = Math.round(timeout / 1000);
    const verdict =
      killed && Date.now() - started >= timeout
        ? `\ngit ${op} timed out after ${seconds} seconds and was stopped.`
        : /curl 28|Operation too slow|Operation timed out/i.test(message)
          ? `\ngit ${op} timed out: the transfer stalled and was abandoned.`
          : '';
    throw new Error(scrubToken(`${message}${verdict}`));
  }
}

const URL_TOKEN = /^https:\/\/x-access-token:([^@/]+)@github\.com\//;

/**
 * Take installation tokens out of the command line.
 *
 * Callers still hand `networkGit` a tokenized URL - it is the one string that
 * says "this remote, as the App" - but git is never shown it. A credential in
 * the URL is one git *approves* after a successful request, which hands it to
 * every configured credential helper: on a host with `store` or `osxkeychain`
 * each installation token was written to disk. And the command line is what
 * `ps` shows every user on the machine.
 */
export function withoutUrlTokens(args: string[]) {
  const tokens: string[] = [];
  const plain = args.map((arg) => {
    const token = URL_TOKEN.exec(arg)?.[1];
    if (!token) return arg;
    tokens.push(token);
    return arg.replace(URL_TOKEN, 'https://github.com/');
  });
  return { args: plain, tokens };
}

/**
 * Authenticate to GitHub with a header that only this process's git sees.
 *
 * Passed through git's environment config rather than `-c`, because `-c`
 * values are on the command line too. In order: any extra header a checkout
 * already carries for GitHub is cleared (an `actions/checkout` working tree
 * leaves one, and two Authorization headers make GitHub answer 400), the App's
 * is set, and the credential helpers are emptied so nothing is stored and
 * nothing a helper remembers is offered in its place.
 */
export function withAuthHeader(env: NodeJS.ProcessEnv, token: string | undefined): NodeJS.ProcessEnv {
  if (!token) return env;
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const entries: Array<[string, string]> = [
    ['http.https://github.com/.extraheader', ''],
    ['http.https://github.com/.extraheader', header],
    ['credential.helper', ''],
  ];
  const next = { ...env };
  const start = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0;
  entries.forEach(([key, value], index) => {
    next[`GIT_CONFIG_KEY_${start + index}`] = key;
    next[`GIT_CONFIG_VALUE_${start + index}`] = value;
  });
  next.GIT_CONFIG_COUNT = String(start + entries.length);
  return next;
}

/** A remote URL that authenticates as the App. Pass it per command; never store it. */
function tokenizedRemote(repo: string, token: string): string {
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/**
 * Where to fetch a checkout's branches from.
 *
 * `origin` on a managed checkout is the plain URL - `ensureCheckout` puts it
 * back that way so no credential is left on disk - so `git fetch origin` on a
 * private repository has nothing to authenticate with. It failed, the failure
 * was swallowed as "the network is down", and a configured docs branch was
 * read from wherever the first clone had left it: stale on every run after
 * that, or missing outright where only the remote-tracking ref existed.
 *
 * So a GitHub origin is fetched the way the code checkout is synced, through
 * an installation token in a URL passed to the one command. Git keeps that URL
 * out of `FETCH_HEAD` and the reflog; it never reaches `.git/config`. Anything
 * the App cannot reach - not configured, not installed there, not GitHub -
 * falls back to `origin` and whatever credentials the machine has for it.
 */
export async function fetchSource(repoPath: string): Promise<string> {
  const origin = await git(repoPath, ['remote', 'get-url', 'origin']).catch(() => '');
  const repo = githubRepoFromUrl(origin);
  if (!repo) return 'origin';
  try {
    const credentials = readAppCredentials();
    if (!credentials) return 'origin';
    return tokenizedRemote(repo, await installationToken(credentials, [repoName(repo)]));
  } catch {
    return 'origin';
  }
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
 * This is the authority on what docxy documents. The alternative - a local path
 * in configuration - has to be kept in step with the install screen by hand,
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
  // it did not fail - they were absent, from `syncedRepoPaths`, from the
  // dashboard's list, and from the scope `docxy publish <short-id>` searches.
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
    // SAFETY: the predicate below is the parse - an entry reaches `map` only
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
 * The configured path is always included - a developer pointing
 * `DOCXY_REPO_PATH` at a working tree is still using docxy - and so is the
 * managed checkout of each repository the App is installed on, because that is
 * where a webhook-driven run actually happened.
 *
 * Shared with the CLI rather than living in the server, because they were
 * drifting: the dashboard listed runs across every synced repository while
 * `docxy publish <short-id>` searched only the directory it was invoked from,
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
 * already happens to have. A commit authored anywhere else - the GitHub web
 * editor, another clone, a colleague's machine - does not resolve, and the run
 * dies before the first role starts, invisibly, because the delivery was
 * already answered 200.
 *
 * Cloned and fetched with an installation token rather than the machine's
 * credential helper: a server documenting a repository it was installed on has
 * no personal credentials for it and should not need any. The token is never
 * written to disk - `origin` is set to the plain URL and the tokenized one is
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
        'GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID. A webhook only ' +
        'arrives at a deployment, so the key belongs in the environment as the PEM ' +
        'itself rather than as GITHUB_APP_PRIVATE_KEY_PATH, which names a file no ' +
        'managed platform gives you anywhere to put.',
    );
  }

  const path = targetPath ?? checkoutPathFor(repo);

  // An operator-supplied checkout is never assumed to be the right project:
  // documenting the wrong repository is worse than refusing, because the diff
  // is read from one codebase and the docs edited in another.
  if (targetPath) {
    const origin = await git(targetPath, ['remote', 'get-url', 'origin']).catch(() => '');
    const originRepo = githubRepoFromUrl(origin);
    if (originRepo && originRepo.toLowerCase() !== repo.toLowerCase()) {
      throw new Error(
        `A push to ${repo} arrived, but DOCXY_REPO_PATH points at ${targetPath}, ` +
          `which is a checkout of ${originRepo}. Unset DOCXY_REPO_PATH to let docxy ` +
          `manage its own checkout, or point it at ${repo}.`,
      );
    }
  }

  const name = repoName(repo);
  const plain = `https://github.com/${repo}.git`;
  const failed = (detail: string): Error =>
    new Error(
      scrubToken(
        `Could not sync ${repo}@${branch} into ${path}. Git said: ${detail.split('\n').slice(-3).join(' ')}`,
      ),
    );

  if (!(await exists(join(path, '.git')))) {
    const token = await installationToken(credentials, [name]);
    try {
      await mkdir(join(homedir(), '.docxy', 'checkouts'), { recursive: true });
      await networkGit(process.cwd(), 'clone', ['--quiet', tokenizedRemote(repo, token), path]);
      // `networkGit` clones from the plain URL, so this is already what
      // `origin` says; set anyway, so no credential can be on disk whatever
      // the clone was given.
      await git(path, ['remote', 'set-url', 'origin', plain]);
    } catch (cause) {
      throw failed(cause instanceof Error ? cause.message : String(cause));
    }
  }

  // Asked for again rather than reused from the clone: a first clone of a large
  // repository can outlast the margin a cached token is handed out with, and
  // the fetch starts a request of its own.
  const token = await installationToken(credentials, [name]);
  try {
    await networkGit(path, 'fetch', [
      '--no-tags',
      tokenizedRemote(repo, token),
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ]);
  } catch (cause) {
    throw failed(cause instanceof Error ? cause.message : String(cause));
  }

  // Keep the working tree on the branch tip so the pipeline reads the same
  // state a human would see when opening the repository.
  //
  // Only in a checkout docxy manages. A pinned one is the operator's own
  // working tree, documented as used as-is, and a forced checkout over it threw
  // away whatever they had not committed and moved them off their branch every
  // time a push arrived. The fetch above is all the run needs from it: the diff
  // is read by commit, which the check below proves is present.
  if (!targetPath) {
    await git(path, ['checkout', '--quiet', '--force', '-B', branch, `refs/remotes/origin/${branch}`]);
  }

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
