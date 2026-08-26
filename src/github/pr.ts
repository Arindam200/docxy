import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prBaseBranch, type Config } from '../config.js';
import { resolveBaseRef } from '../git/worktree.js';
import type { RunRecord } from '../types.js';
import type { ProposedFile } from '../types.js';
import { installationToken, readAppCredentials, scrubToken } from './app.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
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
    for (const item of run.degraded) lines.push(`> - \`${item.role}\` — ${item.reason}`);
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
    lines.push(`\`${cl.section}\` — ${cl.entry}`);
    lines.push('');
    lines.push(`Proposed version bump: **${cl.semverBump}** — ${cl.bumpRationale}`);
    lines.push('');
  }

  if (run.validation) {
    lines.push('## Validation', '');
    for (const check of run.validation.checks) {
      const icon = check.status === 'pass' ? '✅' : check.status === 'fail' ? '❌' : '⏭️';
      lines.push(`- ${icon} **${check.name}** — ${check.detail.split('\n')[0] ?? ''}`);
    }
    lines.push('');
  }

  if (run.docsBranch) {
    lines.push('## Where this lands', '');
    lines.push(
      `Documentation lives on \`${run.docsBranch}\`. These edits were drafted against ` +
        `that branch and this pull request targets it — the code branch is untouched.`,
    );
    lines.push('');
  }

  if (run.approval) {
    lines.push('## Approval', '');
    lines.push(`- **Scope:** ${run.approval.scope} — ${run.approval.scopeRationale}`);
    lines.push(
      `- **Signed off by:** ${run.approval.signoffs.map((s) => s.by).join(', ') || '(none)'}`,
    );
    lines.push('');
  }

  lines.push('---', '');
  lines.push(
    `Opened by [Docxy](https://github.com/) for commit \`${run.commit.shortSha}\` — ` +
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

  // Check the remote before doing any work, so a repo with no origin fails with
  // an explanation instead of raw git stderr after a commit already exists.
  try {
    await git(config.repoPath, ['remote', 'get-url', 'origin']);
  } catch {
    throw new Error(
      'This repository has no "origin" remote, so there is nowhere to push a ' +
        'branch or open a pull request. Add one with `git remote add origin <url>`, ' +
        'or run the pipeline against a repository that has one.',
    );
  }

  // The App is the only way docxy publishes. Pushing through the local
  // credential helper or a personal token would put a human's name on a machine
  // proposal, which is exactly the thing the bot identity exists to prevent —
  // so this fails here rather than silently authoring the PR as whoever ran it.
  const app = readAppCredentials();
  if (!app) {
    throw new Error(
      'The docxy GitHub App is not configured, so there is no identity to open a ' +
        'pull request as. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, and ' +
        'GITHUB_APP_INSTALLATION_ID — guides/GITHUB-APP.md walks through registering ' +
        'the App and finding all three.',
    );
  }

  const base = prBaseBranch(config);
  const baseRef = await resolveBaseRef(config.repoPath, base);

  const branch = `docxy/${run.commit.shortSha}-${run.id.slice(0, 8)}`;
  const worktree = await mkdtemp(join(tmpdir(), 'docxy-wt-'));

  const repo = config.github.repo ?? (await inferRepo(config.repoPath));
  // Minted here, at the moment it is used. An installation token lives an hour
  // and the approval gate can wait days, so one stored on the run record would
  // be long dead by the time a reviewer signs off.
  const appToken = await installationToken(app, [repoName(repo)]);

  try {
    // A worktree left behind by a killed run holds a lock that blocks this one.
    await git(config.repoPath, ['worktree', 'prune']).catch(() => {});
    // Detached at the resolved tip: the base branch may already be checked out
    // elsewhere, and git refuses to check out one branch in two worktrees.
    await git(config.repoPath, ['worktree', 'add', '--detach', worktree, baseRef]);
    // `-B`, not `-b`: publishing the same run twice (a retried push, a resumed
    // approval) must land on the same branch rather than failing on a name that
    // is already taken locally.
    await git(worktree, ['checkout', '-B', branch]);

    for (const file of changed) {
      const target = join(worktree, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.after, 'utf8');
    }

    await git(worktree, ['add', '--', ...changed.map((f) => f.path)]);

    // The base ref may already contain exactly this text — a re-run of a commit
    // whose docs were fixed in the meantime. An empty commit would push a
    // branch with no diff and GitHub would refuse the pull request.
    const staged = await git(worktree, ['diff', '--cached', '--name-only']);
    if (!staged) {
      throw new Error(
        `The proposal matches what \`${base}\` already contains, so the branch would ` +
          'have no changes and there is nothing to open a pull request for.',
      );
    }

    const subject = `docs: update for ${run.commit.shortSha} — ${run.commit.subject}`.slice(0, 100);
    await git(worktree, [
      '-c',
      `user.name=${app.slug}[bot]`,
      '-c',
      `user.email=${app.botEmail}`,
      'commit',
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
        await git(worktree, ['push', remote, `HEAD:refs/heads/${branch}`]);
      } catch (first) {
        // The branch already exists with different content, which means this
        // run was published before and is being republished. The name encodes
        // this run's id, so nothing but an earlier attempt at the same proposal
        // can be standing on it.
        const stale =
          first instanceof Error &&
          /non-fast-forward|\brejected\b|already exists/i.test(first.message);
        if (!stale) throw first;
        await git(worktree, ['push', '--force', remote, `HEAD:refs/heads/${branch}`]);
      }
    } catch (err) {
      // The token is in the command line, so it is in git's error output too.
      const detail =
        err instanceof Error ? err.message.split('\n').slice(-3).join(' ') : String(err);
      throw new Error(
        scrubToken(
          `Could not push the branch "${branch}". The proposal is committed on ` +
            `that branch locally, so nothing is lost — push it yourself once the ` +
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
    await git(config.repoPath, ['worktree', 'remove', '--force', worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
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
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
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
      `"${input.base}". The branch is pushed, so the proposal is not lost — open it ` +
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
  const res = await fetch(
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
  const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url);
  if (!m?.[1]) throw new Error(`Cannot infer the GitHub repository from origin: ${url}`);
  return m[1];
}
