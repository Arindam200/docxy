import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { prBaseBranch, type Config } from '../config.js';
import { resolveBaseRef } from '../git/worktree.js';
import type { RunRecord } from '../types.js';
import type { ProposedFile } from '../types.js';

const exec = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function hasGhCli(): Promise<boolean> {
  try {
    await exec('gh', ['--version']);
    return true;
  } catch {
    return false;
  }
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

  const base = prBaseBranch(config);
  const baseRef = await resolveBaseRef(config.repoPath, base);

  const branch = `docxy/${run.commit.shortSha}-${run.id.slice(0, 8)}`;
  const worktree = await mkdtemp(join(tmpdir(), 'docxy-wt-'));

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
      'user.name=Docxy',
      '-c',
      'user.email=docxy@users.noreply.github.com',
      'commit',
      '-m',
      subject,
      '-m',
      `Drafted from commit ${run.commit.sha} and approved by ${
        run.approval.signoffs.map((s) => s.by).join(', ') || 'a reviewer'
      }.`,
    ]);

    try {
      await git(worktree, ['push', '-u', 'origin', branch]);
    } catch (err) {
      throw new Error(
        `Could not push the branch "${branch}" to origin. The proposal is ` +
          `committed on that branch locally, so nothing is lost — push it yourself ` +
          `once the remote is reachable.\nGit said: ${
            err instanceof Error ? err.message.split('\n').slice(-3).join(' ') : String(err)
          }`,
      );
    }

    const body = buildPrBody(run);
    if (await hasGhCli()) {
      const env = { ...process.env };
      if (config.github.token) env.GH_TOKEN = config.github.token;
      const { stdout } = await exec(
        'gh',
        [
          'pr', 'create',
          '--base', base,
          '--head', branch,
          '--title', subject,
          '--body', body,
        ],
        { cwd: worktree, env },
      );
      const url = stdout.trim().split('\n').find((l) => l.startsWith('http')) ?? stdout.trim();
      return { url, branch };
    }

    return {
      url: await openViaApi(config, branch, subject, body, base),
      branch,
    };
  } finally {
    await git(config.repoPath, ['worktree', 'remove', '--force', worktree]).catch(() => {});
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  }
}

async function openViaApi(
  config: Config,
  branch: string,
  title: string,
  body: string,
  base: string,
): Promise<string> {
  if (!config.github.token) {
    throw new Error(
      'Cannot open a pull request: neither the gh CLI nor GITHUB_TOKEN is available. ' +
        `The branch "${branch}" has been pushed — open the PR manually.`,
    );
  }
  const repo = config.github.repo ?? (await inferRepo(config.repoPath));
  const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.github.token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ title, body, head: branch, base }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API returned HTTP ${res.status}: ${await res.text()}`);
  }
  const created: { html_url?: string } = JSON.parse(await res.text());
  return created.html_url ?? `https://github.com/${repo}/pulls`;
}

async function inferRepo(repoPath: string): Promise<string> {
  const url = await git(repoPath, ['remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url);
  if (!m?.[1]) throw new Error(`Cannot infer the GitHub repository from origin: ${url}`);
  return m[1];
}
