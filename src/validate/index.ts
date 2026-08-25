import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Config } from '../config.js';
import type { Classification, ChangelogProposal, ValidationCheck, ValidationReport } from '../types.js';
import type { ApplyResult, ProposedFile } from '../pipeline/apply.js';
import { checkLinks } from './links.js';

const exec = promisify(execFile);

interface CommandFailure {
  stdout?: string;
  stderr?: string;
  message?: string;
}

/** A rejected command promise may carry captured output; anything else is opaque. */
function withCommandOutput<T>(value: T): value is T & CommandFailure {
  return typeof value === 'object' && value !== null;
}

async function runCommand(
  name: string,
  command: string,
  cwd: string,
): Promise<ValidationCheck> {
  if (!command.trim()) {
    return { name, status: 'skipped', detail: 'no command configured' };
  }
  try {
    const { stdout, stderr } = await exec(command, [], {
      cwd,
      shell: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const tail = `${stdout}${stderr}`.trim().split('\n').slice(-8).join('\n');
    return { name, status: 'pass', detail: tail || 'exited 0' };
  } catch (cause) {
    const e = withCommandOutput(cause) ? cause : undefined;
    const output = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim();
    const tail = (output || e?.message || 'command failed').split('\n').slice(-15).join('\n');
    return { name, status: 'fail', detail: tail };
  }
}

export interface ValidateInput {
  config: Config;
  applied: ApplyResult;
  changelogFile: ProposedFile | null;
  classification: Classification;
  changelog: ChangelogProposal;
  /** Tree the docs were read from — where links resolve and the docs build runs. */
  docsPath: string;
  /**
   * Whether the docs tree is a throwaway worktree we may write into. Staging the
   * proposal is what makes the docs build meaningful; against a user's own
   * checkout we refuse to write and report the check skipped instead.
   */
  stageable: boolean;
}

/** Write the proposal into the docs worktree so the build sees the proposed text. */
async function stageProposal(docsPath: string, files: ProposedFile[]): Promise<void> {
  for (const file of files) {
    const target = join(docsPath, file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.after, 'utf8');
  }
}

/**
 * Validate the proposal before any human sees it. Runs against the repository on
 * disk rather than a remote sandbox, so it needs no external account; the doc
 * build and test commands are whatever the repo already uses.
 */
export async function validateProposal(input: ValidateInput): Promise<ValidationReport> {
  const { config, applied, changelogFile, classification, changelog, docsPath, stageable } = input;
  const checks: ValidationCheck[] = [];

  if (!config.validation.enabled) {
    return {
      ok: true,
      checks: [{ name: 'validation', status: 'skipped', detail: 'disabled by configuration' }],
    };
  }

  // 1. Every proposed edit anchored to real text. This is the check that catches
  //    a model paraphrasing instead of quoting.
  checks.push(
    applied.problems.length === 0
      ? {
          name: 'edits-apply',
          status: 'pass',
          detail: `${applied.files.length} file(s) patched cleanly`,
        }
      : {
          name: 'edits-apply',
          status: 'fail',
          detail: applied.problems
            .map((p) => `${p.path} [${p.kind}]: ${p.detail}`)
            .join('\n'),
        },
  );

  // 2. Links in the proposed text actually resolve.
  const allFiles = changelogFile ? [...applied.files, changelogFile] : applied.files;
  if (config.validation.checkLinks) {
    const broken = checkLinks(docsPath, allFiles);
    checks.push(
      broken.length === 0
        ? { name: 'link-check', status: 'pass', detail: 'no broken relative links or anchors' }
        : {
            name: 'link-check',
            status: 'fail',
            detail: broken.map((b) => `${b.file} -> ${b.target}: ${b.reason}`).join('\n'),
          },
    );
  } else {
    checks.push({ name: 'link-check', status: 'skipped', detail: 'disabled by configuration' });
  }

  // 3. Internal consistency between the two specialists' outputs.
  const bumpOk = !(classification.kind === 'breaking' && changelog.semverBump !== 'major');
  checks.push(
    bumpOk
      ? {
          name: 'semver-consistency',
          status: 'pass',
          detail: `${classification.kind} -> ${changelog.semverBump}`,
        }
      : {
          name: 'semver-consistency',
          status: 'fail',
          detail:
            `The change is classified breaking but the proposed bump is ` +
            `"${changelog.semverBump}". A breaking change requires a major bump.`,
        },
  );

  // 4. Whatever the repo already uses to build docs and run tests.
  //
  // The docs build runs in the docs tree with the proposal staged into it, so it
  // exercises the proposed text rather than what is already committed. The test
  // suite belongs to the code repository and runs there, unmodified.
  if (!config.validation.docsBuildCommand.trim()) {
    checks.push({ name: 'docs-build', status: 'skipped', detail: 'no command configured' });
  } else if (!stageable) {
    checks.push({
      name: 'docs-build',
      status: 'skipped',
      detail:
        'the docs tree is your own checkout, so the proposal was not written into it; ' +
        'set DOCXY_DOCS_BRANCH so docs are staged in a throwaway worktree first',
    });
  } else {
    await stageProposal(docsPath, allFiles);
    checks.push(await runCommand('docs-build', config.validation.docsBuildCommand, docsPath));
  }

  checks.push(await runCommand('tests', config.validation.testCommand, config.repoPath));

  return { ok: checks.every((c) => c.status !== 'fail'), checks };
}
