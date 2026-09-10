import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { LocalSandbox, type SandboxStartResult } from '@mastra/core/workspace';
import type { ToolsInput } from '@mastra/core/agent';
import { z } from 'zod';
import type { Config } from '../config.js';
import { redactSecrets } from '../guardrails/secrets.js';
import { readRepoFile } from '../git/repo.js';
import type { DocEdit, DocsProposal } from '../types.js';
import type { CodeModeSummary } from '../agents/schemas.js';
import { DOCS_UPDATER_CODE_MODE } from '../agents/roles.js';
import type { RunContext } from './context.js';

/**
 * The Docs Updater, writing a program instead of quoting from memory.
 *
 * The standing failure in this pipeline is that an anchor has to match the file
 * byte for byte, and a model asked to reproduce a line of prose reproduces
 * something very close to it. `anchor-resolution` sits around 64% because of
 * it, and every cause found so far - too small an excerpt budget, deleted diff
 * lines that looked quotable, a thread holding older copies of the file - was a
 * variation on *the model retyping text*.
 *
 * Code Mode inverts the direction. The role is handed no documentation to
 * reproduce. It writes a TypeScript program, and the program is given the
 * impacted files as data: it locates the stale passage with ordinary string
 * work and returns **the substring it found** as the anchor. An anchor stops
 * being remembered and starts being measured, and deriving the replacement from
 * the same line - `line.replace('250', '271')` - keeps the markdown that
 * retyping loses.
 *
 * ## Why the program is handed data instead of a channel back to the host
 *
 * Mastra's own Code Mode bridges `external_*` calls from the sandbox to the
 * host over stdio, which its transport notes describe as the v1 shape with
 * remote sandboxes still to come. Measured against Daytona, that is exactly
 * what it means: the workspace starts, `node` runs, and no frame ever comes
 * back, because Daytona's session API carries no live stdin/stdout channel.
 *
 * Nothing here needs one. Every file the program may read is known before it
 * runs - the Impact Mapper named them - so they are materialised into the
 * program as a `docs` record and the proposals come back as its return value.
 * No bridge, and the same program runs unchanged in a Daytona workspace or a
 * local sandbox. What that costs is the ability to react *within* one program;
 * what replaces it is the tool result, which reports each proposal's fate and
 * lets the model run a corrected program on the next round. Live runs use two
 * or three rounds, so that is the loop either way.
 *
 * ## Where it runs
 *
 * A Daytona workspace, and by default nothing else. The workspace has no host
 * filesystem and no egress - both measured, not assumed: a probe inside one
 * could not resolve a hostname, could not read `/root`, and found no `/Users`.
 * Egress is denied by the same `DOCXY_SANDBOX_ALLOW_NETWORK` policy the docs
 * build already runs under.
 *
 * `DOCXY_CODE_MODE_SANDBOX=local` runs the program on this machine instead,
 * under seatbelt or bubblewrap, which is the development answer and has to be
 * asked for by name. It is weaker in a way worth stating plainly: a probe
 * inside it could not reach the network but *could* read `/etc/passwd`, because
 * macOS seatbelt cannot restrict reads and Mastra's generated profile emits
 * `(allow file-read*)` deliberately.
 *
 * Neither is ever chosen by accident. A missing `DAYTONA_API_KEY` is an error
 * rather than a quiet downgrade to local, because docxy runs as a deployed
 * service and "which machine executes the model's code" should not be decided
 * by an environment variable somebody forgot to set.
 *
 * ## The boundary that holds in either case
 *
 * - the program is given only the doc paths the Impact Mapper flagged, so it
 *   cannot see a file nobody asked to be documented;
 * - an anchor must occur exactly once in the **real** file, re-read on the host
 *   after the program returns - never in the copy the program was given;
 * - every proposal goes through `SECRET_RULES` before it is kept. A proposed
 *   edit ends up in a pull request, which makes it the one channel out, and a
 *   proposal the redactor changes is refused rather than quietly rewritten.
 */

/** Wall-clock ceiling for one program, when the caller sets none. */
const PROGRAM_TIMEOUT_MS = 60_000;

/** Tool-calling rounds before the turn is cut off. */
export const MAX_STEPS = 6;

/** Matches `readDocExcerpts`: a file past this is trimmed, not shipped whole. */
const MAX_DOC_CHARS = 60_000;

/** Documentation handed to one program, so a large impact map cannot blow the sandbox. */
const MAX_TOTAL_DOC_CHARS = 200_000;

/** Anchors below this are ambiguous by construction; the check is cheap. */
const MIN_ANCHOR_CHARS = 12;

/** Captured program output kept for the trace. */
const MAX_OUTPUT_CHARS = 4_000;

/** A skip reason is a sentence for a reviewer, not a place to paste a file. */
const MAX_REASON_CHARS = 300;

/** Marks the line on stdout that carries the program's result. */
const RESULT_MARKER = '__DOCXY_RESULT__';

/** Where the program is written inside the sandbox. */
const PROGRAM_FILE = 'docxy-program.ts';

export interface CodeModeDraft {
  /** The proposal assembled from what the program returned, after checking. */
  proposal: DocsProposal;
  /** Tool-level events, for the role trace. */
  events: Array<{ kind: string; text: string }>;
  /** Proposals the checks refused, with the reason. Reported, never silent. */
  rejected: string[];
}

export interface CodeModeSession {
  tools: ToolsInput;
  /** How to write the program, for the per-call instruction override. */
  instructions: string;
  draft(): CodeModeDraft;
}

/**
 * The sandbox operations this needs, and the only ones it uses.
 *
 * Both are optional on Mastra's `WorkspaceSandbox`, so they are checked rather
 * than assumed - a provider missing one is an unusable sandbox, which is a
 * configuration problem and not a failed proposal. Narrowed to this shape so a
 * Daytona workspace and a local sandbox are the same thing to the code below.
 */
export interface DraftingSandbox {
  /** Daytona stages files over the SDK. The local sandbox has no such method. */
  writeFiles?: (files: Array<{ path: string; content: string }>) => Promise<void>;
  /**
   * Where a command runs, when the sandbox is on this machine.
   *
   * The local sandbox exposes this and no `writeFiles`, because "upload" and
   * "write a file" are the same act when the filesystem is shared. Staging
   * prefers `writeFiles` and falls back to this, which is what lets one code
   * path drive both.
   */
  workingDirectory?: string;
  executeCommand?: (
    command: string,
    args?: string[],
    options?: { timeout?: number },
  ) => Promise<{ stdout?: string; stderr?: string; exitCode?: number; timedOut?: boolean }>;
  /** Provisioning reports how the VM was acquired; nothing here reads it. */
  start?: () => Promise<SandboxStartResult | void>;
  stop?: () => Promise<void>;
}

/**
 * Put the program where the sandbox will run it.
 *
 * Two ways, because the two sandboxes differ in kind rather than in degree.
 * Daytona is a machine somewhere else and stages over the SDK; the local
 * sandbox is this machine under a seatbelt or bubblewrap profile, so its
 * working directory is an ordinary path and writing to it is an ordinary write.
 * Returns false when a sandbox offers neither, which is a configuration problem
 * rather than a failed proposal.
 */
async function stageProgram(sandbox: DraftingSandbox, program: string): Promise<boolean> {
  if (sandbox.writeFiles) {
    await sandbox.writeFiles([{ path: PROGRAM_FILE, content: program }]);
    return true;
  }
  if (sandbox.workingDirectory) {
    await mkdir(sandbox.workingDirectory, { recursive: true });
    await writeFile(join(sandbox.workingDirectory, PROGRAM_FILE), program, 'utf8');
    return true;
  }
  return false;
}

/** Occurrences of `needle` in `haystack`, counted without a regex. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** One proposed edit, as the program returns it. */
export interface ProposedEditInput {
  path: string;
  section: string;
  find: string;
  replace: string;
  mode: 'replace' | 'append';
  rationale: string;
}

/**
 * Every check a proposed edit has to survive, as one pure function.
 *
 * Pure and exported so the rules can be tested without a sandbox, a model, or a
 * process: these are the boundary the notes above claim, and a boundary only
 * exercised through an integration path is one nobody checks on the platform
 * where it matters.
 *
 * `fileText` must be the file as it is **on the host**, not the copy the program
 * was given. They hold the same text today, and checking the copy would mean a
 * program could propose an edit against a file it had itself invented.
 *
 * Returns the refusal text, or `null` when the edit is acceptable.
 */
export function checkProposedEdit(fileText: string, edit: ProposedEditInput): string | null {
  const { path, find, replace, mode } = edit;

  if (!replace.trim()) return `the edit to ${path} proposes empty replacement text`;

  /**
   * An append carries no anchor by design - `applyDocEdits` puts the text at
   * the end of the file - so the anchor checks would reject every one of them.
   * It is still held to the redaction check below, which is the boundary that
   * matters.
   */
  if (mode === 'replace') {
    if (find.trim().length < MIN_ANCHOR_CHARS) {
      return (
        `the anchor for ${path} is ${find.trim().length} characters; too short to be unique. ` +
        'Use a whole sentence or line taken from the file.'
      );
    }

    const occurrences = countOccurrences(fileText, find);
    if (occurrences === 0) {
      // The exact failure this whole mechanism exists to catch, and the message
      // says what to do about it rather than only that it happened.
      return (
        `the anchor for ${path} does not appear in the file. You rewrote it instead of taking ` +
        `it from the text. Take the substring out of docs[${JSON.stringify(path)}] and pass ` +
        'it through unchanged.'
      );
    }
    if (occurrences > 1) {
      return (
        `the anchor for ${path} appears ${occurrences} times, so an edit would be ambiguous. ` +
        'Extend it with the surrounding line until it is unique.'
      );
    }
    if (find === replace) {
      return `the edit to ${path} changes nothing - find and replace are identical`;
    }
  }

  /**
   * The exfiltration boundary.
   *
   * A proposed edit becomes a pull request, and with egress denied it is the
   * one way anything leaves the sandbox. So what leaves is redacted, and a
   * proposal the redactor changes is refused rather than quietly rewritten:
   * silently publishing `[REDACTED]` where a model put a key is a worse outcome
   * than a role that says it would not.
   */
  const guarded = redactSecrets(`${find}\n${replace}`);
  if (guarded.redacted.length > 0) {
    return (
      `the edit to ${path} contains something that looks like a credential ` +
      `(${guarded.redacted.join(', ')}), and was not kept. Documentation edits must come ` +
      'from the documentation, not from anything else the program could reach.'
    );
  }

  return null;
}

/**
 * The sandbox a program runs in: Daytona in production, local otherwise.
 *
 * Daytona is preferred whenever it is configured, and not only for isolation -
 * it is the one that carries no host filesystem, which turns the security note
 * on this module from a caveat into a sentence. The local sandbox exists so
 * that `docxy run` against a fresh clone works with nothing but a Nebius key,
 * which is a supported path this must not quietly break.
 *
 * Isolation is detected rather than configured because the answer differs by
 * machine, and a run that silently executed model-authored code on the host
 * because bubblewrap was missing would be the worst version of this feature.
 */
export async function createDraftingSandbox(
  config: Config,
): Promise<{ sandbox: DraftingSandbox; where: 'daytona' | 'local' }> {
  if (config.agent.codeModeSandbox === 'daytona') {
    if (!config.sandbox.daytonaApiKey) {
      // An error, not a fallback. Docxy runs as a deployed service, and a
      // missing key silently relocating model-authored code onto the
      // production container is the decision nobody would make on purpose.
      throw new Error(
        'code mode is set to run in a Daytona workspace and DAYTONA_API_KEY is not set. ' +
          'Get a key at https://app.daytona.io, or set DOCXY_CODE_MODE_SANDBOX=local to run ' +
          'the program on this machine instead - which is for development, not for a deployment.',
      );
    }
    const { DaytonaSandbox } = await import('@mastra/daytona');
    const options: ConstructorParameters<typeof DaytonaSandbox>[0] = {
      // Distinct per turn, and ephemeral: a workspace that carried state
      // between commits would let one run's program leave something behind for
      // the next one to find.
      id: `docxy-draft-${Date.now().toString(36)}`,
      apiKey: config.sandbox.daytonaApiKey,
      language: 'typescript',
      ephemeral: true,
      timeout: config.sandbox.execTimeoutMs,
    };
    if (config.sandbox.autoStopMinutes > 0) {
      options.autoStopInterval = config.sandbox.autoStopMinutes;
    }
    // The same default-deny egress the docs build runs under. This is
    // model-authored code over a diff somebody else wrote.
    if (config.sandbox.blockNetwork) options.networkBlockAll = true;
    return { sandbox: new DaytonaSandbox(options), where: 'daytona' };
  }

  const detected = LocalSandbox.detectIsolation();
  if (!detected.available && !config.agent.codeModeForceUnsandboxed) {
    throw new Error(
      'code mode is set to run locally and this machine offers no isolation: ' +
        `${detected.message}. Install bubblewrap, set DOCXY_CODE_MODE_SANDBOX=daytona with a ` +
        'DAYTONA_API_KEY, or set DOCXY_CODE_MODE_FORCE_UNSANDBOXED=true to run model-authored ' +
        'code on this host anyway.',
    );
  }
  return {
    sandbox: new LocalSandbox({
      isolation: detected.available ? detected.backend : 'none',
      // Under the system temp directory, not the repository. The default is a
      // `.sandbox` folder beside the working directory, which put a generated
      // program into the user's checkout - where the linter promptly found it,
      // and where a `git add -A` would have committed it.
      workingDirectory: join(tmpdir(), `docxy-code-mode-${Date.now().toString(36)}`),
      // Denied and verified: the program's only way out is its return value.
      nativeSandbox: { allowNetwork: false },
    }),
    where: 'local',
  };
}

/**
 * What a program is expected to return, parsed rather than trusted.
 *
 * Defaulted field by field because this is a model's output crossing a process
 * boundary as JSON. A program that omitted `mode` used to be a crash; here it
 * is a replace, and `checkProposedEdit` still has the final say.
 */
const programResultSchema = z.object({
  edits: z
    .array(
      z.object({
        path: z.string(),
        section: z.string().default(''),
        find: z.string().default(''),
        replace: z.string(),
        mode: z.enum(['replace', 'append']).default('replace'),
        rationale: z.string().default(''),
      }),
    )
    .default([]),
  skipped: z.array(z.object({ path: z.string(), reason: z.string().default('') })).default([]),
});

/**
 * Wrap the model's program so it can be run and its answer read back.
 *
 * The documentation is injected as a `const` rather than fetched, which is what
 * removes the need for a channel back to the host. The body goes inside an
 * async function so top-level `return` and `await` both work, and the result is
 * printed behind a marker so ordinary `console.log` debugging cannot be
 * mistaken for the answer.
 */
export function buildProgram(code: string, docs: Record<string, string>): string {
  return [
    '// Generated by docxy. The model authored the body of `run`; the rest is harness.',
    `const docs: Record<string, string> = ${JSON.stringify(docs)};`,
    'const run = async () => {',
    code,
    '};',
    'run().then(',
    `  (result) => console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ ok: true, result })),`,
    `  (error) => console.log(${JSON.stringify(RESULT_MARKER)} + JSON.stringify({ ok: false, error: String(error?.message ?? error) })),`,
    ');',
  ].join('\n');
}

/**
 * The frame `buildProgram` prints, parsed rather than trusted.
 *
 * It crosses a process boundary as JSON - written by harness code, yes, but
 * around a value the model's program returned - so it is parsed at that
 * boundary like any other input. `result` stays unvalidated here and is handed
 * to `programResultSchema` next, which is the thing that knows what an edit is.
 */
const programOutcomeSchema = z.object({
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});

export type ProgramOutcome = z.infer<typeof programOutcomeSchema>;

/** The result frame, pulled out of whatever else the program printed. */
export function readProgramOutput(stdout: string): ProgramOutcome {
  const at = stdout.lastIndexOf(RESULT_MARKER);
  if (at === -1) {
    return { ok: false, error: 'the program printed no result - it must end with `return`' };
  }
  try {
    const parsed = programOutcomeSchema.safeParse(
      JSON.parse(stdout.slice(at + RESULT_MARKER.length).trim()),
    );
    if (parsed.success) return parsed.data;
    return { ok: false, error: 'the program returned something that was not a result frame' };
  } catch {
    return { ok: false, error: 'the program result could not be read as JSON' };
  }
}

/** How to write the program, written here rather than generated from tool stubs. */
function programInstructions(paths: string[]): string {
  return [
    '# Writing the program',
    '',
    'You have one tool, `run_program`. It runs a TypeScript program in a sandbox and',
    'reports what happened to every edit that program returned.',
    '',
    'Inside the program you are given:',
    '',
    '```ts',
    'declare const docs: Record<string, string>;',
    '```',
    '',
    '`docs` holds the current text of each impacted file, keyed by path:',
    ...paths.map((path) => `- ${JSON.stringify(path)}`),
    '',
    'End the program by returning:',
    '',
    '```ts',
    'return {',
    '  edits: [{ path, section, find, replace, mode, rationale }],',
    '  skipped: [{ path, reason }],',
    '};',
    '```',
    '',
    '`find` must be a substring you took out of `docs[path]` and passed through',
    'unchanged. Do not type an anchor yourself and do not reformat one - that is the',
    'whole reason this runs as a program. Derive the replacement from the found text',
    'too, so the surrounding markdown survives:',
    '',
    '```ts',
    "const line = docs['docs/cli.md'].split('\\n').find((l) => l.includes('--output json'));",
    "if (!line) return { edits: [], skipped: [{ path: 'docs/cli.md', reason: 'nothing stale' }] };",
    "return { edits: [{ path: 'docs/cli.md', section: 'Configuration', mode: 'replace',",
    "  find: line, replace: line.replace('--output', '--format'), rationale: '…' }], skipped: [] };",
    '```',
    '',
    'Use `mode: "append"` to add a new passage at the end of a file; an append needs no',
    '`find`. Put any impacted file you are deliberately leaving alone into `skipped` -',
    'a proposal whose edits do not apply is rejected whole, so an honest skip is worth',
    'more than a guessed anchor.',
    '',
    'Every edit is checked against the real file on the host. If the tool reports that',
    'an anchor was not found or matched twice, look at `docs[path]` again and run a',
    'corrected program - never resubmit the same anchor.',
    '',
    'To look at a file before deciding, `console.log` it: the program\'s output comes',
    'back to you in `logs`. Do not put file contents into a `skipped` reason to read',
    'them - `skipped` is recorded in the proposal a reviewer sees.',
  ].join('\n');
}

/**
 * Build the tool surface for one Docs Updater turn.
 *
 * Everything is closed over per invocation - the worktree, the files the Impact
 * Mapper flagged, the collector - because none of it is true of the next
 * commit, and a tool that outlived its run would be proposing edits to one
 * commit's files on behalf of another's.
 */
export function createCodeModeSession(options: {
  docsPath: string;
  /** The doc paths the Impact Mapper flagged. Nothing else is shown or editable. */
  allowedPaths: string[];
  sandbox: DraftingSandbox;
  where: 'daytona' | 'local';
  timeoutMs?: number;
}): CodeModeSession {
  const { docsPath, sandbox, where } = options;
  const allowed = [...new Set(options.allowedPaths)];
  const timeout = options.timeoutMs ?? PROGRAM_TIMEOUT_MS;

  const edits: DocEdit[] = [];
  const skipped: DocsProposal['skipped'] = [];
  const events: CodeModeDraft['events'] = [];
  const rejected: string[] = [];

  /** The host's copy of each file, read once and reused to check every anchor. */
  const onHost = new Map<string, string>();
  let started = false;

  const note = (kind: string, text: string): void => {
    events.push({ kind, text });
  };

  const loadDoc = async (path: string): Promise<string | null> => {
    const cached = onHost.get(path);
    if (cached !== undefined) return cached;
    const text = await readRepoFile(docsPath, path);
    if (text === null) return null;
    onHost.set(path, text);
    return text;
  };

  /** The documentation as the program will see it, trimmed to a budget. */
  const materialise = async (): Promise<Record<string, string>> => {
    const docs: Record<string, string> = {};
    let total = 0;
    for (const path of allowed) {
      const text = await loadDoc(path);
      if (text === null) {
        note('tool', `${path} could not be read; it is not in the program's docs`);
        continue;
      }
      // Trimming keeps the head, which is where headings and the sections an
      // impact map names actually live.
      const trimmed = text.length > MAX_DOC_CHARS ? text.slice(0, MAX_DOC_CHARS) : text;
      if (total + trimmed.length > MAX_TOTAL_DOC_CHARS) {
        note('tool', `${path} was left out: the program's docs are at their size budget`);
        continue;
      }
      docs[path] = trimmed;
      total += trimmed.length;
    }
    return docs;
  };

  const runProgram = createTool({
    id: 'run_program',
    description:
      'Run a TypeScript program in a sandbox over the impacted documentation and record the ' +
      'edits it returns. Reports what happened to each one.',
    inputSchema: z.object({
      code: z
        .string()
        .describe('The program body. `docs` is in scope; end with `return { edits, skipped }`.'),
    }),
    outputSchema: z.object({
      ok: z.boolean(),
      accepted: z.number(),
      refused: z.array(z.object({ path: z.string(), error: z.string() })),
      skipped: z.number(),
      error: z.string().optional(),
      logs: z.string().optional(),
    }),
    execute: async ({ code }) => {
      const { executeCommand } = sandbox;
      if (!executeCommand) {
        const why = `the ${where} sandbox cannot run a command, which this needs`;
        rejected.push(why);
        return { ok: false, accepted: 0, refused: [], skipped: 0, error: why };
      }

      if (!started) {
        // Started here rather than up front so a turn the model never uses
        // costs no workspace at all.
        await sandbox.start?.();
        started = true;
        note('sandbox', `${where} sandbox ready`);
      }

      const docs = await materialise();
      const staged = await stageProgram(sandbox, buildProgram(code, docs));
      if (!staged) {
        const why = `the ${where} sandbox exposes no way to stage a file, which this needs`;
        rejected.push(why);
        return { ok: false, accepted: 0, refused: [], skipped: 0, error: why };
      }

      const run = await executeCommand.call(sandbox, 'node', [PROGRAM_FILE], { timeout });
      const logs = `${run.stdout ?? ''}\n${run.stderr ?? ''}`.slice(0, MAX_OUTPUT_CHARS);

      if (run.timedOut) {
        const why = `the program did not finish within ${Math.round(timeout / 1000)}s`;
        rejected.push(why);
        note('tool', why);
        return { ok: false, accepted: 0, refused: [], skipped: 0, error: why, logs };
      }

      const output = readProgramOutput(run.stdout ?? '');
      if (!output.ok) {
        // A program that threw, or printed nothing usable. The error is the
        // model's to act on, so it goes back rather than only into a log.
        const why = output.error ?? 'the program failed';
        rejected.push(why);
        note('tool', `program failed: ${why}`);
        return { ok: false, accepted: 0, refused: [], skipped: 0, error: why, logs };
      }

      const parsed = programResultSchema.safeParse(output.result);
      if (!parsed.success) {
        const why =
          'the program returned the wrong shape; it must be `{ edits: [{ path, section, find, ' +
          'replace, mode, rationale }], skipped: [{ path, reason }] }`';
        rejected.push(why);
        note('tool', why);
        return { ok: false, accepted: 0, refused: [], skipped: 0, error: why, logs };
      }

      const refused: Array<{ path: string; error: string }> = [];
      let accepted = 0;

      for (const edit of parsed.data.edits) {
        if (!allowed.includes(edit.path)) {
          // The scope boundary. An edit to a file the Impact Mapper never
          // flagged is the Coordinator's first reason to reject a proposal, and
          // it is the shape a successful prompt injection would take.
          const why =
            `${edit.path} is not in the impact map; editable files are: ${allowed.join(', ')}`;
          refused.push({ path: edit.path, error: why });
          rejected.push(why);
          continue;
        }

        // Checked against the host's copy, never the program's. The program was
        // handed that text, and a proposal is only worth something if it
        // matches what is actually on disk.
        const text = await loadDoc(edit.path);
        if (text === null) {
          const why = `${edit.path} could not be read on the host, so nothing can be anchored in it`;
          refused.push({ path: edit.path, error: why });
          rejected.push(why);
          continue;
        }

        const problem = checkProposedEdit(text, edit);
        if (problem) {
          refused.push({ path: edit.path, error: problem });
          rejected.push(problem);
          note('tool', `refused an edit to ${edit.path}`);
          continue;
        }

        edits.push(edit);
        accepted += 1;
        note(
          'tool',
          edit.mode === 'append'
            ? `accepted an append to ${edit.path}`
            : `accepted an edit to ${edit.path} (anchor ${edit.find.trim().length} chars)`,
        );
      }

      for (const entry of parsed.data.skipped) {
        // Trimmed because a reason is read by a person. A model that pasted a
        // whole file in here - which one did, using `skipped` to inspect text
        // before the instructions told it not to - should cost the proposal a
        // long line, not a page.
        const reason =
          entry.reason.length > MAX_REASON_CHARS
            ? `${entry.reason.slice(0, MAX_REASON_CHARS)}…`
            : entry.reason;
        skipped.push({ path: entry.path, reason });
        note('tool', `skipped ${entry.path}: ${reason}`);
      }

      return {
        ok: refused.length === 0,
        accepted,
        refused,
        skipped: parsed.data.skipped.length,
        logs,
      };
    },
  });

  return {
    tools: { [runProgram.id]: runProgram },
    instructions: programInstructions(allowed),
    /**
     * A file that ended up edited is not a file that was skipped.
     *
     * The two lists come from different rounds - a first program that decided
     * to skip, a later one that found the stale line after all - and a proposal
     * carrying both for the same path tells the Coordinator and the reviewer
     * two different stories. The edits are the work, so they win.
     */
    draft: () => {
      const edited = new Set(edits.map((edit) => edit.path));
      return {
        proposal: { edits, skipped: skipped.filter((entry) => !edited.has(entry.path)) },
        events,
        rejected,
      };
    },
  };
}

/**
 * Run one Docs Updater turn in Code Mode and return what the program proposed.
 *
 * The proposal comes from the collector, never from the model's final message:
 * every edit in it was checked against the real file when it was offered, which
 * is the property the whole mode exists for. The summary the model answers with
 * is recorded on the trace and used for nothing else.
 */
export async function draftWithCodeMode(
  ctx: RunContext,
  options: {
    docsPath: string;
    impactedPaths: string[];
    prompt: string;
  },
): Promise<{ proposal: DocsProposal; summary?: CodeModeSummary }> {
  const { sandbox, where } = await createDraftingSandbox(ctx.config);
  const session = createCodeModeSession({
    docsPath: options.docsPath,
    allowedPaths: options.impactedPaths,
    sandbox,
    where,
    timeoutMs: ctx.config.sandbox.execTimeoutMs,
  });

  /** Mirror the tool's own events onto the role trace, as `invoke` does for turns. */
  const record = (): void => {
    const trace = ctx.run.traces.find((t) => t.role === DOCS_UPDATER_CODE_MODE.name);
    if (!trace) return;
    for (const event of session.draft().events) {
      const stamped = { at: new Date().toISOString(), ...event };
      trace.events.push(stamped);
      ctx.hooks.onRoleEvent?.(DOCS_UPDATER_CODE_MODE.name, stamped);
    }
  };

  try {
    const summary = await ctx.invoke<CodeModeSummary>(DOCS_UPDATER_CODE_MODE, options.prompt, {
      toolset: { tools: session.tools, instructions: session.instructions, maxSteps: MAX_STEPS },
    });
    record();
    return { proposal: session.draft().proposal, summary };
  } catch (error) {
    // A failed turn is not a lost proposal. Every edit that passed the checks
    // before it died is already collected and already valid, and the drafting
    // step settles rather than rejects - so what was done is kept and the role
    // is reported degraded for the rest.
    record();
    const partial = session.draft().proposal;
    if (partial.edits.length === 0) throw error;
    return { proposal: partial };
  } finally {
    // Best effort, and it matters more here than locally: an ephemeral Daytona
    // workspace is deleted on stop, and one leaked per turn would be billed.
    await sandbox.stop?.().catch(() => {});
  }
}
