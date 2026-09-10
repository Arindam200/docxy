import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { PromptInjectionDetector, RegexFilterProcessor } from '@mastra/core/processors';
import type { InputProcessor } from '@mastra/core/processors';
import { SECRET_RULES } from '../guardrails/secrets.js';
import { pipelineWorkflows } from '../pipeline/workflow.js';
import { Memory } from '@mastra/memory';
import { z } from 'zod';
import type { MemoryConfig } from '@mastra/core/memory';
import type { MastraStorage } from '@mastra/core/storage';
import {
  emptyProjectMemory,
  parseProjectMemory,
  projectMemorySchema,
  serializeProjectMemory,
  type ProjectMemory,
} from '../pipeline/project-memory.js';
import type { Config, RoleName } from '../config.js';
import { mastraModelFor } from '../config.js';
import type { RoleDefinition } from '../agents/roles.js';
import { extractJson } from '../agents/parse.js';
import type { SessionStorage } from '../pipeline/stores.js';
import { databaseConfigured } from '../db/index.js';
import {
  classifyTurnError,
  emptyUsage,
  type AgentRuntime,
  type ResolveSessionOptions,
  type ResolvedSession,
  type RunTurnOptions,
  type TraceEvent,
  type TurnResult,
  type TurnUsage,
} from './types.js';

/**
 * The harness: five agents, in this process, against Nebius through Mastra's
 * model router.
 *
 * The provider enforces each role's schema, so `runTurn` returns a parsed
 * `object` and a turn cannot come back as unparseable prose.
 *
 * A "session" is a Mastra thread. The id carries the spec hash
 * (`hash-repo-role-serial`), so changing a prompt, a model, or a schema yields
 * a different thread by construction rather than by an invalidation step
 * somebody has to remember to run.
 *
 * Rotation and turn counting stay in `SessionStorage`, which knows nothing
 * about threads - it records an id and a count, and that is what makes the
 * no-database path work identically to the Postgres one.
 */
/**
 * The role the injection check runs on.
 *
 * The Change Analyst is the first to see the diff, and a block there stops the
 * run before the Impact Mapper or the Docs Updater are asked anything - so one
 * call protects all three.
 */
const FIRST_READER_OF_THE_DIFF: RoleName = 'change-analyst';

/** What both shapes of turn pass to `generate`, whatever else they add to it. */
interface SharedTurnOptions {
  modelSettings: { temperature: number; maxOutputTokens: number };
  memory?: { thread: string; resource: string };
  abortSignal?: AbortSignal;
}

/**
 * The answer a tool turn produced, or `undefined` when there is not one.
 *
 * Tries the model's own text first - a turn that did write a closing message
 * should be taken at its word - and falls back to the schema's defaults for the
 * common case where the program ran, the tools recorded the work, and the model
 * simply stopped. A schema with no defaults rejects the empty object, so this
 * never manufactures an answer for a role whose output actually matters.
 */
function objectFrom<T>(role: RoleDefinition<T>, text: string): T | undefined {
  if (text.trim()) {
    try {
      return role.schema.parse(extractJson<unknown>(role.title, text));
    } catch {
      // Prose where JSON was expected. The defaults below still apply: the
      // work is in the tool calls either way.
    }
  }
  const empty = role.schema.safeParse({});
  return empty.success ? empty.data : undefined;
}

export class MastraRuntime implements AgentRuntime {
  readonly name = 'mastra' as const;

  private readonly agents = new Map<RoleName, Agent>();
  private store: MastraStorage | null = null;
  private instance: Mastra | null = null;
  private memory: Memory | null = null;
  private closed = false;

  constructor(
    private readonly config: Config,
    private readonly sessions: SessionStorage,
  ) {}

  /**
   * Postgres when `DATABASE_URL` is set, a LibSQL file under the state
   * directory otherwise.
   *
   * The second is not a degraded mode. `docxy run` against a fresh clone with
   * no infrastructure is a supported path - it is what the demo uses - and
   * Mastra falls back to a volatile in-memory store when given nothing, which
   * would silently drop every role's memory between commits.
   *
   * Imported lazily so a run with no database never loads the Postgres driver,
   * and vice versa.
   */
  /**
   * The Mastra instance the workflow runs on.
   *
   * Built lazily and once, because it owns the storage handle the workflow
   * snapshots into - the same store the agents' threads live in, so a run's
   * memory and its progress are durable together or not at all.
   */
  async mastra(): Promise<Mastra> {
    if (this.instance) return this.instance;
    this.instance = new Mastra({
      storage: await this.storage(),
      workflows: pipelineWorkflows(),
      // The agents are constructed per role on first use and reach the model
      // router directly; registering them here as well would only give Mastra a
      // second, divergent copy of each.
      logger: false,
    });
    return this.instance;
  }

  async storage(): Promise<MastraStorage> {
    if (this.store) return this.store;

    if (databaseConfigured()) {
      const { PostgresStore } = await import('@mastra/pg');
      this.store = new PostgresStore({
        id: 'docxy',
        // SAFETY: `databaseConfigured()` is exactly the check that this is set.
        connectionString: process.env.DATABASE_URL as string,
      });
    } else {
      const { LibSQLStore } = await import('@mastra/libsql');
      this.store = new LibSQLStore({
        id: 'docxy',
        url: `file:${join(this.config.stateDir, 'mastra.db')}`,
      });
    }

    await this.store.init();
    return this.store;
  }

  /**
   * What a role is allowed to be sent, and what it is allowed to be told.
   *
   * A commit diff is not trusted input. It is written by whoever opened the
   * pull request, it can carry a committed key straight to a model provider,
   * and it can carry a sentence addressed to the agent that reads it - an
   * instruction to add a link, to describe a change that did not happen, to
   * quote something into a file. Docxy then writes that up and opens a pull
   * request under a bot account, which is exactly the outcome worth spending a
   * little to avoid.
   *
   * The two guards sit in different places for a reason. Redaction is a regex
   * and costs nothing, so every role gets it and no future prompt can forget
   * it. Injection detection is a model call, so it goes on the first role that
   * reads the diff and nowhere else: blocking there ends the run before any
   * other role is asked anything.
   */
  private processorsFor(role: RoleDefinition): InputProcessor[] {
    const processors: InputProcessor[] = [];

    if (this.config.guardrails.redactSecrets) {
      processors.push(
        new RegexFilterProcessor({
          // Mastra's own `secrets` preset is three patterns and let a Stripe
          // key and a GitHub token through in a probe; `SECRET_RULES` is the
          // set that matters for a commit diff. The preset is kept alongside
          // it because its `Bearer` and `api_key =` rules are worth having.
          presets: ['secrets'],
          rules: SECRET_RULES,
          // Redact rather than block. A diff that touches a line which merely
          // looks like a key is ordinary work, and refusing to document it
          // would make the guard the thing that breaks the pipeline.
          strategy: 'redact',
          phase: 'input',
        }),
      );
    }

    if (this.config.guardrails.detectPromptInjection && role.name === FIRST_READER_OF_THE_DIFF) {
      processors.push(
        new PromptInjectionDetector({
          model: this.config.guardrails.injectionModel,
          threshold: this.config.guardrails.injectionThreshold,
          // Blocked, not rewritten. A rewrite would hand the next role a diff
          // that no longer matches the commit, and every anchor it quoted would
          // be from text that was never in the repository.
          strategy: 'block',
        }),
      );
    }

    return processors;
  }

  private async agentFor(role: RoleDefinition): Promise<Agent> {
    const existing = this.agents.get(role.name);
    if (existing) return existing;

    const memory = await this.memoryHandle();

    const base = {
      id: `docxy-${role.name}`,
      name: role.title,
      instructions: role.instructions(this.config),
      model: mastraModelFor(this.config, role.name),
      inputProcessors: this.processorsFor(role),
    };
    // A role that must quote the prompt back verbatim is given no thread; see
    // `RoleDefinition.carriesMemory`.
    const agent = role.carriesMemory ? new Agent({ ...base, memory }) : new Agent(base);

    this.agents.set(role.name, agent);
    return agent;
  }

  async assertReady(): Promise<void> {
    if (!this.config.nebius.apiKey) {
      throw new Error(
        'NEBIUS_API_KEY is not set. Get a key at https://tokenfactory.nebius.com and put it in .env',
      );
    }
    // The model router reads the key from the environment by provider id, so a
    // key that only ever reached `Config` would not be found.
    process.env.NEBIUS_API_KEY = this.config.nebius.apiKey;
    await this.storage();
  }

  modelFor(role: RoleDefinition): string {
    return mastraModelFor(this.config, role.name);
  }

  /**
   * Identify the agent configuration a thread was built from.
   *
   * The schema is fingerprinted alongside the prompt and the model because it
   * is now part of the contract the model answers under: widening an enum
   * changes what a valid answer is, and a thread carrying a dozen commits'
   * worth of answers in the old shape is not the place to ask under the new one.
   */
  private specHash(role: RoleDefinition): string {
    const spec = {
      instructions: role.instructions(this.config),
      model: mastraModelFor(this.config, role.name),
      params: role.params,
      schema: z.toJSONSchema(role.schema),
    };
    return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
  }

  private repoKey(): string {
    return createHash('sha256').update(this.config.repoPath).digest('hex').slice(0, 16);
  }

  /**
   * How project memory is stored, passed per call rather than set on `Memory`.
   *
   * Two properties matter here and both are deliberate.
   *
   * `scope: 'resource'` makes the repository the thing remembered. The resource
   * is already `repoKey()` - the same id every role's thread is filed under -
   * so one record spans all five roles, every thread they rotate through, and
   * every commit. Nothing new has to be keyed, and two repositories cannot read
   * each other's memory.
   *
   * `agentManaged: false` is what keeps the model out of it. Mastra registers
   * an `updateWorkingMemory` tool only when this is not false, so with it off no
   * role is handed the tool and no role can write a word of this. The record is
   * written by `saveProjectMemory` from counters a finished run already
   * recorded, and reaches a role only as prompt text the trace shows verbatim.
   * Model-written memory reaching a role that must quote exactly is the bug
   * this repository already paid for once; see `RoleDefinition.carriesMemory`.
   *
   * Because it is passed here and never to `agent.generate`, an ordinary turn
   * neither loads nor stores it.
   */
  private projectMemoryConfig(): MemoryConfig {
    return {
      workingMemory: {
        enabled: true,
        scope: 'resource',
        schema: projectMemorySchema,
        agentManaged: false,
      },
    };
  }

  private async memoryHandle(): Promise<Memory> {
    if (!this.memory) {
      this.memory = new Memory({ storage: await this.storage() });
    }
    return this.memory;
  }

  /**
   * The thread id the working-memory calls take.
   *
   * Resource-scoped reads and writes never touch a thread - Mastra goes
   * straight to the resource row - but the parameter is required, so this names
   * what it is instead of passing something that looks like a real thread.
   */
  private projectMemoryThread(): string {
    return `project-memory-${this.repoKey()}`;
  }

  async loadProjectMemory(): Promise<ProjectMemory> {
    try {
      const memory = await this.memoryHandle();
      const raw = await memory.getWorkingMemory({
        threadId: this.projectMemoryThread(),
        resourceId: this.repoKey(),
        memoryConfig: this.projectMemoryConfig(),
      });
      return parseProjectMemory(raw);
    } catch {
      // Recall is an optimisation. A store that cannot answer costs this run
      // its hints, and nothing else.
      return emptyProjectMemory();
    }
  }

  /**
   * Throws on a storage fault, deliberately.
   *
   * Reading is different - a memory that cannot be recalled costs the run its
   * hints and nothing else, so `loadProjectMemory` reports empty. A write that
   * failed is a fact about the store, and the two callers want opposite things
   * from it: the pipeline swallows it, because a counter is not worth
   * discarding a finished proposal over, and `docxy reset --memory` must not
   * print that it cleared something it did not.
   */
  async saveProjectMemory(memory: ProjectMemory): Promise<void> {
    const handle = await this.memoryHandle();
    await handle.updateWorkingMemory({
      threadId: this.projectMemoryThread(),
      resourceId: this.repoKey(),
      workingMemory: serializeProjectMemory(memory),
      memoryConfig: this.projectMemoryConfig(),
    });
  }

  async resolveSession(
    role: RoleDefinition,
    options: ResolveSessionOptions = {},
  ): Promise<ResolvedSession> {
    const hash = this.specHash(role);

    // A role that carries no thread has nothing to resolve and nothing to
    // rotate. It gets a fresh id so its trace reads honestly - every run is a
    // new conversation, because that is what it is.
    if (!role.carriesMemory) {
      return {
        id: `${hash}-${this.repoKey()}-${role.name}-${randomUUID().slice(0, 8)}`,
        reused: false,
        priorTurns: 0,
      };
    }

    const existing = await this.sessions.get(role.name, hash);
    const limit = this.config.agent.sessionMaxTurns;

    // Rotation is preventive, not reactive. A thread that has carried a dozen
    // commits is one commit away from breaching its budget, and the cost of a
    // cold thread is one uncached turn - far less than a failed run.
    const overLimit = Boolean(existing && limit > 0 && existing.turns >= limit);
    const rotatedBecause = options.fresh ? 'requested' : overLimit ? 'turn-limit' : undefined;

    if (existing && !rotatedBecause) {
      return { id: existing.sessionId, reused: true, priorTurns: existing.turns };
    }

    // Mastra creates a thread on first use, so there is nothing to call here.
    //
    // The spec hash leads because traces abbreviate an id to its first eight
    // characters, and the repository key is identical for every role - so
    // leading with it printed the same "session" for all five, which reads as a
    // bug and hides the one thing the line exists to tell you. The hash differs
    // per role (each has its own instructions and schema), so it distinguishes
    // them on sight.
    //
    // The repository key still has to be in the id: Mastra's threads are global
    // to a store, and two repositories running the same role at the same spec
    // would otherwise share one thread and read each other's memory.
    //
    // The suffix is random rather than a timestamp. A timestamp collides when a
    // thread is retired twice inside one millisecond - which the retry path
    // does, since a `max-tokens` failure rotates immediately - and a colliding
    // id hands back the very thread being retired, with all of the history
    // rotation exists to shed. It reads as a new session and behaves as the old
    // one, which is the worst of both.
    const threadId = `${hash}-${this.repoKey()}-${role.name}-${randomUUID().slice(0, 8)}`;
    await this.sessions.set(role.name, threadId, hash);

    const resolved: ResolvedSession = { id: threadId, reused: false, priorTurns: 0 };
    if (rotatedBecause) resolved.rotatedBecause = rotatedBecause;
    return resolved;
  }

  async runTurn<T>(
    role: RoleDefinition<T>,
    sessionId: string,
    prompt: string,
    options: RunTurnOptions = {},
  ): Promise<TurnResult<T>> {
    const agent = await this.agentFor(role);
    const events: TraceEvent[] = [];

    const emit = (kind: string, text: string): void => {
      const event: TraceEvent = { at: new Date().toISOString(), kind, text };
      events.push(event);
      options.onEvent?.(event);
    };

    try {
      /**
       * A turn with tools does not ask for structured output at all.
       *
       * The provider's `response_format` and the tool loop are mutually
       * exclusive, and the failure is silent and confident rather than loud. A
       * probe against this exact setup answered a question about a document it
       * had never read, inventing the contents *and* reporting that it had
       * called the tool; the live Docs Updater did the same on its first
       * code-mode run - eighty-four output tokens, no program, and a summary
       * claiming all three files were already correct.
       *
       * Asking for the JSON in the prompt instead (`jsonPromptInjection`)
       * restores the tool loop, but then the *validation* becomes the failure:
       * a model that has run its program and made its tool calls very often
       * stops without a closing message, and the turn was rejected three times
       * over an empty string while its actual work sat complete in the
       * collector.
       *
       * So a tool turn's output is its tool calls, and the closing message is
       * optional. `objectFrom` below is what makes that true.
       */
      const modelSettings = {
        temperature: role.params.temperature,
        maxOutputTokens: role.params.maxTokens,
      };
      // One thread per role per repository; the resource is the repository, so
      // a role's memory is scoped to the codebase it learned it from. A role
      // that carries none is asked in isolation, every time.
      const memory = role.carriesMemory
        ? { thread: sessionId, resource: this.repoKey() }
        : undefined;

      /**
       * Two call sites rather than one options object, because the two turns
       * are genuinely different calls.
       *
       * Mastra's `generate` overloads make `structuredOutput` part of the
       * signature - present or absent selects a different return type - so a
       * union of the two option shapes matches neither. Branching at the call
       * is what keeps both typed without an assertion.
       *
       * `toolsets` is the call-time tool channel, so the agent cached for this
       * role is untouched; that matters, because these tools close over one
       * commit's worktree and must not outlive it. The instructions are
       * appended to the role's own rather than replacing them, so persona and
       * house style still apply. `maxSteps` is what makes the turn agentic:
       * without it the model gets one round, which is enough to run a program
       * and not enough to be told an anchor missed and try again - the round
       * trip that is most of the point.
       */
      const shared: SharedTurnOptions = { modelSettings };
      if (memory) shared.memory = memory;
      if (options.signal) shared.abortSignal = options.signal;

      const result = options.toolset
        ? await agent.generate(prompt, {
            ...shared,
            toolsets: { docxy: options.toolset.tools },
            maxSteps: options.toolset.maxSteps,
            instructions: `${role.instructions(this.config)}\n\n${options.toolset.instructions}`,
          })
        : await agent.generate(prompt, {
            ...shared,
            structuredOutput: { schema: role.schema },
          });

      const usage = readUsage(result.usage);
      const truncated = result.finishReason === 'length';

      // A guardrail refused the input, so no model was ever asked. Reported
      // before the ordinary error paths because it is not a fault to retry
      // around - it is a decision, and the run should stop on it.
      if (result.tripwire) {
        const why = result.tripwire.reason || 'a guardrail refused the input';
        emit('blocked', `${result.tripwire.processorId ?? 'a guardrail'}: ${why}`);
        return {
          text: '',
          events,
          subthreads: [],
          status: 'blocked',
          usage,
          error:
            `${why}. The commit diff is written by whoever opened the pull request, ` +
            'and this one was refused before it reached a model.',
          errorKind: 'blocked',
          truncated: false,
        };
      }

      for (const call of result.toolCalls ?? []) {
        const name = call?.payload?.toolName;
        if (name) emit('tool', `called ${name}`);
      }

      const turn: TurnResult<T> = {
        text: result.text ?? '',
        events,
        subthreads: [],
        status: result.finishReason ?? 'unknown',
        usage,
        truncated,
      };

      // Errors are reported rather than thrown: the partial trace is the
      // evidence a failed run is debugged from, and throwing discards it.
      if (result.error) {
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        turn.error = message;
        turn.errorKind = classifyTurnError(message);
        emit('error', message);
        return turn;
      }

      if (truncated) {
        turn.error = 'the model stopped at its output budget (finish reason: length)';
        turn.errorKind = 'max-tokens';
        emit('error', 'the model stopped at its output budget');
        return turn;
      }

      if (result.object === undefined) {
        /**
         * A tool turn answers in its tool calls, so no closing message is a
         * finished turn. The text is parsed when there is any, and an empty one
         * falls back to the schema's own defaults - which is why every field of
         * `codeModeSummarySchema` has one. A schema without defaults still
         * fails here, so this cannot quietly invent an answer for a role that
         * needs a real one.
         */
        if (options.toolset) {
          const answered = objectFrom(role, result.text ?? '');
          if (answered !== undefined) {
            turn.object = answered;
            emit(
              'result',
              `finished after its tool calls ` +
                `(${usage.inputTokens} in / ${usage.outputTokens} out tokens)`,
            );
            return turn;
          }
        }
        // The provider enforces the schema, so this is not a model that wrote
        // prose - it is a turn that produced nothing at all.
        turn.error = 'the model returned no structured output';
        turn.errorKind = 'harness';
        emit('error', turn.error);
        return turn;
      }

      // SAFETY: the provider validated this against `role.schema`, and
      // `schemas.ts` asserts at compile time that each schema's inferred type
      // is exactly the `T` the role is declared with.
      turn.object = result.object as T;
      emit(
        'result',
        `produced a valid ${role.title} object ` +
          `(${usage.inputTokens} in / ${usage.outputTokens} out tokens)`,
      );
      return turn;
    } catch (err) {
      // An abort is the caller's decision and is theirs to interpret; every
      // other failure becomes a reported error carrying whatever was collected.
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      emit('error', `the turn failed: ${message}`);
      return {
        text: '',
        events,
        subthreads: [],
        status: 'error',
        usage: emptyUsage(),
        error: message,
        errorKind: classifyTurnError(message),
        truncated: false,
      };
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // SAFETY: `close` is optional on the storage interface - a LibSQL file has
    // nothing to release - so it is probed rather than assumed.
    const store = this.store as { close?: () => Promise<void> } | null;
    await store?.close?.().catch(() => {});
  }
}

/**
 * Mastra's usage payload, parsed rather than trusted.
 *
 * It crosses an SDK boundary and its shape has already moved once between
 * minor versions, so it is read the same way any other external payload is:
 * through a schema, with every field optional and a catch-all that yields the
 * empty result instead of throwing. A run must not fail because its token
 * counts arrived in an unexpected shape.
 */
const usageSchema = z
  .object({
    inputTokens: z.number().finite().optional(),
    outputTokens: z.number().finite().optional(),
    cachedInputTokens: z.number().finite().optional(),
    raw: z
      .object({
        inputTokens: z
          .object({
            noCache: z.number().finite().optional(),
            cacheRead: z.number().finite().optional(),
          })
          .partial()
          .optional(),
      })
      .partial()
      .optional(),
  })
  .partial();

/**
 * What this side is willing to read off a usage payload.
 *
 * Named so the reader takes a domain type rather than `unknown`, and still
 * `safeParse`d inside: the SDK's own type says these are numbers, and a wire
 * payload is entitled to disagree. `raw` stays `unknown` because that is how
 * Mastra types it - it is the provider's own shape, and the schema is what
 * gives it one.
 */
interface MastraUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  raw?: unknown;
}

/**
 * Fold Mastra's usage into the shape both runtimes report.
 *
 * The breakdown categories are Mastra's own - `noCache` and `cacheRead` - and
 * are passed through under those names. A run's trace should say what was
 * actually measured rather than what a tidier vocabulary would have called it.
 */
export function readUsage(usage: MastraUsage): TurnUsage {
  const totals = emptyUsage();
  const parsed = usageSchema.safeParse(usage);
  if (!parsed.success) return totals;

  totals.inputTokens = parsed.data.inputTokens ?? 0;
  totals.outputTokens = parsed.data.outputTokens ?? 0;
  totals.cacheReadTokens = parsed.data.cachedInputTokens ?? 0;
  // Mastra reports no cache-write count. Left at zero rather than guessed:
  // a rate applied to an invented number would price runs wrongly.

  const breakdown = parsed.data.raw?.inputTokens;
  if (breakdown) {
    totals.inputBreakdown = {
      noCache: breakdown.noCache ?? 0,
      cacheRead: breakdown.cacheRead ?? 0,
    };
  }
  return totals;
}
