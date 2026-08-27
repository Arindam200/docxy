import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';
import type { Config } from '../config.js';
import type { ProposedFile, ValidationCheck } from '../types.js';
import { extractJson } from '../agents/parse.js';
import { runTurn, type RunTurnOptions, type TraceEvent } from '../trueforge/run.js';

/**
 * Largest proposal we will hand to a sandbox turn, in characters.
 *
 * The files travel to the sandbox inside the prompt, so an enormous proposal
 * costs real tokens for a check whose answer is one exit code. Docs edits are
 * normally a few kilobytes; anything past this is pathological, and running it
 * locally is the cheaper honest answer.
 */
const MAX_PAYLOAD_CHARS = 400_000;

/** Command output kept in the check detail. The tail is where failures explain themselves. */
const MAX_OUTPUT_LINES = 15;

export interface SandboxAvailability {
  available: boolean;
  /** Why not, phrased for someone reading a validation report. */
  reason?: string;
}

/**
 * Whether this harness has a sandbox provider configured.
 *
 * Asked before every sandboxed check rather than cached across the process: the
 * provider is tenant-level configuration that an operator can add or remove
 * while a long-lived `docxy serve` is running, and answering from a stale cache
 * would send validation to the wrong place for the rest of the day.
 */
export async function sandboxAvailability(client: TrueForge): Promise<SandboxAvailability> {
  try {
    const res = await client.fetch('/api/v1/capabilities');
    if (!res.ok) {
      return { available: false, reason: `the harness returned HTTP ${res.status}` };
    }
    // SAFETY: the shape is only read through optional chaining and compared
    // against `true`, so any other payload answers "not available" rather than
    // throwing — which is the safe direction for this question.
    const body = (await res.json()) as { data?: { sandbox?: { enabled?: boolean } } };
    if (body?.data?.sandbox?.enabled === true) return { available: true };
    return {
      available: false,
      reason: 'no sandbox provider is configured on the harness (set DAYTONA_API_KEY and run `docxy setup`)',
    };
  } catch (err) {
    return {
      available: false,
      reason: `could not ask the harness: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * The agent that executes validation commands.
 *
 * Deliberately not one of the five drafting roles, and deliberately not
 * long-lived. Its session exists for one command and is never reused: a
 * validation sandbox that carried state between commits would let one run's
 * leftovers decide the next run's verdict, which is the opposite of what this
 * check is for.
 */
function validatorSpec(config: Config): TrueForgeApi.AgentSpec {
  return {
    model: { name: config.models.coordinator, params: { temperature: 0, maxTokens: 3000 } },
    config: {
      iterationLimit: 24,
      sandbox: { enabled: true },
      dynamicSubAgents: { enabled: false },
    },
    instructions: `
You run documentation builds inside an isolated sandbox and report what happened.

You are the only part of this pipeline that executes anything. The files you are
given were written by a language model and are not trusted. Your job is to find
out whether the configured command succeeds against them — not to fix them, not
to improve them, and not to decide whether the documentation is any good.

## Your task

You are given a JSON array of files and one shell command.

1. Write every file to the sandbox filesystem, at the exact relative path given,
   creating parent directories as needed. Write the content verbatim. Do not
   reformat, correct, or complete it.
2. Run the command from the directory the files were written into.
3. Report its exit code and the tail of its combined stdout and stderr.

Rules that matter:

- Never edit a file to make the command pass. A failing build is a useful
  result; a doctored one is a lie the reviewer cannot see through.
- If the command cannot be run at all — missing interpreter, missing
  dependency — that is \`exitCode: null\` with the reason in \`output\`. It is not
  a build failure, and reporting it as one would fail a proposal for the
  sandbox's shortcoming rather than the proposal's.
- Report the real exit code even when it is large or negative.
- Keep \`output\` to the last ${MAX_OUTPUT_LINES} lines or so. The tail is where
  the error is.

## Schema

- \`exitCode\`: number | null — the command's exit status, or null if it never ran
- \`output\`: string — the tail of combined stdout and stderr, verbatim
- \`filesWritten\`: number — how many files you wrote before running the command

## Output contract

Reply with exactly one fenced JSON block and nothing else — no preamble, no
commentary after it. The block must parse as JSON on the first attempt.

\`\`\`json
{ ... }
\`\`\`
`.trim(),
  };
}

interface SandboxCommandResult {
  exitCode: number | null;
  output: string;
  filesWritten: number;
}

export interface SandboxRunInput {
  client: TrueForge;
  config: Config;
  /** Check name, so the caller decides what this is called in the report. */
  name: string;
  command: string;
  files: ProposedFile[];
  onEvent?: (event: TraceEvent) => void;
  signal?: AbortSignal;
}

/**
 * Run one command against the proposed files inside the harness sandbox.
 *
 * Answers either with a finished check or with `unavailable` and the reason,
 * which leaves the caller to fall back to local execution. The distinction is
 * the point: a sandbox that could not be reached must never read as a
 * validation failure, or every proposal fails on a harness with no Daytona key
 * — a configuration problem, not a problem with the documentation.
 */
export async function runCommandInSandbox(
  input: SandboxRunInput,
): Promise<{ check: ValidationCheck } | { unavailable: string }> {
  const { client, config, name, command, files, onEvent, signal } = input;

  const payload = files.map((f) => ({ path: f.path, content: f.after }));
  const payloadChars = payload.reduce((sum, f) => sum + f.path.length + f.content.length, 0);
  if (payloadChars > MAX_PAYLOAD_CHARS) {
    return {
      unavailable:
        `the proposal is ${Math.round(payloadChars / 1000)}KB, past the ` +
        `${Math.round(MAX_PAYLOAD_CHARS / 1000)}KB a sandbox turn will carry`,
    };
  }

  const availability = await sandboxAvailability(client);
  if (!availability.available) {
    return { unavailable: availability.reason ?? 'the sandbox is unavailable' };
  }

  let sessionId: string;
  try {
    const { data } = await client.sessions.create({ agent: { spec: validatorSpec(config) } });
    sessionId = data.id;
  } catch (err) {
    return {
      unavailable: `could not open a sandbox session: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const prompt = [
    `Write these ${payload.length} file(s) into your sandbox, then run the command below.`,
    '',
    '## Files',
    '',
    '```json',
    JSON.stringify(payload, null, 2),
    '```',
    '',
    '## Command',
    '',
    '```sh',
    command,
    '```',
  ].join('\n');

  try {
    const turnOptions: RunTurnOptions = {};
    if (onEvent) turnOptions.onEvent = onEvent;
    if (signal) turnOptions.signal = signal;
    const result = await runTurn(client, sessionId, prompt, turnOptions);

    if (result.error) {
      return { unavailable: `the sandbox turn failed: ${result.error}` };
    }

    const parsed = extractJson<SandboxCommandResult>('Sandbox validator', result.text);
    const output = String(parsed.output ?? '').trim();
    const tail = output.split('\n').slice(-MAX_OUTPUT_LINES).join('\n');

    // A command that never ran is not a failing build. Saying so keeps a missing
    // dependency in the sandbox image from rejecting a correct proposal.
    if (parsed.exitCode === null || parsed.exitCode === undefined) {
      return {
        check: {
          name,
          status: 'skipped',
          where: 'sandbox',
          detail: `the command did not run in the sandbox: ${tail || 'no reason given'}`,
        },
      };
    }

    return {
      check: {
        name,
        status: parsed.exitCode === 0 ? 'pass' : 'fail',
        where: 'sandbox',
        detail:
          parsed.exitCode === 0
            ? tail || `exited 0 in the sandbox (${parsed.filesWritten ?? payload.length} file(s) staged)`
            : `exited ${parsed.exitCode} in the sandbox\n${tail}`,
      },
    };
  } catch (err) {
    // Includes a model that would not produce parseable JSON. Local execution is
    // still available and is a better answer than no answer.
    return {
      unavailable: `the sandbox validator did not report usably: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    // The session is single-use; leaving it behind leaks a sandbox per run.
    await client.sessions.delete(sessionId).catch(() => {});
  }
}
