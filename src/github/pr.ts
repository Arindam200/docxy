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

export function buildPrBody(run: RunRecord): string {
  const lines: string[] = [];
  const c = run.classification;
  const cl = run.changelog;

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
): Promise<PrResult> {
  if (files.length === 0) throw new Error('There is nothing to open a pull request with.');
  if (run.approval?.status !== 'approved') {
    throw new Error('Refusing to open a pull request: the run is not approved.');
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
    // Detached at the resolved tip: the base branch may already be checked out
    // elsewhere, and git refuses to check out one branch in two worktrees.
    await git(config.repoPath, ['worktree', 'add', '--detach', worktree, baseRef]);
    await git(worktree, ['checkout', '-b', branch]);

    for (const file of files) {
      const target = join(worktree, file.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.after, 'utf8');
    }

    await git(worktree, ['add', '--', ...files.map((f) => f.path)]);

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

    try {
      // A tokenized remote rather than `origin`, so the push is the App's and
      // not whatever the local credential helper would have supplied.
      await git(worktree, [
        'push',
        `https://x-access-token:${appToken}@github.com/${repo}.git`,
        `HEAD:refs/heads/${branch}`,
      ]);
    } catch (err) {
      // The token is in the command line, so it is in git's error output too.
      const detail = err instanceof Error ? err.message.split('\n').slice(-3).join(' ') : String(err);
      throw new Error(
        scrubToken(
          `Could not push the branch "${branch}". The proposal is committed on ` +
            `that branch locally, so nothing is lost — push it yourself once the ` +
            `remote is reachable.\nGit said: ${detail}`,
        ),
      );
    }

    // The installation token is what makes GitHub attribute the PR to the bot.
    const body = buildPrBody(run);
    return {
      url: await createPullRequest(repo, appToken, branch, subject, body, base),
      branch,
    };
  } finally {
    await git(config.repoPath, ['worktree', 'remove', '--force', worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Open the pull request. The token decides the author: an installation token
 * makes it the App, a personal token makes it whoever owns that token.
 */
async function createPullRequest(
  repo: string,
  token: string,
  branch: string,
  title: string,
  body: string,
  base: string,
): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'docxy',
    },
    body: JSON.stringify({ title, body, head: branch, base }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status}: ${await res.text()}`);
  }
  const created = (await res.json()) as { html_url?: string };
  return created.html_url ?? `https://github.com/${repo}/pulls`;
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
