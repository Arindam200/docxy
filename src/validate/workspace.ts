import { DaytonaSandbox, type DaytonaSandboxOptions } from '@mastra/daytona';
import type { Config } from '../config.js';
import type { ProposedFile, ValidationCheck } from '../types.js';
import type { TraceEvent } from '../runtime/types.js';

/**
 * Run a validation command in a Daytona workspace, with no model in the loop.
 *
 * This is what the harness path could not be. There, the proposed files
 * travelled inside a *prompt*, an agent was asked to write them out and run the
 * command, and the exit code came back as a claim in a JSON object - which is
 * why that path has to cross-check the file count the model says it wrote, and
 * why an unparseable reply had to be treated as an unavailable sandbox.
 *
 * Here the files are uploaded over the SDK and the exit code is the process's
 * own. There is nothing to disbelieve, so there is nothing to cross-check. A
 * proposal that passes has actually been built, which is the difference between
 * evidence a reviewer can act on and a sentence a model wrote.
 */

/** Command output kept in the check detail. The tail is where failures explain themselves. */
const MAX_OUTPUT_LINES = 15;

/**
 * Largest proposal we will upload, in characters.
 *
 * Ten times the harness path's cap, and for a different reason. That limit was
 * about tokens - the files were prompt content and every one was paid for.
 * These are uploaded, so the only cost is transfer, and the cap exists solely
 * to stop something pathological from stalling a run.
 */
const MAX_PAYLOAD_CHARS = 4_000_000;

/** Attempts to get a sandbox running before giving up on the workspace path. */
const MAX_START_ATTEMPTS = 3;

export interface WorkspaceRunInput {
  config: Config;
  /** Check name, carried into the result. */
  name: string;
  command: string;
  files: ProposedFile[];
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
}

export type WorkspaceOutcome =
  | { check: ValidationCheck }
  /** The sandbox could not run it. Never a validation failure - the caller's policy decides. */
  | { unavailable: string };

function tailOf(text: string): string {
  return text.trim().split('\n').slice(-MAX_OUTPUT_LINES).join('\n');
}

/** Output that reads like a build reaching for a network it was denied. */
const LOOKS_NETWORKY =
  /enotfound|eai_again|econnrefused|etimedout|network|getaddrinfo|registry\.|proxy|dns|tls handshake|could not resolve/i;

/**
 * Explain the egress policy, but only when it plausibly caused this.
 *
 * Appending it to every failure was worse than saying nothing: a build that
 * failed for a real documentation reason - an unbalanced fence, a broken
 * include - carried a paragraph about package registries, and a note attached
 * to every failure is one nobody reads by the third run.
 */
export function networkHint(config: Config, output: string): string {
  if (!config.sandbox.blockNetwork || !LOOKS_NETWORKY.test(output)) return '';
  return (
    '\n\nNetwork egress is blocked in the workspace and this output looks like it ' +
    'wanted the network. Set DOCXY_SANDBOX_ALLOW_NETWORK=true if this build genuinely ' +
    'needs a registry.'
  );
}

/** Whether a workspace can be attempted at all. */
export function workspaceConfigured(config: Config): boolean {
  return Boolean(config.sandbox.daytonaApiKey);
}

/**
 * Bring a sandbox up, retrying the failures that are worth retrying.
 *
 * Provisioning is a remote operation over a network and fails transiently.
 * Retrying it here rather than letting the whole path fall back means a blip
 * costs seconds instead of costing the run its only isolated execution - which,
 * with `DOCXY_SANDBOX_FALLBACK=skip`, is the difference between a validated
 * proposal and one reported unvalidated.
 */
async function startWithRetry(
  sandbox: DaytonaSandbox,
  emit: (kind: string, text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await sandbox.start();
      return;
    } catch (err) {
      last = err;
      const message = err instanceof Error ? err.message : String(err);
      if (attempt === MAX_START_ATTEMPTS) break;
      emit('sandbox', `sandbox start failed (${message}); retrying ${attempt}/${MAX_START_ATTEMPTS}`);
      // Linear rather than exponential: provisioning blips clear in seconds,
      // and the run has a deadline that backing off aggressively would eat.
      await new Promise((resolve) => setTimeout(resolve, attempt * 2000));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * Write the proposal into a fresh sandbox and run one command over it.
 *
 * Answers either with a finished check or with `unavailable` and the reason.
 * The distinction is the point: a sandbox that could not be reached must never
 * read as a validation failure, or every proposal fails on a deployment with no
 * Daytona key - a configuration problem, not a problem with the documentation.
 */
export async function runCommandInWorkspace(
  input: WorkspaceRunInput,
): Promise<WorkspaceOutcome> {
  const { config, name, command, files, onEvent, signal } = input;

  if (!workspaceConfigured(config)) {
    return {
      unavailable:
        'DAYTONA_API_KEY is not set, so there is no workspace to run the build in. ' +
        'Get a key at https://app.daytona.io',
    };
  }

  const payloadChars = files.reduce((sum, f) => sum + f.path.length + f.after.length, 0);
  if (payloadChars > MAX_PAYLOAD_CHARS) {
    return {
      unavailable:
        `the proposal is ${Math.round(payloadChars / 1000)}KB, past the ` +
        `${Math.round(MAX_PAYLOAD_CHARS / 1000)}KB a workspace upload will carry`,
    };
  }

  const emit = (kind: string, text: string): void => {
    onEvent?.({ at: new Date().toISOString(), kind, text });
  };

  const options: DaytonaSandboxOptions = {
    // Distinct per run. A validation sandbox that carried state between commits
    // would let one run's leftovers decide the next run's verdict, which is the
    // opposite of what this check is for.
    id: `docxy-validate-${Date.now().toString(36)}`,
    apiKey: config.sandbox.daytonaApiKey,
    language: 'typescript',
    // Deleted on stop. The auto-* intervals below are the backstop for a
    // process that dies before its `finally` runs.
    ephemeral: true,
    timeout: config.sandbox.execTimeoutMs,
  };
  // Zero disables a timer, and Daytona reads absent and zero differently - so
  // it is set only when it was actually asked for. This is the backstop for a
  // process that dies before its `finally` runs; `ephemeral` then deletes the
  // stopped sandbox.
  //
  // `autoDeleteInterval` is deliberately not set. Daytona rejects it alongside
  // `ephemeral` - which already deletes on stop - and passing both only earns a
  // warning on every single run for a setting it goes on to ignore.
  if (config.sandbox.autoStopMinutes > 0) {
    options.autoStopInterval = config.sandbox.autoStopMinutes;
  }
  // Default-deny egress. The command runs over prose a model wrote minutes ago;
  // letting it reach the network by default would make this a sandbox in name
  // only. Operators whose build genuinely needs a registry open it explicitly
  // with DOCXY_SANDBOX_ALLOW_NETWORK.
  if (config.sandbox.blockNetwork) options.networkBlockAll = true;

  const sandbox = new DaytonaSandbox(options);

  // Both capabilities are optional on Mastra's sandbox interface, so they are
  // checked rather than assumed. A provider that cannot do one of them is an
  // unusable workspace, not a failed proposal.
  const { writeFiles, executeCommand } = sandbox;
  if (!writeFiles || !executeCommand) {
    return {
      unavailable:
        'the daytona workspace does not expose file upload and command execution, ' +
        'which this check needs',
    };
  }

  const started = Date.now();
  try {
    await startWithRetry(sandbox, emit, signal);
    emit('sandbox', `workspace ready in ${Date.now() - started}ms`);

    signal?.throwIfAborted();
    await writeFiles.call(sandbox, files.map((f) => ({ path: f.path, content: f.after })));
    emit('sandbox', `staged ${files.length} file(s)`);

    signal?.throwIfAborted();
    const result = await executeCommand.call(sandbox, 'bash', ['-c', command], {
      timeout: config.sandbox.execTimeoutMs,
    });

    const output = tailOf(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
    emit('sandbox', `command exited ${result.exitCode}`);

    // A command killed by its own deadline did not fail the proposal - it ran
    // out of time. Reported as unavailable so the caller's fallback policy
    // decides, rather than rejecting documentation for a slow build.
    if (result.timedOut) {
      return {
        unavailable:
          `the command did not finish within ` +
          `${Math.round(config.sandbox.execTimeoutMs / 1000)}s in the daytona workspace` +
          (output ? `\n${output}` : ''),
      };
    }

    return {
      check: {
        name,
        status: result.exitCode === 0 ? 'pass' : 'fail',
        where: 'sandbox',
        detail:
          result.exitCode === 0
            ? // The staged count is always stated, not just when the command
              // was silent. The workspace holds the proposed files and nothing
              // else, so a green check here means "these files build", not
              // "the documentation builds" - and a reader weighing this as
              // evidence has to be able to tell those apart. The coordinator
              // caught exactly this ambiguity on a real run.
              `exited 0 in the daytona workspace, over the ${files.length} proposed ` +
              `file(s) only${output ? `\n${output}` : ''}`
            : `exited ${result.exitCode} in the daytona workspace\n${output}` +
              networkHint(config, output),
      },
    };
  } catch (err) {
    // An abort is the run's own deadline and belongs to the caller. Erasing it
    // into an unavailable sandbox sends the caller down the fallback path,
    // where a fresh command starts against a deadline that has already passed.
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw err;
    }
    return {
      unavailable: `the daytona workspace could not run the command: ${
        err instanceof Error ? err.message : String(err)
      }`,
    };
  } finally {
    // Ephemeral sandboxes still have to be told; leaving one behind leaks a
    // workspace per run.
    await sandbox.destroy().catch(() => {});
  }
}
