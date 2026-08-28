import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { TrueForge } from '@truefoundry/trueforge-sdk';
import type { Config } from '../config.js';
import type { Classification, ChangelogProposal, ValidationCheck, ValidationReport } from '../types.js';
import type { ApplyResult, ProposedFile } from '../pipeline/apply.js';
import type { TraceEvent } from '../trueforge/run.js';
import { checkLinks } from './links.js';
import { runCommandInSandbox, type SandboxRunInput } from './sandbox.js';

const exec = promisify(execFile);

async function runCommand(
  name: string,
  command: string,
  cwd: string,
): Promise<ValidationCheck> {
  if (!command.trim()) {
    return { name, status: 'skipped', detail: 'no command configured' };
  }
  try {
    // SAFETY: `shell: true` is a valid option this overload's types omit; the call is otherwise an ordinary exec.
    const { stdout, stderr } = await exec(command, {
      cwd,
      shell: true,
      timeout: 10 * 60 * 1000,
      maxBuffer: 32 * 1024 * 1024,
    } as never);
    const tail = `${stdout}${stderr}`.trim().split('\n').slice(-8).join('\n');
    return { name, status: 'pass', where: 'local', detail: tail || 'exited 0' };
  } catch (err) {
    // SAFETY: a rejection from `exec` carries these three fields, and each is read as optional below.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    const tail = (output || e.message || 'command failed').split('\n').slice(-15).join('\n');
    return { name, status: 'fail', where: 'local', detail: tail };
  }
}

export interface ValidateInput {
  config: Config;
  applied: ApplyResult;
  changelogFile: ProposedFile | null;
  classification: Classification;
  /**
   * Absent when the Changelog Author could not be recovered. A docs-only
   * proposal is still worth validating and still worth landing; the semver
   * check simply has nothing to compare against and reports itself skipped.
   */
  changelog: ChangelogProposal | undefined;
  /** Tree the docs were read from — where links resolve and the docs build runs. */
  docsPath: string;
  /**
   * Whether the docs tree is a throwaway worktree we may write into. Staging the
   * proposal is what makes the docs build meaningful; against a user's own
   * checkout we refuse to write and report the check skipped instead.
   */
  stageable: boolean;
  /**
   * Harness client, when one is available. Absent from `docxy show` and from the
   * tests, which validate an already-recorded proposal and execute nothing.
   */
  client?: TrueForge;
  /** Forwarded to the timeline so the sandbox is visible while it works. */
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
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
 * Validate the proposal before any human sees it.
 *
 * The checks split by who wrote what they run over. Anchors, links and semver
 * consistency are pure inspection of the proposed text and execute nothing. The
 * docs build does execute — over prose a model wrote minutes ago — so it goes
 * to the harness sandbox, and only falls back to this machine when no sandbox
 * is configured, saying which one it used either way.
 *
 * The test command stays local on purpose. It belongs to the repository, not to
 * the proposal: it is the operator's own code, already trusted enough to be
 * checked out, and it needs the whole working tree rather than the handful of
 * doc files a sandbox turn can carry.
 */
export async function validateProposal(input: ValidateInput): Promise<ValidationReport> {
  const { config, applied, changelogFile, classification, changelog, docsPath, stageable } = input;
  const checks: ValidationCheck[] = [];

  // Kept as well as forwarded. The live stream shows the sandbox working; the
  // record is what a reviewer opening the run tomorrow has instead.
  const executionEvents: TraceEvent[] = [];
  const collect = (event: TraceEvent): void => {
    executionEvents.push(event);
    input.onEvent?.(event);
  };

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
  if (!changelog) {
    checks.push({
      name: 'semver-consistency',
      status: 'skipped',
      detail: 'no changelog entry was produced, so there is no bump to check',
    });
  } else {
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
  }

  // 4. Whatever the repo already uses to build docs and run tests.
  //
  // The docs build runs in the docs tree with the proposal staged into it, so it
  // exercises the proposed text rather than what is already committed. The test
  // suite belongs to the code repository and runs there, unmodified.
  const docsBuild = config.validation.docsBuildCommand.trim();
  if (!docsBuild) {
    checks.push({ name: 'docs-build', status: 'skipped', detail: 'no command configured' });
  } else {
    const buildInput: DocsBuildInput = {
      command: docsBuild,
      files: allFiles,
      docsPath,
      stageable,
      config,
    };
    if (input.client) buildInput.client = input.client;
    buildInput.onEvent = collect;
    if (input.signal) buildInput.signal = input.signal;
    checks.push(await runDocsBuild(buildInput));
  }

  checks.push(await runCommand('tests', config.validation.testCommand, config.repoPath));

  const report: ValidationReport = { ok: checks.every((c) => c.status !== 'fail'), checks };
  if (executionEvents.length > 0) report.events = executionEvents;
  return report;
}

interface DocsBuildInput {
  command: string;
  files: ProposedFile[];
  docsPath: string;
  stageable: boolean;
  config: Config;
  client?: TrueForge;
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
}

/**
 * Build the proposed docs, in the sandbox when there is one.
 *
 * Falling back rather than failing is deliberate: no sandbox provider is a
 * property of the harness an operator is running, not of the documentation
 * being proposed, and failing the proposal for it would reject correct work.
 * The fallback is always named in the detail, so a report never leaves the
 * reader guessing where the command ran.
 */
async function runDocsBuild(input: DocsBuildInput): Promise<ValidationCheck> {
  const { command, files, docsPath, stageable, config, client, onEvent, signal } = input;

  if (config.sandbox.enabled && client) {
    const sandboxInput: SandboxRunInput = { client, config, name: 'docs-build', command, files };
    if (onEvent) sandboxInput.onEvent = onEvent;
    if (signal) sandboxInput.signal = signal;
    const outcome = await runCommandInSandbox(sandboxInput);
    if ('check' in outcome) return outcome.check;

    // The sandbox could not do it. Whether that is allowed to become host
    // execution is the operator's call, and the default is that it is not:
    // quietly running model-authored content against the filesystem this path
    // exists to protect would remove the boundary precisely when nobody is
    // watching it.
    if (config.sandbox.fallback === 'skip') {
      return {
        name: 'docs-build',
        status: 'fail',
        where: 'sandbox',
        detail:
          `${outcome.unavailable}.\n\n` +
          'The build was not run on this machine instead: DOCXY_SANDBOX_FALLBACK ' +
          'is "skip", so a proposal is reported unvalidated rather than validated ' +
          'outside the sandbox. Set DOCXY_SANDBOX_FALLBACK=local to allow host ' +
          'execution, or configure a sandbox provider.',
      };
    }

    if (!stageable) {
      return {
        name: 'docs-build',
        status: 'fail',
        detail: `${outcome.unavailable}, and the docs tree is your own checkout so the build was not run against it either`,
      };
    }
    await stageProposal(docsPath, files);
    const local = await runCommand('docs-build', command, docsPath);
    return { ...local, detail: `ran on the host — ${outcome.unavailable}\n\n${local.detail}` };
  }

  // No sandbox asked for, or nothing to reach it with. Staging the proposal into
  // a throwaway worktree is what makes the build meaningful; against the
  // operator's own checkout we refuse to write and say so.
  if (!stageable) {
    return {
      name: 'docs-build',
      status: 'skipped',
      detail:
        'the docs tree is your own checkout, so the proposal was not written into it; ' +
        'set DOCXY_DOCS_BRANCH so docs are staged in a throwaway worktree first, ' +
        'or leave DOCXY_SANDBOX on so the build runs in the harness sandbox instead',
    };
  }
  await stageProposal(docsPath, files);
  return runCommand('docs-build', command, docsPath);
}
