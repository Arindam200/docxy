import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { containedPath } from '../git/repo.js';
import type { Config } from '../config.js';
import type { Classification, ChangelogProposal, ValidationCheck, ValidationReport } from '../types.js';
import type { ApplyResult, ProposedFile } from '../pipeline/apply.js';
import type { TraceEvent } from '../runtime/types.js';
import { checkLinks } from './links.js';
import { databaseConfigured } from '../db/index.js';
import { runHostCommand } from './host-command.js';
import {
  runCommandInWorkspace,
  workspaceConfigured,
  type WorkspaceRunInput,
} from './workspace.js';

const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Run a repository's command on this machine. See `host-command.ts` for what
 * it is and is not given.
 */
async function runCommand(
  name: string,
  command: string,
  cwd: string,
  config: Config,
  signal?: AbortSignal,
): Promise<ValidationCheck> {
  if (!command.trim()) {
    return { name, status: 'skipped', detail: 'no command configured' };
  }
  try {
    const options: Parameters<typeof runHostCommand>[1] = {
      cwd,
      timeoutMs: COMMAND_TIMEOUT_MS,
      passEnv: config.validation.passEnv,
    };
    if (signal) options.signal = signal;
    const result = await runHostCommand(command, options);
    const output = result.output.trim();
    if (result.code === 0) {
      return { name, status: 'pass', where: 'local', detail: tailLines(output, 8) || 'exited 0' };
    }
    const why = result.timedOut
      ? `timed out after ${COMMAND_TIMEOUT_MS / 60_000} minutes; the command and everything it started were stopped`
      : result.aborted
        ? 'stopped: the run was cancelled or ran out of time'
        : `exited ${result.code ?? 'on a signal'}`;
    return { name, status: 'fail', where: 'local', detail: [tailLines(output, 15), why].filter(Boolean).join('\n\n') };
  } catch (err) {
    return { name, status: 'fail', where: 'local', detail: err instanceof Error ? err.message : String(err) };
  }
}

function tailLines(text: string, count: number): string {
  return text.split('\n').slice(-count).join('\n');
}

/**
 * The repository's test suite, where running it is safe.
 *
 * On a deployment with a database, repositories belong to whichever
 * organizations connected them, and their test scripts are their code - not
 * the operator's, which is what running them on the host assumed. Even with a
 * stripped environment, a process running as the server's user can read the
 * server's own environment from `/proc`, so the host is no place for it. The
 * check reports itself skipped and says why; a single-tenant `docxy serve` or
 * the CLI, where the repository is the operator's own, runs it as before.
 */
async function runTests(config: Config, signal?: AbortSignal): Promise<ValidationCheck> {
  const command = config.validation.testCommand;
  if (command.trim() && databaseConfigured()) {
    return {
      name: 'tests',
      status: 'skipped',
      detail:
        'not run: on a multi-tenant deployment the test suite is a connected ' +
        "organization's code, and this host holds every organization's credentials. " +
        'DOCXY_TEST_COMMAND only runs for single-tenant use (the CLI or docxy serve without DATABASE_URL).',
    };
  }
  return runCommand('tests', command, config.repoPath, config, signal);
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
  /** Tree the docs were read from - where links resolve and the docs build runs. */
  docsPath: string;
  /**
   * Whether the docs tree is a throwaway worktree we may write into. Staging the
   * proposal is what makes the docs build meaningful; against a user's own
   * checkout we refuse to write and report the check skipped instead.
   */
  stageable: boolean;
  /** Forwarded to the timeline so the sandbox is visible while it works. */
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
}

/** Write the proposal into the docs worktree so the build sees the proposed text. */
async function stageProposal(docsPath: string, files: ProposedFile[]): Promise<void> {
  for (const file of files) {
    const target = await containedPath(docsPath, file.path);
    if (!target) throw new Error(`Refusing to stage ${JSON.stringify(file.path)}: it is outside the docs tree.`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.after, 'utf8');
  }
}

/**
 * Validate the proposal before any human sees it.
 *
 * The checks split by who wrote what they run over. Anchors, links and semver
 * consistency are pure inspection of the proposed text and execute nothing. The
 * docs build does execute - over prose a model wrote minutes ago - so it goes
 * to an isolated sandbox, and only falls back to this machine when none is
 * available and the operator has allowed it, saying which one it used either way.
 *
 * The test command stays local on purpose. It belongs to the repository, not to
 * the proposal, and it needs the whole working tree rather than the handful of
 * doc files a sandbox carries. That is only safe where the repository is the
 * operator's own, so a multi-tenant deployment skips it - see `runTests`.
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
    buildInput.onEvent = collect;
    if (input.signal) buildInput.signal = input.signal;
    checks.push(await runDocsBuild(buildInput));
  }

  checks.push(await runTests(config, input.signal));

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
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
}

/**
 * Build the proposed docs, in an isolated sandbox when there is one.
 *
 * The command runs in a Daytona workspace: the files are uploaded over the SDK
 * and the exit code is the process's own, so nothing about the result rests on
 * a model's account of it.
 *
 * Falling back to the host rather than failing is deliberate: having no
 * workspace is a property of the deployment, not of the documentation being
 * proposed, and failing the proposal for it would reject correct work. Whether
 * that fallback is allowed is the operator's call and defaults to no. The
 * location is always named in the detail, so a report never leaves the reader
 * guessing where the command ran.
 */
async function runDocsBuild(input: DocsBuildInput): Promise<ValidationCheck> {
  const { command, files, docsPath, stageable, config } = input;

  if (config.sandbox.enabled) {
    const workspaceInput: WorkspaceRunInput = { config, name: 'docs-build', command, files };
    if (input.onEvent) workspaceInput.onEvent = input.onEvent;
    if (input.signal) workspaceInput.signal = input.signal;

    // An absent workspace is an unavailable sandbox, not "no sandbox was
    // asked for". The difference decides everything below: `ValidationReport.ok`
    // waves through anything `skipped`, so a configured docs build that could
    // not run in isolation must reach the fallback policy rather than quietly
    // reporting itself skipped and publishing clean.
    const outcome = workspaceConfigured(config)
      ? await runCommandInWorkspace(workspaceInput)
      : {
          unavailable:
            'DAYTONA_API_KEY is not set, so there is no isolated workspace to run the build in',
        };

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
    const local = await runCommand('docs-build', command, docsPath, config, input.signal);
    return { ...local, detail: `ran on the host - ${outcome.unavailable}\n\n${local.detail}` };
  }

  // No sandbox asked for, or nothing to reach one with. Staging the proposal
  // into a throwaway worktree is what makes the build meaningful; against the
  // operator's own checkout we refuse to write and say so.
  if (!stageable) {
    return {
      name: 'docs-build',
      status: 'skipped',
      detail:
        'the docs tree is your own checkout, so the proposal was not written into it; ' +
        'set DOCXY_DOCS_BRANCH so docs are staged in a throwaway worktree first, ' +
        'or leave DOCXY_SANDBOX on so the build runs in a sandbox instead',
    };
  }
  await stageProposal(docsPath, files);
  return runCommand('docs-build', command, docsPath, config, input.signal);
}
