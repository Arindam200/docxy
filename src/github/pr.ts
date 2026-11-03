import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prBaseBranch, type Config } from '../config.js';
import { containedPath } from '../git/repo.js';
import { resolveBaseRef } from '../git/worktree.js';
import type { ChangelogProposal, RunRecord } from '../types.js';
import type { ProposedFile } from '../types.js';
import { insertChangelogEntry } from '../pipeline/apply.js';
import {
  githubFetch,
  githubRepoFromUrl,
  installationToken,
  readAppCredentials,
  scrubToken,
} from './app.js';
import { networkGit } from './checkout.js';

const exec = promisify(execFile);

/**
 * Every local git command here runs with hooks switched off.
 *
 * Publishing checks out a branch and commits model-written text into a
 * repository Docxy does not own. A repository that points `core.hooksPath` at
 * a tracked directory - husky up to v8 does exactly that - would otherwise run
 * its own `pre-commit` and `post-checkout` scripts on this host, scripts any
 * contributor to that repository can edit, with the server's credentials in
 * reach. A bot has no use for hooks, so none run.
 */
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

/**
 * The changelog, carried onto whatever the base branch says now.
 *
 * Not merged line by line like other files: every entry goes in at the top of
 * the Unreleased block, so two entries added since the run read the file sit
 * on exactly the lines this one wants, and a three-way merge calls that a
 * conflict every time. The entry itself is what the run decided, so it is put
 * into the current text the same way it was put into the old one - unless it
 * is already there, as it is after a republish.
 */
export function carryChangelog(
  current: string | null,
  file: ProposedFile,
  changelog: ChangelogProposal,
) {
  if (current === file.before) return { text: file.after };
  // Deleted on the base branch since: start a new one rather than restoring
  // the old one, the same way a run that finds no changelog does.
  if (current === null) return { text: insertChangelogEntry('# Changelog\n', changelog) };
  const entry = changelog.entry.replace(/^[-*]\s*/, '').trim();
  if (current.split('\n').some((line) => line.replace(/^[-*]\s*/, '').trim() === entry)) {
    return { text: current };
  }
  return { text: insertChangelogEntry(current, changelog) };
}

/**
 * Raised when the docs moved under a proposal in a way it cannot be merged
 * into. Distinct from a push failure: retrying cannot help, redrafting can.
 */
export class StaleProposalError extends Error {}

/**
 * The text to commit for one file: the proposal, carried onto whatever the
 * base branch says now.
 *
 * A proposal is a whole file - `before` as it was read, `after` as drafted -
 * and writing `after` over the base tip reverted anything merged into that
 * file since the run read it: a docs fix merged during a slow run, or anything
 * at all before a republish days later. A three-way merge keeps both: the
 * run's change and theirs, as long as they do not touch the same lines. When
 * they do, the proposal is stale, and saying so is better than choosing.
 */
export async function carryOnto(
  scratch: string,
  current: string | null,
  file: ProposedFile,
): Promise<{ text: string } | { conflict: string }> {
  // Untouched since the run read it: the common case, and no merge needed.
  if (current === file.before) return { text: file.after };
  if (current === null) {
    return file.before === ''
      ? { text: file.after }
      : { conflict: 'it was deleted on the base branch after the run read it' };
  }
  // Somebody else already made the same change.
  if (current === file.after) return { text: current };

  const currentPath = join(scratch, 'current');
  const beforePath = join(scratch, 'before');
  const afterPath = join(scratch, 'after');
  await writeFile(currentPath, current, 'utf8');
  await writeFile(beforePath, file.before, 'utf8');
  await writeFile(afterPath, file.after, 'utf8');
  try {
    // `-p` prints the result; the exit status is the number of conflicts.
    const { stdout } = await exec('git', ['merge-file', '-p', currentPath, beforePath, afterPath], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return { text: stdout };
  } catch (err) {
    // The exit status, or NaN for a failure to run at all (`ENOENT` and the like).
    const status = err instanceof Error && 'code' in err ? Number(err.code) : Number.NaN;
    if (Number.isInteger(status) && status > 0) {
      return { conflict: 'it changed on the base branch since the run read it, in the same lines the proposal edits' };
    }
    throw err;
  }
}

/**
 * The remote branch is standing on work docxy did not write.
 *
 * Reported rather than forced past, and distinguished from an ordinary push
 * failure because the answer is different: nothing here is retryable, and the
 * branch needs a human to look at it.
 */
export class BranchConflictError extends Error {}

/**
 * Push over a branch this run published earlier - and only such a branch.
 *
 * `--force-with-lease` needs an expected value, and there is no remote-tracking
 * ref to supply one: the push goes to a tokenized URL minted for this call, not
 * to a configured remote. So the tip is read explicitly, checked for docxy's
 * own authorship, and then leased against exactly what was read. A branch that
 * moves between the read and the push refuses the push rather than resolving
 * the race in our favour.
 */
async function republish(
  worktree: string,
  remote: string,
  branch: string,
  run: RunRecord,
  botEmail: string,
): Promise<void> {
  const listed = await networkGit(worktree, 'ls-remote', [remote, `refs/heads/${branch}`]).catch(() => '');
  const remoteSha = listed.split(/\s+/)[0] ?? '';
  if (!remoteSha) {
    // The branch is gone, or was never the reason for the rejection. Retry
    // plainly; whatever fails now fails with its own message.
    await networkGit(worktree, 'push', [remote, `HEAD:refs/heads/${branch}`]);
    return;
  }

  await networkGit(worktree, 'fetch', ['--no-tags', '--force', remote, `refs/heads/${branch}`]);
  const [committer = '', ...body] = (
    await git(worktree, ['log', '-1', '--format=%ce%n%B', remoteSha])
  ).split('\n');

  // Two things have to hold: the App committed the tip, and the tip says it was
  // drafted from this run's commit. The first rules out a collaborator's push,
  // the second rules out an unrelated docxy branch that collided on the name.
  const ours = committer.trim() === botEmail && body.join('\n').includes(run.commit.sha);
  if (!ours) {
    throw new BranchConflictError(
      `The remote branch "${branch}" carries commits this run did not publish, so ` +
        'pushing over it would destroy them. Nothing was pushed, and the proposal is ' +
        'committed on that branch locally - inspect the remote branch, then delete or ' +
        'rename it if the work on it is finished.',
    );
  }

  await networkGit(worktree, 'push', [
    `--force-with-lease=refs/heads/${branch}:${remoteSha}`,
    remote,
    `HEAD:refs/heads/${branch}`,
  ]);
}

export function buildPrBody(run: RunRecord, concerns: string[] = []): string {
  const lines: string[] = [];
  const c = run.classification;
  const cl = run.changelog;

  // Ahead of everything else, because a draft opened over the pipeline's own
  // objections must not read like a clean proposal.
  if (concerns.length > 0) {
    lines.push('> [!WARNING]', '> **This proposal did not pass the pipeline\'s own checks.**', '>');
    for (const concern of concerns) lines.push(`> - ${concern}`);
    lines.push('>', '> It is opened as a draft so the reasons are visible rather than lost', '> in a failed run. Read it before marking it ready.', '');
  }

  if (run.degraded && run.degraded.length > 0) {
    lines.push('> [!NOTE]', '> **Some agents did not finish, so this proposal is incomplete.**', '>');
    for (const item of run.degraded) lines.push(`> - \`${item.role}\` - ${item.reason}`);
    lines.push('');
  }

  lines.push(`## What changed`, '');
  lines.push(run.approval?.summary ?? c?.summary ?? 'Documentation and changelog update.');
  lines.push('');

  if (c) {
    lines.push('## Classification', '');
    lines.push(`- **Kind:** ${c.kind}`);
    lines.push(`- **Surface:** ${c.surface}`);
    lines.push(`- **Confidence:** ${(c.confidence * 100).toFixed(0)}%`);
    if (c.changedSymbols.length > 0) {
      lines.push(`- **Changed symbols:** ${c.changedSymbols.map((s) => `\`${s}\``).join(', ')}`);
    }
    lines.push(`- **Breaking rationale:** ${c.breakingRationale}`);
    lines.push('');
  }

  if (cl) {
    lines.push('## Changelog', '');
    lines.push(`\`${cl.section}\` - ${cl.entry}`);
    lines.push('');
    lines.push(`Proposed version bump: **${cl.semverBump}** - ${cl.bumpRationale}`);
    lines.push('');
  }

  if (run.validation) {
    lines.push('## Validation', '');
    for (const check of run.validation.checks) {
      const icon = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⏭️';
      lines.push(`- ${icon} **${check.name}** - ${check.detail.split('\n')[0] ?? ''}`);
    }
    lines.push('');
  }

  if (run.docsBranch) {
    lines.push('## Where this lands', '');
    lines.push(
      `Documentation lives on \`${run.docsBranch}\`. These edits were drafted against ` +
        `that branch and this pull request targets it - the code branch is untouched.`,
    );
    lines.push('');
  }

  if (run.approval) {
    lines.push('## Approval', '');
    lines.push(`- **Scope:** ${run.approval.scope} - ${run.approval.scopeRationale}`);
    lines.push(
      `- **Signed off by:** ${run.approval.signoffs.map((s) => s.by).join(', ') || '(none)'}`,
    );
    lines.push('');
  }

  lines.push('---', '');
  lines.push(
    `Opened by [Docxy](https://github.com/) for commit \`${run.commit.shortSha}\` - ` +
      `${run.commit.subject}. Every edit above was drafted by a specialist agent, ` +
      `validated before review, and released only after explicit human sign-off.`,
  );

  return lines.join('\n');
}

export interface PrResult {
  url: string;
  branch: string;
  /** True when the pull request already existed and was reused. */
  existing: boolean;
}

export interface OpenPrOptions {
  /** Open as a draft. Used when the pipeline itself objected to the proposal. */
  draft?: boolean;
  /** Why it is a draft, rendered at the top of the body. */
  concerns?: string[];
}

/**
 * Write the approved proposal to a branch and open a pull request.
 *
 * Runs inside a throwaway git worktree so the user's checkout, index, and
 * current branch are never touched.
 */
export async function openPullRequest(
  config: Config,
  run: RunRecord,
  files: ProposedFile[],
  options: OpenPrOptions = {},
): Promise<PrResult> {
  if (files.length === 0) throw new Error('There is nothing to open a pull request with.');
  if (run.approval?.status !== 'approved') {
    throw new Error('Refusing to open a pull request: the run is not approved.');
  }

  // Nothing downstream can recover from a proposal that changes nothing, and
  // `git commit` would fail with a message about an empty index that says
  // nothing about why. Catch it here where the reason is still known.
  const changed = files.filter((file) => file.after !== file.before);
  if (changed.length === 0) {
    throw new Error(
      'Every proposed file is byte-for-byte identical to what is already committed, ' +
        'so there is nothing to open a pull request with.',
    );
  }

  /**
   * The checkout this run actually read, which is not always the one this
   * process was started in.
   *
   * A run records the repository it documented. Publishing used the *config's*
   * path instead, so approving a webhook-driven run from a terminal sitting in
   * some other repository resolved the branch, the base ref, and the target
   * repository from whatever happened to be in that directory - an installation
   * token request for the wrong repository at best, and a pull request opened
   * against the wrong repository at worst.
   */
  const codePath = run.repoPath || config.repoPath;

  /**
   * And the checkout the *documentation* came from, which is where this goes.
   *
   * A project may keep its docs in a different repository from its code - a
   * docs site, a handbook, one central repository fed by several services. The
   * commit that triggered the run belongs to the code repository; the pull
   * request belongs to the docs one. Branching from the code checkout in that
   * arrangement would open a documentation pull request against the codebase,
   * which is the wrong repository and usually the wrong base branch too.
   */
  const repoPath = run.docsRepoPath || codePath;
  const separateDocsRepo = repoPath !== codePath;

  // Check the remote before doing any work, so a repo with no origin fails with
  // an explanation instead of raw git stderr after a commit already exists.
  try {
    await git(repoPath, ['remote', 'get-url', 'origin']);
  } catch {
    throw new Error(
      `The repository this run documented (${repoPath}) has no "origin" remote, ` +
        'so there is nowhere to push a ' +
        'branch or open a pull request. Add one with `git remote add origin <url>`, ' +
        'or run the pipeline against a repository that has one.',
    );
  }

  // The App is the only way docxy publishes. Pushing through the local
  // credential helper or a personal token would put a human's name on a machine
  // proposal, which is exactly the thing the bot identity exists to prevent -
  // so this fails here rather than silently authoring the PR as whoever ran it.
  const app = readAppCredentials();
  if (!app) {
    throw new Error(
      'The docxy GitHub App is not configured, so there is no identity to open a ' +
        'pull request as. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and ' +
        'GITHUB_APP_INSTALLATION_ID - guides/GITHUB-APP.md walks through registering ' +
        'the App and finding all three.',
    );
  }

  const base = prBaseBranch(config);
  const baseRef = await resolveBaseRef(repoPath, base);

  const branch = `docxy/${run.commit.shortSha}-${run.id.slice(0, 8)}`;

  /**
   * Inferred from the checkout being published for the same reason.
   *
   * `GITHUB_REPOSITORY` still wins where an operator has been explicit - except
   * when the docs are in their own repository, where it cannot: that variable
   * names the *code* repository, and honouring it here would mint a token for
   * one repository and push to another.
   */
  const repo = separateDocsRepo
    ? await inferRepo(repoPath)
    : (config.github.repo ?? (await inferRepo(repoPath)));
  // Asked for here, at the moment it is used. An installation token lives an
  // hour and the approval gate can wait days, so one stored on the run record
  // would be long dead by the time a reviewer signs off.
  const appToken = await installationToken(app, [repoName(repo)]);

  // Made only once nothing that can fail without cleaning up stands between
  // it and the `finally` that removes it: a failed token request used to
  // leave one behind per attempt.
  const worktree = await mkdtemp(join(tmpdir(), 'docxy-wt-'));
  const scratch = await mkdtemp(join(tmpdir(), 'docxy-merge-'));

  try {
    // A worktree left behind by a killed run holds a lock that blocks this one.
    await git(repoPath, ['worktree', 'prune']).catch(() => {});
    // Detached at the resolved tip: the base branch may already be checked out
    // elsewhere, and git refuses to check out one branch in two worktrees.
    await git(repoPath, ['worktree', 'add', '--detach', worktree, baseRef]);
    // `-B`, not `-b`: publishing the same run twice (a retried push, a resumed
    // approval) must land on the same branch rather than failing on a name that
    // is already taken locally.
    await git(worktree, ['checkout', '-B', branch]);

    const conflicts: string[] = [];
    for (const file of changed) {
      const target = await containedPath(worktree, file.path);
      if (!target) throw new Error(`Refusing to write ${JSON.stringify(file.path)}: it is outside the docs repository.`);
      const current = await readFile(target, 'utf8').catch(() => null);
      const carried =
        file.path === config.docs.changelogPath && run.changelog?.entry
          ? carryChangelog(current, file, run.changelog)
          : await carryOnto(scratch, current, file);
      if ('conflict' in carried) {
        conflicts.push(`${file.path}: ${carried.conflict}`);
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, carried.text, 'utf8');
    }
    if (conflicts.length > 0) {
      throw new StaleProposalError(
        `The documentation changed on \`${base}\` after this run drafted its proposal, and the ` +
          'changes overlap, so publishing it would undo them:\n' +
          conflicts.map((line) => `- ${line}`).join('\n') +
          '\nRe-run the commit to draft against the current docs.',
      );
    }

    await git(worktree, ['add', '--', ...changed.map((f) => f.path)]);

    // The base ref may already contain exactly this text - a re-run of a commit
    // whose docs were fixed in the meantime. An empty commit would push a
    // branch with no diff and GitHub would refuse the pull request.
    const staged = await git(worktree, ['diff', '--cached', '--name-only']);
    if (!staged) {
      throw new Error(
        `The proposal matches what \`${base}\` already contains, so the branch would ` +
          'have no changes and there is nothing to open a pull request for.',
      );
    }

    const subject = `docs: update for ${run.commit.shortSha} - ${run.commit.subject}`.slice(0, 100);
    await git(worktree, [
      '-c',
      `user.name=${app.slug}[bot]`,
      '-c',
      `user.email=${app.botEmail}`,
      'commit',
      // Belt and braces with the hooks path above: no hook decides what lands.
      '--no-verify',
      '-m',
      subject,
      '-m',
      `Drafted from commit ${run.commit.sha} and approved by ${
        run.approval.signoffs.map((s) => s.by).join(', ') || 'a reviewer'
      }.`,
    ]);

    // A tokenized remote rather than `origin`, so the push is the App's and not
    // whatever the local credential helper would have supplied.
    const remote = `https://x-access-token:${appToken}@github.com/${repo}.git`;
    try {
      try {
        await networkGit(worktree, 'push', [remote, `HEAD:refs/heads/${branch}`]);
      } catch (first) {
        // The branch already exists with different content, which usually means
        // this run was published before and is being republished. The name
        // encodes this run's id, so an earlier attempt at the same proposal is
        // by far the likeliest thing standing on it - but likeliest is not
        // certain, and an unconditional `--force` answers a collaborator's
        // commits by deleting them.
        const stale =
          first instanceof Error &&
          /non-fast-forward|\brejected\b|already exists/i.test(first.message);
        if (!stale) throw first;
        await republish(worktree, remote, branch, run, app.botEmail);
      }
    } catch (err) {
      // Already precise about what is on the remote and why it was left alone.
      if (err instanceof BranchConflictError) throw err;
      // The token is in the command line, so it is in git's error output too.
      const detail =
        err instanceof Error ? err.message.split('\n').slice(-3).join(' ') : String(err);
      throw new Error(
        scrubToken(
          `Could not push the branch "${branch}". The proposal is committed on ` +
            `that branch locally, so nothing is lost - push it yourself once the ` +
            `remote is reachable.\nGit said: ${detail}`,
        ),
      );
    }

    // The installation token is what makes GitHub attribute the PR to the bot.
    const body = buildPrBody(run, options.concerns ?? []);
    const created = await createPullRequest(repo, appToken, {
      branch,
      title: subject,
      body,
      base,
      draft: options.draft ?? false,
    });
    return { ...created, branch };
  } finally {
    await git(repoPath, ['worktree', 'remove', '--force', worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

interface CreatePrInput {
  branch: string;
  title: string;
  body: string;
  base: string;
  draft: boolean;
}

/**
 * Open the pull request. The token decides the author: an installation token
 * makes it the App, a personal token makes it whoever owns that token.
 *
 * Retried on 5xx and on the secondary rate limit, because the branch is already
 * pushed by this point and losing the pull request to one bad response would
 * mean re-running five agents to get back here.
 */
async function createPullRequest(
  repo: string,
  token: string,
  input: CreatePrInput,
): Promise<{ url: string; existing: boolean }> {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'user-agent': 'docxy',
  };

  let lastDetail = '';
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await githubFetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: 'POST',
      headers,
      // Some plans do not allow drafts; a rejected draft is retried as a normal
      // pull request below rather than lost.
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        head: input.branch,
        base: input.base,
        draft: input.draft,
      }),
    });

    if (res.ok) {
      // SAFETY: the shape of a 2xx from this endpoint is GitHub's published
      // contract, and `html_url` is read as optional with a fallback below.
      const created = (await res.json()) as { html_url?: string };
      return {
        url: created.html_url ?? `https://github.com/${repo}/pulls`,
        existing: false,
      };
    }

    lastDetail = await res.text();

    // 422 is what GitHub returns both for "a pull request already exists for
    // this branch" and for "drafts are not available here". The first is a
    // success in disguise; the second is worth one plain retry.
    if (res.status === 422) {
      const existing = await findOpenPullRequest(repo, token, input.branch, headers);
      if (existing) return { url: existing, existing: true };
      if (input.draft && /draft/i.test(lastDetail)) {
        input = { ...input, draft: false };
        continue;
      }
      break;
    }

    // Nothing about a 401/403/404 improves by asking again.
    if (res.status < 500 && res.status !== 429) break;
    await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
  }

  throw new Error(
    `GitHub refused to open the pull request for "${input.branch}" against ` +
      `"${input.base}". The branch is pushed, so the proposal is not lost - open it ` +
      `by hand at https://github.com/${repo}/compare/${input.base}...${input.branch}\n` +
      `GitHub said: ${lastDetail}`,
  );
}

/** The open pull request for a branch, when one already exists. */
async function findOpenPullRequest(
  repo: string,
  token: string,
  branch: string,
  headers: Record<string, string>,
): Promise<string | null> {
  const owner = repo.split('/')[0];
  const res = await githubFetch(
    `https://api.github.com/repos/${repo}/pulls?state=open&head=${owner}:${branch}`,
    { headers },
  );
  if (!res.ok) return null;
  // SAFETY: a 2xx from the pulls listing is an array; every field below is read
  // as optional and the empty case falls through to null.
  const list = (await res.json()) as Array<{ html_url?: string }>;
  return list[0]?.html_url ?? null;
}

/** The `name` half of `owner/name`, which is what the token endpoint wants. */
function repoName(repo: string): string {
  const name = repo.split('/')[1];
  if (!name) throw new Error(`Expected a repository as "owner/name", got "${repo}".`);
  return name;
}

async function inferRepo(repoPath: string): Promise<string> {
  const url = await git(repoPath, ['remote', 'get-url', 'origin']);
  const repo = githubRepoFromUrl(url);
  if (!repo) throw new Error(`Cannot infer the GitHub repository from origin: ${url}`);
  return repo;
}
